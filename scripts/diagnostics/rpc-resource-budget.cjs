// Independent experiment watchdog. Not imported by preparation or production code.
const MiB = 1024 * 1024;
const limits = Object.freeze({
  clients: 2,
  streamsPerClient: 2,
  maxDecodedWrite: 81920,
  maxEstimatedWrite: 328192,
  flight: { item: 8 * 262404, connection: 16 * 262404, total: 32 * 262404 },
  window: 8 * 262404 - 328192,
  decoded: { item: 512 * 1024, connection: MiB, total: 2 * MiB },
  transport: { item: 512 * 1024, connection: 512 * 1024, total: MiB },
  peer: { receive: 256 * 1024, reverse: 32 * 1024 },
  memory: {
    controllerRss: 96 * MiB,
    hostRss: 256 * MiB,
    hostHeap: 96 * MiB,
    hostExternal: 64 * MiB,
    rendererRss: 768 * MiB,
    rendererHeap: 128 * MiB,
    chromiumRss: 1280 * MiB,
    totalRss: 1536 * MiB,
  },
});
class ResourceBudget {
  constructor({ enabled = false, onStop = () => {}, profile = limits } = {}) {
    this.enabled = enabled;
    this.onStop = onStop;
    this.limits = profile;
    this.values = new Map();
    this.clients = new Map();
    this.violations = [];
    this.peaks = {};
    this.tripped = false;
    this.peakMemory = {};
    this.checks = 0;
  }
  breach(kind, scope, value, limit) {
    if (!this.violations.some((v) => v.kind === kind && v.scope === scope))
      this.violations.push({ kind, scope, value, limit });
    if (this.enabled && !this.tripped) {
      this.tripped = true;
      queueMicrotask(() => this.onStop(this.violations[0]));
    }
    return !this.enabled;
  }
  admit(connection, stream) {
    if (this.enabled && this.tripped) return false;
    if (
      !this.clients.has(connection) &&
      this.clients.size >= this.limits.clients
    )
      if (
        !this.breach(
          "clients",
          "total",
          this.clients.size + 1,
          this.limits.clients,
        )
      )
        return false;
    const streams = this.clients.get(connection) || new Set();
    if (
      stream !== undefined &&
      !streams.has(stream) &&
      streams.size >= this.limits.streamsPerClient
    )
      if (
        !this.breach(
          "streams",
          connection,
          streams.size + 1,
          this.limits.streamsPerClient,
        )
      )
        return false;
    this.clients.set(connection, streams);
    if (stream !== undefined) streams.add(stream);
    this.peaks.connections = Math.max(
      this.peaks.connections || 0,
      this.clients.size,
    );
    this.peaks.streamsPerConnection = Math.max(
      this.peaks.streamsPerConnection || 0,
      streams.size,
    );
    return true;
  }
  totals(kind, connection, item, value) {
    let total = value,
      conn = value;
    for (const r of this.values.values())
      if (
        r.kind === kind &&
        !(r.connection === connection && r.item === item)
      ) {
        total += r.value;
        if (r.connection === connection) conn += r.value;
      }
    return { item: value, connection: conn, total };
  }
  set(kind, connection, item, value, { reserve = false } = {}) {
    if (!Number.isFinite(value) || value < 0)
      throw Error("Invalid resource accounting");
    if (reserve && this.enabled && this.tripped) return false;
    const totals = this.totals(kind, connection, item, value),
      cap = this.limits[kind];
    let allowed = true;
    for (const scope of ["item", "connection", "total"])
      if (totals[scope] > cap[scope])
        allowed =
          this.breach(
            kind,
            scope === "item"
              ? `${connection}/${item}`
              : scope === "connection"
                ? connection
                : "total",
            totals[scope],
            cap[scope],
          ) && allowed;
    if (reserve && !allowed) return false;
    this.values.set(JSON.stringify([kind, connection, item]), {
      kind,
      connection,
      item,
      value,
    });
    const peak = this.peaks[kind] || { item: 0, connection: 0, total: 0 };
    for (const scope of Object.keys(peak))
      peak[scope] = Math.max(peak[scope], totals[scope]);
    this.peaks[kind] = peak;
    return allowed;
  }
  get(kind, connection, item) {
    return (
      this.values.get(JSON.stringify([kind, connection, item]))?.value || 0
    );
  }
  reserve(kind, connection, item, bytes) {
    return this.set(
      kind,
      connection,
      item,
      this.get(kind, connection, item) + bytes,
      { reserve: true },
    );
  }
  release(kind, connection, item, bytes) {
    return this.set(
      kind,
      connection,
      item,
      this.get(kind, connection, item) - bytes,
    );
  }
  window(connection, item, value, atomic) {
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      !Number.isFinite(atomic) ||
      atomic < 0
    )
      return this.breach(
        "telemetry",
        `${connection}/${item}/window`,
        String(value),
        0,
      );
    this.peaks.window = Math.max(this.peaks.window || 0, value);
    this.peaks.atomic = Math.max(this.peaks.atomic || 0, atomic);
    if (atomic > this.limits.maxEstimatedWrite)
      this.breach(
        "atomic",
        `${connection}/${item}`,
        atomic,
        this.limits.maxEstimatedWrite,
      );
    if (value + this.limits.maxEstimatedWrite > this.limits.flight.item)
      return this.breach(
        "window",
        `${connection}/${item}`,
        value,
        this.limits.window,
      );
    return !this.tripped;
  }
  memory(sample) {
    this.checks++;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value) || value < 0) {
        this.breach("telemetry", key, String(value), 0);
        continue;
      }
      this.peakMemory[key] = Math.max(this.peakMemory[key] || 0, value);
      if (value > this.limits.memory[key])
        this.breach("memory", key, value, this.limits.memory[key]);
    }
  }
  closeStream(connection, stream) {
    this.clients.get(connection)?.delete(stream);
  }
  close(connection) {
    this.clients.delete(connection);
    for (const [key, r] of this.values)
      if (r.connection === connection) this.values.delete(key);
  }
  current() {
    const out = { flight: 0, decoded: 0, transport: 0 };
    for (const r of this.values.values()) out[r.kind] += r.value;
    return out;
  }
  report() {
    return {
      enabled: this.enabled,
      limits: this.limits,
      peaks: this.peaks,
      peakMemory: this.peakMemory,
      violations: this.violations,
      tripped: this.tripped,
      memorySamples: this.checks,
      final: this.current(),
      clients: this.clients.size,
    };
  }
}
module.exports = { ResourceBudget, limits };
