export const sharedTransportProtocol = "codex-ipc-budget-v1";
export const sharedTransportClients = 2;

const KiB = 1024;
const MiB = 1024 * KiB;
const dataBudget = { server: 448 * KiB, browser: 64 * KiB };
const priorityBudget = 8 * KiB;
const fragmentBytes = 48 * KiB;
const headerBytes = 5;
const messageLimit = 16 * MiB;
const queueLimit = 128;
const priorityMessageLimit = 512;
const receiptBudget = 256;
const deadlineMs = 15_000;
const atomicStreamBytes = 80 * KiB;
const sourceChunkLimit = MiB;
const sourceStagingLimit = 2 * MiB;

export const sharedTransportFrameLimit = fragmentBytes + headerBytes;
export const sharedTransportWireLimit = charge(sharedTransportFrameLimit);

enum Frame {
  Start = 1,
  Continue,
  Priority,
  Receipt,
  Heartbeat,
}

type Side = keyof typeof dataBudget;

type Endpoint = {
  bufferedAmount: () => number;
  send: (frame: Uint8Array) => void;
  deliver: (message: unknown, bytes: number) => void;
  fail: (error: Error) => void;
  change?: (sample: TransportSample) => void;
};

type Message = { bytes: Uint8Array; offset: number; deadline: number };
type Ticket = { bytes: number; priority: boolean; deadline: number };
type Writer = {
  cost: number;
  rawBytes: number;
  backing: ArrayBufferLike;
  deadline: number;
  run: () => void;
  reject: (reason: unknown) => void;
};

export type TransportSample = {
  data: number;
  priority: number;
  queued: number;
  assembly: number;
  bufferedAmount: number;
  sent: number;
  received: number;
  waitingWriters: number;
  writerBytes: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// Fixed-block deflate expansion, sync flush, and the largest masked header.
function charge(bytes: number): number {
  return (
    bytes +
    Math.ceil(bytes / 8) +
    Math.ceil(bytes / 256) +
    Math.ceil(bytes / 512) +
    64 +
    14
  );
}

// A void resolution carries no exports and affects an import already created
// by the peer. A value, error, release, or terminal operation can have ordering
// dependencies and stays in the ordinary FIFO even when it is small.
function isPriority(message: unknown): boolean {
  const envelope = message as {
    type?: unknown;
    portId?: unknown;
    data?: unknown;
  };
  if (
    envelope?.type !== "message-port-message" ||
    typeof envelope.portId !== "string"
  )
    return false;
  const data = envelope.data;
  return (
    Array.isArray(data) &&
    data.length === 3 &&
    data[0] === "resolve" &&
    Number.isSafeInteger(data[1]) &&
    Array.isArray(data[2]) &&
    data[2].length === 1 &&
    data[2][0] === "undefined"
  );
}

export class SharedWebSocketTransport {
  private readonly ordinary: Message[] = [];
  private readonly urgent: Message[] = [];
  private readonly tickets = new Map<number, Ticket>();
  private readonly writers = new Set<Writer>();
  private readonly sourceChunks = new Map<ArrayBufferLike, number>();
  private readonly budget: number;
  private readonly peerBudget: number;
  private readonly clock: ReturnType<typeof setInterval>;
  private assembly?: Message;
  private queued = 0;
  private urgentQueued = 0;
  private sourceBytes = 0;
  private data = 0;
  private priority = 0;
  private sent = 0;
  private acked = 0;
  private received = 0;
  private reported = 0;
  private unreportedData = 0;
  private unreportedPriority = 0;
  private receiptWrites = 0;
  private lastSentAt = 0;
  private closed = false;
  private open = false;
  private pumping = false;

  constructor(
    side: Side,
    private readonly endpoint: Endpoint,
    private readonly timeoutMs = deadlineMs,
  ) {
    this.budget = dataBudget[side];
    this.peerBudget = dataBudget[side === "server" ? "browser" : "server"];
    this.clock = setInterval(() => this.pump(), 20);
  }

  start(): void {
    this.open = true;
    this.lastSentAt = performance.now();
    this.pump();
  }

  // Synchronous IPC producers use a bounded, separately metered staging FIFO.
  // No fragment enters WebSocket until it owns a ticket. Overflow fails the
  // connection visibly because the synchronous IPC API cannot await a slot.
  private sendJson(json: string, priority: boolean): boolean {
    if (this.closed) return false;
    try {
      if (typeof json !== "string" || json.length > messageLimit)
        throw Error("IPC message exceeds staging limit");
      const bytes = encoder.encode(json);
      const queue = priority ? this.urgent : this.ordinary;
      if (
        bytes.length === 0 ||
        queue.length >= queueLimit ||
        (priority
          ? bytes.length > priorityMessageLimit ||
            this.urgentQueued + charge(bytes.length + headerBytes) >
              priorityBudget
          : this.queued + bytes.length > messageLimit)
      )
        throw Error("IPC staging capacity exhausted");
      const message = {
        bytes,
        offset: 0,
        deadline: performance.now() + this.timeoutMs,
      };
      if (priority) this.urgentQueued += charge(bytes.length + headerBytes);
      else this.queued += bytes.length;
      queue.push(message);
      this.sample();
      this.pump();
      return !this.closed;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  send(message: unknown): boolean {
    if (this.closed) return false;
    try {
      let minimum = 0;
      const json = JSON.stringify(
        message,
        function (this: unknown, key, value) {
          minimum += typeof value === "string" ? value.length : 1;
          if (!Array.isArray(this)) minimum += key.length;
          if (minimum > messageLimit)
            throw Error("IPC message exceeds staging limit");
          return value;
        },
      );
      return this.sendJson(json, isPriority(message));
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  beforeStreamWrite(
    value: unknown,
    signal: AbortSignal,
    send: () => unknown,
  ): Promise<unknown> {
    if (this.closed || signal.aborted)
      return Promise.reject(signal.reason ?? Error("IPC transport is closed"));
    if (!(value instanceof Uint8Array))
      return Promise.resolve().then(() => {
        if (signal.aborted || this.closed)
          throw signal.reason ?? Error("IPC transport is closed");
        return send();
      });
    if (value.byteLength > atomicStreamBytes || this.writers.size >= 4) {
      const error = Error("RPC source exceeds isolated atomic writer capacity");
      this.fail(error);
      return Promise.reject(error);
    }
    // Bound the pinned RPC byte envelope before the writer creates base64 and
    // assigns an operation ID. Fragments acquire exact tickets at sendNext().
    const encoded = 4 * Math.ceil(value.length / 3) + 512;
    const tail = encoded % fragmentBytes;
    const cost =
      Math.floor(encoded / fragmentBytes) * charge(sharedTransportFrameLimit) +
      (tail ? charge(tail + headerBytes) : 0);
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        this.writers.delete(writer);
      };
      const abort = () => {
        writer.reject(signal.reason);
        this.pump();
      };
      const writer: Writer = {
        cost,
        rawBytes: value.byteLength,
        backing: value.buffer,
        deadline: performance.now() + this.timeoutMs,
        run: () => {
          finish();
          try {
            resolve(send());
          } catch (error) {
            reject(error);
          }
        },
        reject: (reason) => {
          finish();
          reject(reason);
        },
      };
      this.writers.add(writer);
      signal.addEventListener("abort", abort, { once: true });
      this.sample();
      this.pump();
    });
  }

  async splitStreamWrite(
    value: unknown,
    write: (part: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    if (!(value instanceof Uint8Array) || value.byteLength <= atomicStreamBytes)
      return write(value);
    const bytes = value.buffer.byteLength;
    if (
      this.closed ||
      bytes > sourceChunkLimit ||
      this.sourceChunks.has(value.buffer) ||
      this.sourceBytes + bytes > sourceStagingLimit
    ) {
      const error = Error("RPC source exceeds isolated rechunking capacity");
      this.fail(error);
      throw error;
    }
    this.sourceChunks.set(value.buffer, bytes);
    this.sourceBytes += bytes;
    this.sample();
    try {
      for (
        let offset = 0;
        offset < value.byteLength;
        offset += atomicStreamBytes
      )
        await write(value.subarray(offset, offset + atomicStreamBytes));
    } finally {
      if (this.sourceChunks.delete(value.buffer)) this.sourceBytes -= bytes;
      this.sample();
    }
  }

  receive(frame: Uint8Array): void {
    if (this.closed) return;
    try {
      if (
        frame.length < headerBytes ||
        frame.length > sharedTransportFrameLimit
      )
        throw Error("Invalid IPC transport frame");
      const field = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength,
      ).getUint32(1);
      const body = frame.subarray(headerBytes);
      if (frame[0] === Frame.Receipt) {
        if (body.length !== 0 || field <= this.acked || field > this.sent)
          throw Error("Invalid IPC transport receipt");
        while (this.acked < field) {
          const sequence = ++this.acked;
          const ticket = this.tickets.get(sequence)!;
          this.tickets.delete(sequence);
          if (ticket.priority) this.priority -= ticket.bytes;
          else this.data -= ticket.bytes;
        }
      } else {
        if (this.received === 0xffffffff)
          throw Error("Invalid IPC transport payload");
        const cost = charge(frame.length);
        if (frame[0] === Frame.Priority || frame[0] === Frame.Heartbeat) {
          this.unreportedPriority += cost;
          if (
            field !== 0 ||
            (frame[0] === Frame.Heartbeat
              ? body.length !== 0
              : body.length === 0 || body.length > priorityMessageLimit) ||
            this.unreportedPriority > priorityBudget
          )
            throw Error("Invalid IPC priority frame");
          if (frame[0] === Frame.Priority) this.deliver(body, true);
        } else {
          if (body.length === 0) throw Error("Empty IPC transport payload");
          this.unreportedData += cost;
          if (this.unreportedData > this.peerBudget)
            throw Error("IPC peer exceeded receive budget");
          this.receiveData(frame[0]!, field, body);
        }
        if (this.closed) return;
        this.received++;
      }
      this.sample();
      this.pump();
    } catch (error) {
      this.fail(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.clock);
    this.ordinary.length = this.urgent.length = 0;
    this.tickets.clear();
    for (const writer of this.writers)
      writer.reject(Error("IPC transport is closed"));
    this.assembly = undefined;
    this.sourceChunks.clear();
    this.sourceBytes = 0;
    this.queued = this.urgentQueued = this.data = this.priority = 0;
    this.sample();
  }

  fail(reason: unknown): void {
    if (this.closed) return;
    this.close();
    this.endpoint.fail(
      reason instanceof Error ? reason : Error(String(reason)),
    );
  }

  private deliver(bytes: Uint8Array, priority = false): void {
    const message: unknown = JSON.parse(decoder.decode(bytes));
    if (priority && !isPriority(message))
      throw Error("IPC priority frame is not a void RPC resolution");
    this.endpoint.deliver(message, bytes.length);
  }

  private receiveData(kind: number, field: number, body: Uint8Array): void {
    if (kind === Frame.Start) {
      if (this.assembly || field < body.length || field > messageLimit)
        throw Error("Invalid IPC message start");
      if (field === body.length) {
        this.deliver(body);
        return;
      }
      this.assembly = {
        bytes: new Uint8Array(field),
        offset: 0,
        deadline: performance.now() + this.timeoutMs,
      };
    } else if (kind !== Frame.Continue || field !== 0) {
      throw Error("Invalid IPC message continuation");
    }
    const message = this.assembly;
    if (!message || message.offset + body.length > message.bytes.length)
      throw Error("Invalid IPC reassembly length");
    message.bytes.set(body, message.offset);
    message.offset += body.length;
    message.deadline = performance.now() + this.timeoutMs;
    if (message.offset === message.bytes.length) {
      this.assembly = undefined;
      this.deliver(message.bytes);
    }
  }

  private write(kind: Frame, field: number, bytes?: Uint8Array): void {
    const frame = new Uint8Array(headerBytes + (bytes?.length ?? 0));
    frame[0] = kind;
    new DataView(frame.buffer).setUint32(1, field);
    if (bytes) frame.set(bytes, headerBytes);
    if (kind !== Frame.Receipt) this.lastSentAt = performance.now();
    this.endpoint.send(frame);
  }

  private pump(): void {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      const now = performance.now();
      const oldest = this.tickets.values().next().value as Ticket | undefined;
      if (
        (oldest && oldest.deadline <= now) ||
        (this.ordinary[0]?.deadline ?? Infinity) <= now ||
        (this.urgent[0]?.deadline ?? Infinity) <= now ||
        (this.writers.values().next().value?.deadline ?? Infinity) <= now ||
        (this.assembly?.deadline ?? Infinity) <= now
      )
        throw Error("IPC transport progress deadline exceeded");

      if (!this.open) return;
      // Receipts never wait on peer credit. Coalesce when our local sender is
      // congested, with separate headroom above the data and priority ceiling.
      if (this.endpoint.bufferedAmount() === 0) this.receiptWrites = 0;
      if (
        this.reported < this.received &&
        this.receiptWrites + charge(headerBytes) <= receiptBudget &&
        charge(this.endpoint.bufferedAmount()) + charge(headerBytes) <=
          this.budget + priorityBudget + receiptBudget
      ) {
        this.reported = this.received;
        this.unreportedData = this.unreportedPriority = 0;
        this.receiptWrites += charge(headerBytes);
        this.write(Frame.Receipt, this.reported);
      }
      while (
        !this.closed &&
        (this.sendNext(true) || this.sendNext(false) || this.runWriter())
      ) {
        this.sample();
      }
      // HTTP upgrades occupy a slot even while idle. Use the priority ledger
      // to detect a half-open peer that would otherwise keep its slot forever.
      const heartbeat = charge(headerBytes);
      if (
        !this.closed &&
        this.tickets.size === 0 &&
        this.endpoint.bufferedAmount() === 0 &&
        now - this.lastSentAt >= this.timeoutMs / 2
      ) {
        this.ticket(heartbeat, true);
        this.write(Frame.Heartbeat, 0);
        this.sample();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.pumping = false;
    }
  }

  private runWriter(): boolean {
    const writer = this.writers.values().next().value;
    if (
      !writer ||
      this.ordinary.length ||
      this.data + writer.cost > this.budget ||
      charge(this.endpoint.bufferedAmount()) + writer.cost > this.budget
    )
      return false;
    writer.run();
    return true;
  }

  private sendNext(priority: boolean): boolean {
    const queue = priority ? this.urgent : this.ordinary;
    const message = queue[0];
    if (!message) return false;
    const next = Math.min(message.offset + fragmentBytes, message.bytes.length);
    const cost = charge(next - message.offset + headerBytes);
    if (
      (priority
        ? this.priority + cost > priorityBudget
        : this.data + cost > this.budget) ||
      charge(this.endpoint.bufferedAmount()) + cost >
        this.budget + (priority ? priorityBudget : 0)
    )
      return false;
    this.ticket(cost, priority);

    const start = message.offset === 0;
    const body = message.bytes.subarray(message.offset, next);
    message.offset = next;
    if (next === message.bytes.length) {
      queue.shift();
      if (priority) this.urgentQueued -= cost;
      else this.queued -= next;
    } else {
      message.deadline = performance.now() + this.timeoutMs;
    }
    this.write(
      priority ? Frame.Priority : start ? Frame.Start : Frame.Continue,
      !priority && start ? message.bytes.length : 0,
      body,
    );
    return true;
  }

  private ticket(bytes: number, priority: boolean): void {
    if (this.sent === 0xffffffff) throw Error("IPC sequence exhausted");
    this.tickets.set(++this.sent, {
      bytes,
      priority,
      deadline: performance.now() + this.timeoutMs,
    });
    if (priority) this.priority += bytes;
    else this.data += bytes;
  }

  private sample(): void {
    this.endpoint.change?.({
      data: this.data,
      priority: this.priority,
      queued: this.queued,
      assembly: this.assembly?.bytes.length ?? 0,
      bufferedAmount: this.endpoint.bufferedAmount(),
      sent: this.sent,
      received: this.received,
      waitingWriters: this.writers.size,
      writerBytes: [...this.writers].reduce(
        (total, writer) =>
          this.sourceChunks.has(writer.backing)
            ? total
            : total + writer.rawBytes,
        this.sourceBytes,
      ),
    });
  }
}
