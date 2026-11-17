"""Produce scoped budget evidence from the isolated multi-client validation."""
import argparse
import csv
import hashlib
import json
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--application',type=Path,action='append',required=True)
parser.add_argument('--kernel',type=Path,required=True)
parser.add_argument('--rehearsal',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
source=args.application[0];kernel=args.kernel;rehearsal=args.rehearsal;output=args.output
by_case={}
for input_file in args.application:
    for r in json.loads(input_file.read_text()):
        by_case[(r['config']['name'],r['mode'],r['enabled'],r['repeat'])]=r
rows=list(by_case.values())
kernel_data=json.loads(kernel.read_text())
rows += [{**c['measurement'],'repeat':c['repeat']} for c in kernel_data['cases']]
assert len(rows) == 112, 'Require regular workloads, admission/peer probes, atomic boundary, and kernel profiles'
assert len({json.dumps(r['budget']['limits'], sort_keys=True) for r in rows}) == 1
assert all(r['pendingCredit'] == 0 and all(v == 0 for v in r['budget']['final'].values()) for r in rows)
assert all(r['sourceHostHash'] == rows[0]['sourceHostHash'] for r in rows)
assert all(all(r['budget']['peakMemory'][key]>0 for key in ['controllerRss','hostRss','chromiumRss','rendererRss']) for r in rows)
assert all(all(c in ('0', '1') for c in r['windowOwners']) for r in rows)
output.mkdir(parents=True, exist_ok=True)
(output / 'budget-results.jsonl').write_text(''.join(json.dumps(r, separators=(',', ':'))+'\n' for r in rows))
(output/'budget-netem.json').write_text(json.dumps({k:v for k,v in kernel_data.items() if k!='cases'},indent=2)+'\n')
(output/'budget-netem-cases.jsonl').write_text(''.join(json.dumps({k:v for k,v in c.items() if k!='measurement'},separators=(',',':'))+'\n' for c in kernel_data['cases']))
(output / 'budget-rehearsal.json').write_text(json.dumps(json.loads(rehearsal.read_text()), indent=2)+'\n')
metrics=[]
for r in rows:
    p=r['budget']['peaks']; m=r['budget']['peakMemory']
    actual_bytes=sum(o['bytesRead'] for page in r['pages'] for o in page['outcomes'])
    throughput=actual_bytes/1048576/(r['elapsedMs']/1000) if r.get('elapsedMs') and r['status']=='complete' else None
    line=dict(profile=r['config']['name'],mode=r['mode'],stop_enabled=r['enabled'],repeat=r['repeat'],status=r['status'],
        max_window=p.get('window',0),max_atomic=p.get('atomic',0),max_host_ws=r['maxWs'],sampled_kernel_tx=r['maxKernelTx'],
        browser_ws_peak_sum=sum(q['wsPeak'] for q in r['pages']),browser_port_peak_sum=sum(q['portPeak'] for q in r['pages']),
        browser_ack_peak_sum=sum(q['ackPeak'] for q in r['pages']),writer_peak_sum=sum(q['writerPeak'] for q in r['pages']),
        received_bytes=actual_bytes,delivery_ms=r.get('elapsedMs'),throughput_mibs=throughput,ack_p95_ms=r.get('ackP95'),
        teardown_ms=r['cleanupMs'],credit_rejections=r['rejectedCredit'],first_stop=json.dumps(r.get('stopReason'),separators=(',', ':')))
    cancellation=[];disconnect_drain=[]
    if r['status']=='complete':
        for action in r.get('actions',[]):
            cancellation.extend(p['cancelAt']-action['ms'] for p in r['producers'] if p['cid']==action['cid'] and p.get('cancelAt') and (action['kind']=='disconnect' or p['key']==str(action['id'])))
        disconnect_drain=[p['drainedAt']-p['closedAt'] for p in r.get('lifecycle',[]) if p.get('drainedAt')]
    line['source_action_cancel_ms']=max(cancellation) if cancellation else None
    line['host_disconnect_drain_ms']=max(disconnect_drain) if disconnect_drain else None
    for kind in ['flight','decoded','transport']:
        for scope in ['item','connection','total']:
            line[kind+'_'+scope]=p.get(kind,{}).get(scope,0)
    for key,value in m.items():
        line['peak_'+key]=value
        line['end_'+key]=r['memory']['last'].get(key)
    metrics.append(line)
with (output / 'budget-metrics.csv').open('w') as f:
    w=csv.DictWriter(f,fieldnames=metrics[0].keys(),lineterminator='\n');w.writeheader();w.writerows(metrics)
cores=json.loads((source.parent/'cores.json').read_text())
info={k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines()) if v.strip() and v.strip().split()[0].isdigit()}
try:
    units=subprocess.run(['systemctl','show','session-3.scope','user-1000.slice','user.slice','--property=Id','--property=MemoryMax','--property=MemoryCurrent','--no-pager'],capture_output=True,text=True,timeout=10).stdout
except Exception as error:
    units=str(error)
meta=dict(collectedAt=datetime.now(timezone.utc).isoformat(),snapshot='post-validation, not a guarantee of future availability',
    MemTotal=info['MemTotal'],MemAvailable=info['MemAvailable'],planningAllowance=2*1024**3,
    cgroupFilesReadable=Path('/sys/fs/cgroup/memory.max').exists(),scopeReadOnly=units,
    systemdActivation='isolated transient unit creation rejected: Interactive authentication required',
    sourceHostHash=rows[0]['sourceHostHash'],cores={k:hashlib.sha256(cores[k].encode()).hexdigest() for k in ['baseline','512k','browser']},
    applicationSources=[dict(sha256=hashlib.sha256(p.read_bytes()).hexdigest(),rows=len(json.loads(p.read_text()))) for p in args.application],
    kernelSha256=hashlib.sha256(kernel.read_bytes()).hexdigest(),rows=len(rows),limits=rows[0]['budget']['limits'])
(output/'budget-metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
lines=['# Multi-client budget measurements','',
    'Two clients, two concurrent streams each, except the deliberate admission probes. Every profile has two balanced A/B pairs in each policy. '
    'Observe records violations without stopping; stop uses the separate opt-in safeguard. '
    '`budget-stop` is a successful stop test and a failed resource-acceptance result. '
    'All values below are maxima across the two replicates unless labeled median. '
    'Exact bytes, per-connection/stream maxima, ACK percentiles and final GC memory are in '
    '[CSV](budget-metrics.csv); [numeric records](budget-results.jsonl) include phase snapshots.','',
    '| Profile | Mode | Policy | Complete / stopped | Window MiB | Flight total MiB | Decoded total MiB | Forward total MiB | Group RSS MiB | Host heap MiB | Renderer heap MiB |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for name in dict.fromkeys(m['profile'] for m in metrics):
    for enabled in [False,True]:
        for mode,label in [('baseline','A'),('512k','B')]:
            g=[m for m in metrics if m['profile']==name and m['stop_enabled']==enabled and m['mode']==mode]
            assert len(g)==2
            mx=lambda k:max(m[k] or 0 for m in g)
            good=sum(m['status']=='complete' for m in g)
            lines.append(f"| {name} | {label} | {'stop' if enabled else 'observe'} | {good} / {2-good} | {mx('max_window')/2**20:.3f} | {mx('flight_total')/2**20:.3f} | {mx('decoded_total')/2**20:.3f} | {mx('transport_total')/2**20:.3f} | {mx('peak_totalRss')/2**20:.1f} | {mx('peak_hostHeap')/2**20:.1f} | {mx('peak_rendererHeap')/2**20:.2f} |")
lines += ['', 'Group RSS includes the worker, preparation-free controller, and all Chromium descendants, '
          'including browser/zygote/GPU/utility processes. It sums RSS conservatively and can double-count '
          'shared pages. Kernel TX is sampled separately and included in the forward ledger when observed. '
          'Client receive and reverse queues have separate local caps; their per-client peak sums in the CSV '
          'are conservative upper bounds, not simultaneous measured totals.','',
          '| Completed profile | Policy | A MiB/s median | B MiB/s median | Throughput change | Body-time change |',
          '| --- | --- | ---: | ---: | ---: | ---: |']
for name in dict.fromkeys(m['profile'] for m in metrics):
    if name in ['peer-stop-probe', 'over-clients', 'over-streams']:
        continue
    for enabled in [False,True]:
        a=[m for m in metrics if m['profile']==name and m['stop_enabled']==enabled and m['mode']=='baseline']
        b=[m for m in metrics if m['profile']==name and m['stop_enabled']==enabled and m['mode']=='512k']
        if not all(m['status']=='complete' for m in a+b):
            continue
        at=statistics.median(m['throughput_mibs'] for m in a);bt=statistics.median(m['throughput_mibs'] for m in b)
        ad=statistics.median(m['delivery_ms'] for m in a);bd=statistics.median(m['delivery_ms'] for m in b)
        lines.append(f"| {name} | {'stop' if enabled else 'observe'} | {at:.4f} | {bt:.4f} | {(bt/at-1)*100:+.2f}% | {(bd/ad-1)*100:+.2f}% |")
lines += ['', 'Performance uses actual verified decoded byte counts and source-first-pull to last-consumption '
          'notification on the host clock. Canceled/disconnected work is partial verified delivery, not successful '
          'full-body throughput. Stopped runs have no performance acceptance claim. Sampling and observation '
          'bindings add overhead equally in A/B. These models are not production startup measurements.','',
          '| Profile | Policy | First violation kinds | Largest first-crossing/rejected forward reservation bytes | Limit bytes |',
          '| --- | --- | --- | ---: | ---: |']
for name in dict.fromkeys(m['profile'] for m in metrics):
    for enabled in [False,True]:
        group=[r for r in rows if r['config']['name']==name and r['enabled']==enabled]
        first=sorted({r['budget']['violations'][0]['kind'] for r in group if r['budget']['violations']})
        forward=[v['value'] for r in group for v in r['budget']['violations'] if v['kind']=='transport' and v['scope']!='total']
        lines.append(f"| {name} | {'stop' if enabled else 'observe'} | {', '.join(first) or 'none'} | {max(forward) if forward else 'n/a'} | 524288 |")
lines += ['', '| Completed action | Variant | Max source-cancel latency ms | Max host credit drain after TCP close ms |', '| --- | --- | ---: | ---: |']
for name in ['cancel','disconnect']:
    for mode,label in [('baseline','A'),('512k','B')]:
        g=[m for m in metrics if m['profile']==name and m['mode']==mode and m['status']=='complete']
        cancel=[m['source_action_cancel_ms'] for m in g if m['source_action_cancel_ms'] is not None]
        drain=[m['host_disconnect_drain_ms'] for m in g if m['host_disconnect_drain_ms'] is not None]
        lines.append(f"| {name} | {label} | {max(cancel):.2f} | {format(max(drain),'.2f') if drain else 'n/a (other streams remain active)'} |")
lines += ['', 'Actions are marked through the local observation binding before the browser call; source cancellation and TCP/credit hooks use the same host clock. Latencies include that binding overhead. Single-stream cancel leaves other streams active, so connection-wide drain is measured only for disconnect. All final credit waiters and actual extracted-controller outstanding bytes are zero.']
(output/'budget-quantitative.md').write_text('\n'.join(lines)+'\n')
