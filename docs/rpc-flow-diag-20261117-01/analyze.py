#!/usr/bin/env python3
"""Join sanitized capture metadata; usage: analyze.py HOST_DIR BROWSER_DIR OUTPUT_DIR.

Requires matplotlib. Raw captures and browser profiles are not read or copied.
Cross-clock bounds are conditional on a constant offset over the body transfer;
per-operation CSV also retains each nearest probe's independent bounds.
"""
import csv
import hashlib
import json
import statistics
import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
matplotlib.rcParams['svg.hashsalt'] = 'rpc-flow-diag-20261117-01'
import matplotlib.pyplot as plt

host, browser, output = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)
def read_csv(name):
    return list(csv.DictReader((host / name).open()))
def number(row, key):
    return float(row[key])
def distribution(values):
    values = sorted(values)
    return dict(count=len(values), totalMs=sum(values), minMs=values[0],
                medianMs=statistics.median(values), maxMs=values[-1])

h = [json.loads(line) for line in (host / 'host-matched.ndjson').open()]
b = [json.loads(line) for line in (browser / 'browser-diagnostics.ndjson').open()]
a = read_csv('window-ack-timing.csv')
w = read_csv('credit-waits.csv')
clocks = read_csv('clock-bounds.csv')
reads = read_csv('upstream-read-timing.csv')
summary = json.loads((host / 'timing-summary.json').read_text())
assert summary['identifiers']['hostWindowId'] == 803
assert len(a) == 130 and len(w) == 122
assert all(int(x['streamId']) == 7 for x in a)
start, end = number(a[0], 'sendMs'), max(number(x, 'ackMs') for x in a)
body_clocks = [x for x in clocks if start <= number(x, 'sentHostMs') <= end]
lo = max(number(x, 'offsetLowerMs') for x in body_clocks)
hi = min(number(x, 'offsetUpperMs') for x in body_clocks)
assert lo <= hi
waits = [(number(x, 'startMs'), number(x, 'endMs')) for x in w]
gaps = [(x['hostMs'] - x['gapMs'], x['hostMs']) for x in h
        if x['event'] == 'upstream-read-gap' and x['requestId'] == summary['identifiers']['requestId']]
overlap = sum(max(0, min(e, ge) - max(s, gs)) for s, e in waits for gs, ge in gaps)
gap_total = sum(e-s for s, e in gaps)
starts = {x['operationId']: x for x in b if x.get('event') == 'writer-start'
          and x.get('sessionId') == 1 and x.get('streamId') == 7}
ends = {x['operationId']: x for x in b if x.get('event') == 'writer-end'
        and x.get('sessionId') == 1 and x.get('streamId') == 7}
acks = {x['operationId']: x for x in b if x.get('event') == 'ack-send' and x.get('sessionId') == 1}
assert len(starts) == len(ends) == len(a)
joined = []
for token, read in zip(a, [x for x in reads if x['eof'] == 'False']):
    op = int(token['operationId'])
    bs, be, ba = starts[op], ends[op], acks[op]
    assert not be['failed'] and bs['bytes'] == int(read['bytes'])
    assert abs(be['ms'] - number(token, 'browserWriterEndMs')) < 1e-6
    send, ack = number(token, 'sendMs'), number(token, 'ackMs')
    nearest = min(clocks, key=lambda c: abs(number(c, 'sentHostMs') - (send+ack)/2))
    nl, nu = number(nearest, 'offsetLowerMs'), number(nearest, 'offsetUpperMs')
    joined.append(dict(sequence=int(read['sequence']), operationId=op, tokenId=int(token['tokenId']),
        decodedBytes=int(read['bytes']), estimatedBytes=int(token['estimatedBytes']),
        hostSendMs=send, hostAckMs=ack, ackRttMs=number(token, 'ackRttMs'),
        browserWriterStartMs=bs['ms'], browserWriterEndMs=be['ms'], browserAckSendMs=ba['ms'],
        writerWaitMs=be['durationMs'], writerEndToAckMs=ba['ms']-be['ms'],
        outboundLowerMs=max(0, bs['ms']+lo-send), outboundUpperMs=bs['ms']+hi-send,
        returnLowerMs=max(0, ack-ba['ms']-hi), returnUpperMs=ack-ba['ms']-lo,
        nearestOffsetLowerMs=nl, nearestOffsetUpperMs=nu,
        nearestOutboundLowerMs=max(0, bs['ms']+nl-send), nearestOutboundUpperMs=bs['ms']+nu-send,
        nearestReturnLowerMs=max(0, ack-ba['ms']-nu), nearestReturnUpperMs=ack-ba['ms']-nl))
assert sum(x['decodedBytes'] for x in joined) == 7957011
with (output / 'correlated-writes.csv').open('w') as f:
    writer = csv.DictWriter(f, fieldnames=joined[0], lineterminator='\n'); writer.writeheader(); writer.writerows(joined)
# Join release callbacks to the immediately preceding eligible ACK, not by browser timing proximity.
window_acks = sorted((x for x in h if x['event'] == 'window-ack' and x.get('windowId') == 803), key=lambda x:x['ms'])
releases=[]
for wait in w:
    finish=number(wait, 'endMs')
    eligible=[x for x in window_acks if x['ms'] <= finish and x['bytesInFlight'] < x['window']]
    ack=max(eligible,key=lambda x:x['ms'])
    assert finish-ack['ms'] < .02
    releases.append(dict(waitId=wait['waitId'],startMs=wait['startMs'],endMs=finish,
        releasingOperationId=ack['operationId'],tokenId=ack['tokenId'],hostAckMs=ack['ms'],
        ackToReleaseMs=finish-ack['ms']))
with (output / 'credit-releases.csv').open('w') as f:
    writer=csv.DictWriter(f,fieldnames=releases[0],lineterminator='\n');writer.writeheader();writer.writerows(releases)
window_states=[(start,262144)]+[(x['ms'],x['window']) for x in window_acks]
def time_at_most(threshold):
    return sum(t2-t for (t,cap),(t2,_) in zip(window_states,window_states[1:]) if cap <= threshold)
result=dict(label='rpc-flow-diag-20261117-01', hostSession=802,browserSession=1,stream=7,window=803,
    decodedBytes=sum(x['decodedBytes'] for x in joined), estimatedBytes=sum(x['estimatedBytes'] for x in joined),
    firstSendToLastAckMs=end-start,decodedBytesPerSecond=7957011/((end-start)/1000),
    creditWaitReportedMs=summary['creditWait']['sumMs'],creditWaitIntervalMs=sum(e-s for s,e in waits),
    readGapMs=gap_total,readGapCreditOverlapMs=overlap,readGapOverlapPercent=100*overlap/gap_total,
    readGapOutsideCreditMs=gap_total-overlap,creditOutsideReadGapsMs=sum(e-s for s,e in waits)-overlap,
    writerWait=distribution(x['writerWaitMs'] for x in joined),
    writerEndToAck=distribution(x['writerEndToAckMs'] for x in joined),
    ackToRelease=distribution(x['ackToReleaseMs'] for x in releases),
    clockBodyIntersection=[lo,hi],clockGlobalIntersection=[max(number(c,'offsetLowerMs') for c in clocks),min(number(c,'offsetUpperMs') for c in clocks)],
    timeAtMinimumMs=time_at_most(65536),minimumAckCount=sum(x['window']==65536 for x in window_acks),
    timeAtMost128KiBMs=time_at_most(131072),timeBelowTypicalChunkMs=time_at_most(262404-1e-6),
    ackStatesBelowTypicalChunk=sum(x['window']<262404 for x in window_acks),
    estimatedChunkHistogram={str(size):sum(x['estimatedBytes']==size for x in joined) for size in sorted(set(x['estimatedBytes'] for x in joined))},
    sourceHashes={str(p.name):hashlib.sha256(p.read_bytes()).hexdigest() for p in [host/'host-matched.ndjson',host/'window-ack-timing.csv',browser/'browser-diagnostics.ndjson']})
for name in ['outboundLowerMs','outboundUpperMs','returnLowerMs','returnUpperMs','nearestReturnLowerMs','nearestReturnUpperMs']:
    result[name]=distribution(x[name] for x in joined)
(output/'correlation-summary.json').write_text(json.dumps(result,indent=2)+'\n')

fig, axes = plt.subplots(4,1,figsize=(14,13),sharex=True,gridspec_kw={'height_ratios':[2,1,3,2]},layout='constrained')
fig.suptitle('RPC credit pacing — rpc-flow-diag-20261117-01\nHost session 802 / browser session 1 / stream 7 / window 803')
window_events=sorted((x for x in h if x['event'] in ('window-send','window-ack') and x.get('windowId')==803),key=lambda x:x['ms'])
x=[(v['ms']-start)/1000 for v in window_events]
axes[0].step(x,[v['window']/1024 for v in window_events],where='post',label='Adaptive window')
axes[0].step(x,[v['bytesInFlight']/1024 for v in window_events],where='post',label='Outstanding',alpha=.8)
axes[0].axhline(262404/1024,color='gray',ls='--',label='Typical 64 KiB decoded write (256.25 KiB estimated)')
axes[0].set_ylabel('Estimated KiB');axes[0].legend(loc='upper right',fontsize=8)
for intervals,y,color,label in [(waits,1,'#c55a11','Credit blocked'),(gaps,0,'#2878a0','Read demand gap')]:
    axes[1].broken_barh([((s-start)/1000,(e-s)/1000) for s,e in intervals],(y-.25,.5),facecolors=color,label=label)
axes[1].set_yticks([0,1],['Read gap','Credit wait']);axes[1].set_ylim(-.6,1.6)
for row in joined:
    s,e=(row['hostSendMs']-start)/1000,(row['hostAckMs']-start)/1000
    y=row['sequence'];axes[2].plot([s,e],[y,y],color='#b7c2cc',lw=1)
    axes[2].plot(s,y,'|',color='#166fa0');axes[2].plot(e,y,'|',color='#a43c28')
    left=(row['browserWriterEndMs']+lo-start)/1000;right=(row['browserWriterEndMs']+hi-start)/1000
    axes[2].plot([left,right],[y,y],color='#248b48',lw=2)
axes[2].plot([],[],'|',color='#166fa0',label='Host send');axes[2].plot([],[],'|',color='#a43c28',label='Host ACK receipt')
axes[2].plot([],[],color='#248b48',label='Browser writer end / ACK submission (44.694 ms offset band)')
axes[2].set_ylabel('Body write sequence');axes[2].legend(fontsize=8)
xx=[(r['hostSendMs']-start)/1000 for r in joined]
axes[3].plot(xx,[r['ackRttMs'] for r in joined],color='black',label='Host ACK RTT')
for lower,upper,color,label in [('outboundLowerMs','outboundUpperMs','#70a8d0','Send → browser writer start'),('returnLowerMs','returnUpperMs','#d79b76','Browser ACK submission → host ACK')]:
    axes[3].fill_between(xx,[r[lower] for r in joined],[r[upper] for r in joined],color=color,alpha=.65,label=label)
axes[3].set_ylabel('Milliseconds');axes[3].set_xlabel('Seconds from first host window send');axes[3].legend(fontsize=8)
for ax in axes:ax.grid(alpha=.2);ax.set_xlim(0,(end-start)/1000)
fig.savefig(output/'credit-window-timeline.svg',metadata={'Date':None})
svg = output/'credit-window-timeline.svg'
svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
plt.close(fig)
print(json.dumps({k:result[k] for k in ['readGapCreditOverlapMs','readGapOutsideCreditMs','clockBodyIntersection','timeBelowTypicalChunkMs']},indent=2))
