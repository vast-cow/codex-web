#!/usr/bin/env python3
"""Fail-closed cgroup guard for an explicitly started disposable staging unit."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time


def systemctl(*args):
    return subprocess.check_output(["systemctl", "--user", *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("unit")
    parser.add_argument("phase_file", type=Path)
    parser.add_argument("log", type=Path)
    parser.add_argument("--startup-mib", type=int, default=1280)
    parser.add_argument("--steady-mib", type=int, default=1280)
    parser.add_argument("--ready-file", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"codex-staging-[A-Za-z0-9-]+\.service", args.unit):
        parser.error("Only codex-staging-*.service units are allowed")
    if not (0 < args.startup_mib <= 1536 and 0 < args.steady_mib <= 1280):
        parser.error("Ceilings must be within the reviewed staging envelope")
    group = systemctl("show", args.unit, "-p", "ControlGroup", "--value")
    if not group.startswith("/user.slice/"):
        parser.error("Expected a running user staging service")
    cg = Path("/sys/fs/cgroup") / group.lstrip("/")
    events = lambda: dict(line.split() for line in (cg / "memory.events").read_text().splitlines())
    reason = None
    try:
        if (cg / "memory.max").read_text().strip() != "2147483648":
            raise RuntimeError("memory.max differs from 2 GiB")
        if (cg / "memory.swap.max").read_text().strip() != "0":
            raise RuntimeError("swap is not disabled")
        for key, expected in [("KillMode", "control-group"), ("TimeoutStopUSec", "8s"), ("OOMPolicy", "stop")]:
            if systemctl("show", args.unit, "-p", key, "--value") != expected:
                raise RuntimeError(f"Unexpected {key}")
        with args.log.open("x", encoding="utf8") as output:
            if args.ready_file:
                args.ready_file.write_text(group + "\n")
            startup_since = None
            while True:
                phase = args.phase_file.read_text().strip()
                if phase not in ("startup", "steady", "stop"):
                    raise RuntimeError("Unknown monitoring phase")
                if phase == "startup":
                    if startup_since is None:
                        startup_since = time.monotonic()
                else:
                    startup_since = None
                current = int((cg / "memory.current").read_text())
                peak = int((cg / "memory.peak").read_text())
                counters = events()
                output.write(json.dumps(dict(time=time.time(), phase=phase, current=current, peak=peak, events=counters)) + "\n")
                output.flush()
                if any(int(counters.get(key, 0)) for key in ("max", "oom", "oom_kill", "oom_group_kill")):
                    raise RuntimeError("Limit or OOM event")
                ceiling = args.startup_mib if phase == "startup" else args.steady_mib
                # A missed transient also fails: the kernel peak is cumulative.
                if current > ceiling * 1048576 or peak > args.startup_mib * 1048576:
                    raise RuntimeError("Charged memory ceiling exceeded")
                if startup_since is not None and time.monotonic() - startup_since > 90:
                    raise RuntimeError("Startup exceeded 90 s")
                if phase == "stop":
                    reason = "Requested staging stop"
                    break
                time.sleep(0.1)
    except (OSError, ValueError, RuntimeError, KeyboardInterrupt) as error:
        reason = str(error)
    finally:
        # systemd owns descendant termination and the eight-second kill deadline.
        subprocess.run(["systemctl", "--user", "stop", args.unit], check=True)
    print(json.dumps(dict(stopped=args.unit, reason=reason)))
    return 0 if reason == "Requested staging stop" else 1


if __name__ == "__main__":
    raise SystemExit(main())
