// Experimental isolated acceptance policy. Never imported by the application.
const MiB = 1048576;
class MemoryPolicy {
  constructor(now = 0, characterize = false) {
    this.characterize = characterize;
    this.violations = new Set();
    this.state = "startup";
    this.started = now;
    this.last = now;
    this.belowSince = undefined;
    this.aboveSince = undefined;
    this.history = [];
    this.transitions = [];
  }
  sample({ now, current, peak, ready = false, events = {}, failure }) {
    if (this.state === "stopped") return this.reason;
    const stop = (reason) => {
      if (this.characterize && /^settled excursion/.test(reason)) {
        this.violations.add(reason);
        return undefined;
      }
      this.reason = reason;
      this.state = "stopped";
      return reason;
    };
    if (![now, current, peak].every(Number.isFinite) || now < this.last)
      return stop("invalid observation");
    if (now - this.last > 1000) return stop("observer gap over 1 s");
    this.last = now;
    if (failure) return stop(failure);
    if (["max", "oom", "oom_kill", "oom_group_kill"].some((key) => events[key]))
      return stop("cgroup limit/OOM event");
    if (current > 1536 * MiB || peak > 1536 * MiB)
      return stop("1,536 MiB absolute experimental ceiling");
    const above = current > 1280 * MiB;
    this.history.push({ now, current, above });
    this.history = this.history.filter((row) => now - row.now <= 180000);
    if (this.state === "startup") {
      if (ready && !above) this.belowSince ??= now;
      else this.belowSince = undefined;
      if (now - this.started > 90000)
        return stop("readiness/settling deadline 90 s");
      if (this.belowSince !== undefined && now - this.belowSince >= 10000) {
        this.state = "settled";
        this.settledAt = now;
        this.transitions.push({ now, state: "settled" });
      }
    } else {
      if (!ready) return stop("readiness lost outside planned recovery");
      if (above) this.aboveSince ??= now;
      else this.aboveSince = undefined;
      if (this.aboveSince !== undefined && now - this.aboveSince >= 5000)
        return stop("settled excursion sustained 5 s");
      // Left-held sample integration; crossing precision is one sample interval.
      const recent = this.history.filter((row) => row.now >= this.settledAt);
      let over = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i - 1].above)
          over += Math.max(
            0,
            recent[i].now - Math.max(now - 60000, recent[i - 1].now),
          );
      }
      if (over > 10000)
        return stop("settled excursions exceed 10 s in rolling 60 s");
      // Memory growth fails even when all samples stay below the warning line.
      if (now - this.settledAt >= 180000) {
        const medians = [0, 1, 2].map((index) => {
          const values = recent
            .filter(
              (row) =>
                row.now > now - (3 - index) * 60000 &&
                row.now <= now - (2 - index) * 60000,
            )
            .map((row) => row.current)
            .sort((a, b) => a - b);
          return values[Math.floor(values.length / 2)];
        });
        if (
          medians[2] - medians[0] > 64 * MiB &&
          medians[1] - medians[0] > 16 * MiB &&
          medians[2] - medians[1] > 16 * MiB
        )
          return stop("continuous growth across three 60 s medians");
      }
    }
    return undefined;
  }
}
module.exports = { MemoryPolicy };
