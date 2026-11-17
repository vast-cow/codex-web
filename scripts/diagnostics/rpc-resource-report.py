"""Summarize isolated measurements; never infer missing historical metrics."""
import csv
import hashlib
import json
import statistics
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
data = json.loads(source.read_text())
rows = data['results']
assert len(rows) == 40, 'Require all ten scenarios, two AB/BA pairs each'
assert all(r['final']['estimated'] == r['final']['shapeBytes'] == r['final']['creditPending'] == 0 for r in rows)
destination.mkdir(parents=True, exist_ok=True)
(destination / 'guard-results.jsonl').write_text(''.join(json.dumps(r, separators=(',', ':')) + '\n' for r in rows))
metrics = []
for r in rows:
    m, b, q = r['maxima'], r['memory'], r['result']
    out = dict(scenario=r['config']['name'], repeat=r['repeat'], mode=r['mode'],
        max_window=m['window'], max_estimated=m['estimated'], max_atomic=m['atomic'],
        max_atomic_overshoot=m['overshoot'], max_host_ws=m['hostWsBuffered'], max_browser_ws=q['wsPeak'],
        max_shape_json=m['shapeBytes'], max_writer_decoded=q['writerPeakBytes'],
        max_pipeline_decoded_bound=m['logicalDecodedUpperBound'], max_host_rx_json=m['receiveBytes'],
        max_browser_rx_json=q['maxRxBytes'], max_port_json=q['maxPortBytes'], max_ack_json=q['maxAckBytes'],
        above_1mib_ms=r['aboveMiB']['totalMs'], longest_above_1mib_ms=r['aboveMiB']['longestMs'],
        tail_ack_drain_ms=r['tailAckDrainMs'], resume_backlog_drain_ms=q.get('stalledBacklogDrainMs'),
        disconnect_host_drain_ms=r['disconnectHostDrainMs'], disconnect_source_cancel_ms=r['disconnectSourceCancelMs'],
        body_ms=r['bodyDeliveryMs'], throughput_mibs=r['bodyThroughputMiBs'],
        ack_p50_ms=r['ackRtt']['p50Ms'], ack_p95_ms=r['ackRtt']['p95Ms'])
    for key in ['hostRss', 'hostHeap', 'hostExternal', 'rendererRss', 'rendererHeap']:
        for phase in ['baseline', 'peak', 'beforeGc', 'afterGc']:
            out[phase + '_' + key] = b[phase][key]
    metrics.append(out)
with (destination / 'guard-metrics.csv').open('w') as f:
    writer = csv.DictWriter(f, fieldnames=metrics[0].keys(), lineterminator="\n")
    writer.writeheader()
    writer.writerows(metrics)
cores = json.loads((source.parent / 'cores.json').read_text())
meta = dict(sourceHostHash=data['sourceHostHash'],
    coreHashes={k: hashlib.sha256(v.encode()).hexdigest() for k, v in cores.items()},
    runs=len(rows), scenarios=10, repeats=2, order='AB then BA; fresh Node/Chromium per run',
    inputResultsSha256=hashlib.sha256(source.read_bytes()).hexdigest())
(destination / 'guard-metadata.json').write_text(json.dumps(meta, indent=2) + '\n')
lines = ['# Measured resource comparison', '',
    'Each row gives the maximum across two identical-condition replicates. A = baseline; B = 512k. '
    'Memory peaks are sampled at 20 ms; WebSocket API buffering is also observed immediately after sends. '
    'Quantities in separate columns need not peak simultaneously. Exact byte values, both replicates, '
    'ACK percentiles, and post-GC memory are in [CSV](guard-metrics.csv) and [raw numeric records](guard-results.jsonl).', '',
    '| Scenario | Variant | Window MiB | Est. flight MiB | WS bytes (host/browser) | Shaper JSON KiB | Writer decoded KiB | Pipeline decoded bound KiB | >1 MiB total / longest ms | Tail drain ms |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for name in dict.fromkeys(m['scenario'] for m in metrics):
    for mode, label in [('baseline','A'),('512k','B')]:
        group = [m for m in metrics if m['scenario'] == name and m['mode'] == mode]
        assert len(group) == 2
        mx = lambda key: max(m[key] or 0 for m in group)
        tail = f"{mx('tail_ack_drain_ms'):.1f}" if name != 'disconnect' else 'see below'
        lines.append(f"| {name} | {label} | {mx('max_window')/2**20:.3f} | {mx('max_estimated')/2**20:.3f} | {mx('max_host_ws')}/{mx('max_browser_ws')} | {mx('max_shape_json')/1024:.1f} | {mx('max_writer_decoded')/1024:.0f} | {mx('max_pipeline_decoded_bound')/1024:.0f} | {mx('above_1mib_ms'):.1f} / {mx('longest_above_1mib_ms'):.1f} | {tail} |")
lines += ['', 'Tail drain = last decoded source pull to final write ACK on the host clock. '
          'It includes draining the remaining bounded network/writer work, not forced cleanup. '
          'Pipeline bound conservatively counts produced decoded bytes minus consumption reported '
          'through the local observation binding; encoded copies and delayed observation can overcount '
          'physically resident decoded data. Shaper and writer columns measure their own retained data.', '',
          '| Scenario | Variant | Host RSS / heap peak MiB | Renderer RSS / heap peak MiB | Host / renderer RSS growth MiB | Host / renderer heap after GC MiB |',
          '| --- | --- | ---: | ---: | ---: | ---: |']
for name in dict.fromkeys(m['scenario'] for m in metrics):
    for mode, label in [('baseline','A'),('512k','B')]:
        group=[m for m in metrics if m['scenario']==name and m['mode']==mode]
        mx=lambda key:max(m[key] or 0 for m in group)
        growth=lambda key:max(m['peak_'+key]-m['baseline_'+key] for m in group)/2**20
        lines.append(f"| {name} | {label} | {mx('peak_hostRss')/2**20:.2f} / {mx('peak_hostHeap')/2**20:.2f} | {mx('peak_rendererRss')/2**20:.2f} / {mx('peak_rendererHeap')/2**20:.2f} | {growth('hostRss'):.2f} / {growth('rendererRss'):.2f} | {mx('afterGc_hostHeap')/2**20:.2f} / {mx('afterGc_rendererHeap')/2**20:.2f} |")
lines += ['', '| Scenario | A MiB/s (median) | B MiB/s (median) | B throughput change | Body-time change |', '| --- | ---: | ---: | ---: | ---: |']
for name in dict.fromkeys(m['scenario'] for m in metrics):
    if name == 'disconnect':
        continue
    a=[m for m in metrics if m['scenario']==name and m['mode']=='baseline']
    b=[m for m in metrics if m['scenario']==name and m['mode']=='512k']
    at=statistics.median(m['throughput_mibs'] for m in a)
    bt=statistics.median(m['throughput_mibs'] for m in b)
    ad=statistics.median(m['body_ms'] for m in a)
    bd=statistics.median(m['body_ms'] for m in b)
    lines.append(f'| {name} | {at:.4f} | {bt:.4f} | {(bt/at-1)*100:+.2f}% | {(bd/ad-1)*100:+.2f}% |')
lines += ['', 'Throughput uses source first decoded pull to the final browser-consumption '
          'notification on the host clock, including configured stalls. The observation binding '
          'adds local overhead equally in A/B. These are modeled-path results, not production predictions.', '',
          '| Scenario | Variant | Source cancels after disconnect ms | Host credit/flight clears ms | Browser read rejects ms | Backlog clears after resume ms |',
          '| --- | --- | ---: | ---: | ---: | ---: |']
for name in ['stall-resume','stall-8s','disconnect']:
    for mode,label in [('baseline','A'),('512k','B')]:
        group=[r for r in rows if r['config']['name']==name and r['mode']==mode]
        fmt=lambda vals:f'{max(vals):.2f}' if vals else 'n/a'
        cancel=fmt([r['disconnectSourceCancelMs'] for r in group if r['disconnectSourceCancelMs'] is not None])
        host=fmt([r['disconnectHostDrainMs'] for r in group if r['disconnectHostDrainMs'] is not None])
        browser=fmt([r['result']['disconnectSettleMs'] for r in group if r['result']['disconnectSettleMs'] is not None])
        resume=fmt([r['result']['stalledBacklogDrainMs'] for r in group if r['result'].get('stalledBacklogDrainMs') is not None])
        lines.append(f'| {name} | {label} | {cancel} | {host} | {browser} | {resume} |')
(destination / 'guard-quantitative.md').write_text('\n'.join(lines)+'\n')
