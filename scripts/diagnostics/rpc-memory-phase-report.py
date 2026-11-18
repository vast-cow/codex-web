#!/usr/bin/env python3
"""Numeric, payload-free evidence for the isolated two-phase characterization."""
import argparse
import bisect
from collections import defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import sys

sys.dont_write_bytecode = True

MIB = 1048576
LIMIT = 1280 * MIB
spec = importlib.util.spec_from_file_location("attribution", Path(__file__).with_name("rpc-memory-report.py"))
attribution = importlib.util.module_from_spec(spec)
spec.loader.exec_module(attribution)


def excursions(rows):
    result = []
    first = None
    for index in range(len(rows) + 1):
        above = index < len(rows) and rows[index]["current"] > LIMIT
        if above and first is None:
            first = index
        if not above and first is not None:
            end = index - 1
            before = rows[max(0, first - 1)]["time"]
            after = rows[min(index, len(rows) - 1)]["time"]
            result.append(dict(
                start=rows[first]["time"], end=after,
                durationSeconds=(after - rows[first]["time"]) / 1000,
                durationLowerSeconds=(rows[end]["time"] - rows[first]["time"]) / 1000,
                durationUpperSeconds=(after - before) / 1000 if first > 0 and index < len(rows) else None,
                censoredStart=first == 0, censoredEnd=index == len(rows),
                peak=max(row["current"] for row in rows[first:index]),
                excessMiBSeconds=sum((rows[i]["current"] - LIMIT) / MIB * (rows[min(i + 1, len(rows) - 1)]["time"] - rows[i]["time"]) / 1000 for i in range(first, index)),
            ))
            first = None
    return result


def window(rows):
    if not rows:
        return None
    episodes = excursions(rows)
    duration = (rows[-1]["time"] - rows[0]["time"]) / 1000
    over = sum(episode["durationSeconds"] for episode in episodes)
    prefix = [0.0]
    times = [row["time"] for row in rows]
    for previous, current in zip(rows, rows[1:]):
        prefix.append(prefix[-1] + ((current["time"] - previous["time"]) / 1000 if previous["current"] > LIMIT else 0))
    rolling_peak = 0
    for index, row in enumerate(rows):
        start = max(times[0], row["time"] - 60000)
        prior = bisect.bisect_right(times, start) - 1
        prior_area = prefix[prior] + ((start - times[prior]) / 1000 if rows[prior]["current"] > LIMIT else 0)
        rolling_peak = max(rolling_peak, prefix[index] - prior_area)
    return dict(seconds=duration, samples=len(rows), min=min(row["current"] for row in rows),
                median=statistics.median(row["current"] for row in rows), max=max(row["current"] for row in rows),
                secondsAbove=over, fractionAbove=over / duration if duration else 0,
                maxRolling60SecondsAbove=rolling_peak,
                sustainedRuleFailures={str(seconds): sum(episode["durationLowerSeconds"] >= seconds for episode in episodes) for seconds in (5, 10, 15, 30)},
                excursionsPerMinute=len(episodes) * 60 / duration if duration else 0, excursions=episodes)


def summarize(root):
    evidence = json.loads((root / "rehearsal.json").read_text())
    rows = [json.loads(line) for line in (root / "control/memory/samples.jsonl").read_text().splitlines()]
    details = [row for row in rows if "processes" in row]
    idle_seconds = evidence.get("memoryPolicy", {}).get("idleSeconds", 180)
    labels = list(dict.fromkeys(row["phase"][:-8] for row in rows if row["phase"].endswith("-startup")))
    arms = []
    starts = [next(index for index, row in enumerate(rows) if row["phase"] == label + "-startup") for label in labels]
    for arm_index, label in enumerate(labels):
        arm_rows = rows[starts[arm_index]: starts[arm_index + 1] if arm_index + 1 < len(starts) else len(rows)]
        stop_row = next((row for row in arm_rows if row["phase"].endswith("-stop")), None)
        if stop_row:
            active_rows = arm_rows[:arm_rows.index(stop_row)]
        else:
            active_rows = arm_rows
        active = [row for row in active_rows if "-stop" not in row["phase"] and row["phase"] not in ("rollback", "cleanup")]
        ready = next((row["time"] for row in active if row["phase"] == label + "-ready"), None)
        settled = next((row["time"] for row in active if row.get("policy", {}).get("state") == "settled"), None)
        idle = [row for row in active if row["phase"] == label + "-idle-start"]
        # The terminal post-idle probe shares this phase. Restrict the idle
        # statistics to the requested idle interval, before that probe launches.
        if idle:
            idle = [row for row in idle if row["time"] <= idle[0]["time"] + idle_seconds * 1000]
        minute_medians = []
        minute_attribution = []
        if idle:
            for index in range(3):
                minute = [row for row in idle if idle[0]["time"] + index * 60000 <= row["time"] < idle[0]["time"] + (index + 1) * 60000]
                values = [row["current"] for row in minute]
                minute_medians.append(statistics.median(values) if values else None)
                if not minute:
                    continue
                components = defaultdict(lambda: defaultdict(list))
                nodes = defaultdict(lambda: defaultdict(list))
                for row in minute:
                    for component, counters in attribution.totals(row.get("processes", [])).items():
                        for metric in ("rss", "pss"):
                            components[component][metric].append(counters[metric])
                    for process in row.get("processes", []):
                        for thread in process.get("nodeThreads", []):
                            name = process["component"] + (":main" if thread["threadId"] == 0 else ":worker")
                            for metric in ("heapUsed", "heapTotal", "external", "arrayBuffers"):
                                nodes[name][metric].append(thread["current"][metric])
                minute_attribution.append(dict(
                    stat={metric: statistics.median(row["stat"][metric] for row in minute) for metric in ("anon", "file", "kernel", "sock", "shmem")},
                    components={name: {metric: statistics.median(values) for metric, values in counters.items()} for name, counters in components.items()},
                    nodeThreads={name: {metric: statistics.median(values) for metric, values in counters.items()} for name, counters in nodes.items()},
                ))
        peaks = defaultdict(lambda: dict(rss=0, pss=0))
        node_peaks = defaultdict(lambda: defaultdict(int))
        peakrow = max(active, key=lambda row: row["current"])
        settled_rows = [row for row in active if settled and row["time"] >= settled]
        settled_peak = max(settled_rows, key=lambda row: row["current"]) if settled_rows else None
        settled_details = [row for row in settled_rows if "processes" in row]
        settled_snapshot = max(settled_details, key=lambda row: row["current"]) if settled_details else None
        for row in active:
            for component, counters in attribution.totals(row.get("processes", [])).items():
                for key in ("rss", "pss"):
                    peaks[component][key] = max(peaks[component][key], counters[key])
            for process in row.get("processes", []):
                for thread in process.get("nodeThreads", []):
                    key = process["component"] + (":main" if thread["threadId"] == 0 else ":worker")
                    for metric, value in thread["peak"].items():
                        node_peaks[key][metric] = max(node_peaks[key][metric], value)
        steps = [step for step in evidence["steps"] if step["step"].startswith(label + "-") and not any(other != label and other.startswith(label + "-") and step["step"].startswith(other + "-") for other in labels)]
        stopped_snapshot = next((row for row in arm_rows if stop_row and row["phase"] == stop_row["phase"] + "-settled" and "processes" in row), None)
        arms.append(dict(label=label, readyAt=ready, settledAt=settled, start=active[0]["time"],
            readinessSeconds=(ready - active[0]["time"]) / 1000 if ready else None,
            settledSeconds=(settled - active[0]["time"]) / 1000 if settled else None,
            startup=window([row for row in active if settled is None or row["time"] < settled]),
            afterReadyBeforeSettled=window([row for row in active if ready and row["time"] >= ready and (settled is None or row["time"] < settled)]),
            settled=window(settled_rows),
            idle=window(idle), idleMinuteMedians=minute_medians,
            idleRequestedSeconds=idle_seconds,
            idleMinuteAttribution=minute_attribution,
            startupAndSettledExcursions=excursions(active),
            peakStat=peakrow["stat"], componentPeaks=dict(peaks), nodeThreadPeaks=dict(node_peaks),
            settledPeakStat=settled_peak["stat"] if settled_peak else None,
            settledDetailedPeak={**settled_snapshot, "components": attribution.totals(settled_snapshot["processes"])} if settled_snapshot else None,
            provisionalViolations=sorted(set(value for row in active for value in row.get("policy", {}).get("violations", []))),
            passedWaves=sum(step.get("bodyMatches", False) or step.get("healthyAfterIdle", False) for step in steps),
            matchedBodies=sum(len(step.get("bodies", [])) + (4 if step.get("healthyAfterIdle") else 0) for step in steps),
            upstreamPeakActive=max((step.get("upstreamPeakActive", 0) for step in steps), default=0),
            stopped=next((dict(current=step["memoryCurrent"], listenerReleased=step.get("listenerReleased"), childReaped=step.get("childReaped")) for step in evidence["steps"] if stop_row and step["step"] == stop_row["phase"]), None),
            stopped30s=next((step["memoryCurrent"] for step in evidence["steps"] if stop_row and step["step"] == stop_row["phase"] + "-settled"), None),
            stopped30sAttribution={"stat": stopped_snapshot["stat"], "components": attribution.totals(stopped_snapshot["processes"])} if stopped_snapshot else None,
        ))
    sampled = max(rows, key=lambda row: row["current"])
    snapshot = max(details, key=lambda row: row["current"])
    gaps = [(b["time"] - a["time"]) / 1000 for a, b in zip(rows, rows[1:])]
    # Preserve one numeric sample per second; excursion extraction uses ALL rows.
    seconds = {}
    for row in rows:
        second = row["time"] // 1000
        if second not in seconds or row["current"] > seconds[second]["current"]:
            seconds[second] = {key: row[key] for key in ("time", "phase", "current", "peak", "events", "policy") if key in row}
            seconds[second]["stat"] = {key: row["stat"][key] for key in ("anon", "file", "kernel", "sock", "shmem")}
    a_launches = [step for step in evidence["steps"] if step["step"].endswith("-launch") and ("-A-" in step["step"] or step["step"].startswith("A-"))]
    rollback = dict(
        comparableALaunches=len(a_launches),
        identicalArtifacts=len(a_launches) >= 2 and all(step["artifacts"] == a_launches[0]["artifacts"] for step in a_launches),
        identicalRuntimeConfiguration=len(a_launches) >= 2 and all(step["configuration"] == a_launches[0]["configuration"] for step in a_launches),
        finalAStoppedAndReaped=bool(arms and "A" in arms[-1]["label"] and arms[-1]["stopped"] and arms[-1]["stopped"]["listenerReleased"] and arms[-1]["stopped"]["childReaped"]),
    )
    return dict(source=root.name, error=evidence.get("error"), memoryPolicy=evidence.get("memoryPolicy", {"mode": "see instrumentation provenance"}), isolation=evidence["isolation"],
        memory=evidence.get("memory"), arms=arms, rollback=rollback,
        observer=dict(maxSampleGapSeconds=max(gaps), medianSampleGapSeconds=statistics.median(gaps), samples=len(rows)),
        sampledPeak={key: sampled[key] for key in ("time", "phase", "current", "peak", "stat", "events")},
        detailedPeak={**snapshot, "components": attribution.totals(snapshot["processes"])},
        rawSamplesSha256=hashlib.sha256((root / "control/memory/samples.jsonl").read_bytes()).hexdigest(),
        instrumentation={file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted((root / "control").glob("rpc-*.cjs"))},
        artifactManifests={step["step"]: step["artifacts"] for step in evidence["steps"] if "artifacts" in step},
        steps=[{key: value for key, value in step.items() if key in (
            "step", "memoryCurrent", "memoryPeak", "bodyMatches", "upstreamActive", "upstreamPeakActive",
            "healthyAfterIdle", "listenerReleased", "childReaped", "memoryOrder", "exactRecordedArtifactsAndRuntime",
            "browserReloadedMs", "readerRejectedMs", "firstBytes", "heldSourceClosed", "noAutomaticRestart",
            "recoveredByModeTransition", "browserReloaded", "upgrades", "socketCloses", "inheritedCgroup",
            "browserClosed", "appServerReaped", "signInUsable", "fixtureEofAndDigest", "signedOut", "plannedFault",
            "protocol", "ipc", "decodedBytes", "upstreamWrites", "syntheticJson",
        )} for step in evidence["steps"]],
        seconds=list(seconds.values()), terminalSample=rows[-1])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="+", type=Path)
    args = parser.parse_args()
    print(json.dumps(dict(schema=1, units="bytes unless named otherwise", runs=[summarize(root) for root in args.roots]), indent=2))
