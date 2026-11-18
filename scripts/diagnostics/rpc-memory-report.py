#!/usr/bin/env python3
"""Export payload-free attribution from isolated memory rehearsal directories."""
import argparse
from collections import defaultdict
import json
from pathlib import Path


def totals(processes):
    result = defaultdict(lambda: dict(rss=0, pss=0, private=0, shared=0))
    for process in processes:
        component = process["component"]
        if component.startswith("chromium:"):
            component = "chromium"
        for key in ("rss", "pss", "private", "shared"):
            result[component][key] += process[key]
    return dict(result)


def report(root):
    evidence = json.loads((root / "rehearsal.json").read_text())
    rows = [json.loads(line) for line in (root / "control/memory/samples.jsonl").read_text().splitlines()]
    detailed = [row for row in rows if "processes" in row]
    peak = max(rows, key=lambda row: row["current"])
    snapshot = max(detailed, key=lambda row: row["current"])
    process_peaks = {}
    component_peaks = defaultdict(lambda: dict(rss=0, pss=0))
    for row in detailed:
        for component, value in totals(row["processes"]).items():
            for key in ("rss", "pss"):
                component_peaks[component][key] = max(component_peaks[component][key], value[key])
        for process in row["processes"]:
            entry = process_peaks.setdefault(process["pid"], dict(pid=process["pid"], component=process["component"], rss=0, pss=0))
            for key in ("rss", "pss"):
                entry[key] = max(entry[key], process[key])
            threads = process.get("nodeThreads", [process["node"]] if "node" in process else [])
            if threads:
                nodes = entry.setdefault("nodeThreadPeaks", {})
                for thread in threads:
                    nodes[str(thread.get("threadId", 0))] = thread["peak"]
    arms = []
    for step in evidence["steps"]:
        if not step["step"].endswith("-health"):
            continue
        label = step["step"][:-7]
        active = [row for row in rows if row["phase"].startswith(label + "-") and not "-stop" in row["phase"] and "crash" not in row["phase"] and "shutdown" not in row["phase"]]
        # End the comparable workload at its 30-second settled checkpoint.
        settled_row = next((row for row in rows if row["phase"] == label + "-settled"), None)
        if settled_row:
            active = [row for row in active if row["time"] <= settled_row["time"]]
        find_step = lambda suffix: next((s["memoryCurrent"] for s in evidence["steps"] if s["step"] == label + suffix), None)
        arm_peak = max(active, key=lambda row: row["current"])
        idle = [row for row in active if row["phase"] == label + "-health"]
        tail = [row["current"] for row in idle if row["time"] >= idle[-1]["time"] - 10000]
        arms.append(dict(label=label, sampledPeak=arm_peak["current"], peakPhase=arm_peak["phase"], peakSecondsAfterHealth=(arm_peak["time"] - idle[0]["time"]) / 1000, idleLast10sMin=min(tail), idleLast10sMax=max(tail), settled30s=find_step("-settled"), stopped=find_step("-stop"), stopped30s=find_step("-stop-settled"), bodiesMatched=step["bodyMatches"], protocol=step["protocol"]))
    phases = {}
    for phase in dict.fromkeys(row["phase"] for row in rows):
        samples = [row for row in rows if row["phase"] == phase]
        phases[phase] = dict(start=samples[0]["current"], end=samples[-1]["current"], peak=max(row["current"] for row in samples), samples=len(samples))
    manifests = {step["artifacts"]["src/server/main.js"]: step["artifacts"] for step in evidence["steps"] if "artifacts" in step}
    return dict(source=root.name, isolation=evidence["isolation"], artifactManifests=manifests, error=evidence.get("error"), memory=evidence.get("memory"), arms=arms, sampledPeak=peak, detailedPeak={**snapshot, "components": totals(snapshot["processes"])}, componentPeaks=dict(component_peaks), processPeaks=list(process_peaks.values()), phases=phases, terminalSample=rows[-1], steps=[{k: v for k, v in step.items() if k in ("step", "memoryCurrent", "memoryPeak", "listenerReleased", "childReaped", "exactRecordedArtifactsAndRuntime", "browserReloadedMs", "readerRejectedMs", "browserClosed", "appServerReaped")} for step in evidence["steps"]])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="+", type=Path)
    args = parser.parse_args()
    print(json.dumps(dict(schema=1, units="bytes", runs=[report(root) for root in args.roots]), indent=2))
