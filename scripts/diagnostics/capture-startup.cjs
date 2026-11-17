#!/usr/bin/env node
// Run with Playwright installed separately; never disable the HTTP cache.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.argv[2];
if (!url) throw new Error('Usage: capture-startup.cjs URL OUTPUT_DIRECTORY');
const output = path.resolve(process.argv[3] || 'startup-capture');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const seconds = Number(process.env.CAPTURE_SECONDS || 300);
const abFile = process.env.RPC_AB_HOST_READY;
const ab = abFile ? require('./rpc-ab-control.cjs').validateReady(
  JSON.parse(fs.readFileSync(abFile, 'utf8')), url) : null;
const profile = path.resolve(process.env.CAPTURE_PROFILE || path.join(output, 'profile'));
const runs = Number(process.env.CAPTURE_RUNS || (ab ? 3 : 2));
if (!Number.isInteger(runs) || runs < (ab ? 3 : 1)) throw new Error('Invalid CAPTURE_RUNS');
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid CAPTURE_SECONDS');
if (ab && (!process.env.CAPTURE_PROFILE || !process.env.CAPTURE_CLIENT_PATH || !process.env.CHROMIUM_PATH)) {
  throw new Error('A/B mode requires CAPTURE_PROFILE, CAPTURE_CLIENT_PATH and CHROMIUM_PATH');
}
if (ab && fs.readdirSync(output).length) throw new Error('A/B output must be a new empty directory');
(async () => {
  const controls = ab ? {
    url, seconds, runs, profile, clientPath: process.env.CAPTURE_CLIENT_PATH,
    chromiumPath: process.env.CHROMIUM_PATH,
    chromiumSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(process.env.CHROMIUM_PATH)).digest('hex'),
    playwrightModule: require.resolve(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    nodeVersion: process.version, libraryPath: process.env.LD_LIBRARY_PATH || null,
    headless: process.env.HEADED !== '1', viewport: { width: 1440, height: 1000 },
    readySelector: process.env.READY_SELECTOR || null,
    cache: 'normal HTTP cache; no overrides', rpcDiagnostics: true, warmupSettleMs: 15000,
    safety: ab.safety,
  } : null;
  const release = ab ? require('./rpc-ab-control.cjs').acquireControl(profile, controls) : () => {};
  let context;
  try {
    if (ab) {
      fs.writeFileSync(path.join(output, 'host-ready.json'), JSON.stringify(ab, null, 2), { mode: 0o600 });
      fs.writeFileSync(path.join(output, 'capture-controls.json'), JSON.stringify(controls, null, 2), { mode: 0o600 });
    }
    context = await chromium.launchPersistentContext(profile, {
      headless: process.env.HEADED !== '1',
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      viewport: { width: 1440, height: 1000 },
    });
    const page = context.pages()[0] || await context.newPage();
    if (ab && context.pages().length !== 1) throw new Error('A/B profile must have exactly one tab');
    if (ab) await context.addInitScript(() => localStorage.setItem('codex:rpc-diagnostics', '1'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    let log;
    for (const event of [
      'Network.requestWillBeSent', 'Network.requestWillBeSentExtraInfo',
      'Network.responseReceived', 'Network.responseReceivedExtraInfo',
      'Network.dataReceived', 'Network.loadingFinished', 'Network.loadingFailed',
      'Network.webSocketCreated', 'Network.webSocketWillSendHandshakeRequest',
      'Network.webSocketHandshakeResponseReceived', 'Network.webSocketFrameSent',
      'Network.webSocketFrameReceived', 'Network.webSocketFrameError', 'Network.webSocketClosed',
      'Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
    ]) cdp.on(event, data => log?.write(JSON.stringify({ event, observedAt: Date.now(), ...data }) + '\n'));
    if (ab) {
      // Unmeasured warmup, identical for both configurations. Never clear caches.
      await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
      await page.locator(process.env.READY_SELECTOR || 'textarea, [contenteditable="true"]').first()
        .waitFor({ state: 'visible', timeout: seconds * 1000 });
      await page.waitForTimeout(15000);
    }
    for (let run = 1; run <= runs; run++) {
      // Recheck freshness after warmup and before every measured navigation.
      if (ab) require('./rpc-ab-control.cjs').validateReady(ab, url);
      let browserComplete = !ab;
      const coverage = new Set();
      const observe = data => {
        const values = (data.args || []).map(arg => arg.value);
        for (const value of values) {
          if (typeof value !== 'string') continue;
          try {
            const record = JSON.parse(value);
            if (record.diagnostic === 'rpc-flow') coverage.add('rpc-flow');
            if (record.event === 'routes-mounted') coverage.add('routes-mounted');
            if (record.event === 'browser-receipt' && record.operation === 'close') coverage.add('close');
          } catch { /* Console messages need not be JSON. */ }
        }
      };
      if (ab) cdp.on('Runtime.consoleAPICalled', observe);
      log = fs.createWriteStream(path.join(output, `run-${run}.ndjson`), { mode: 0o600 });
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,v8.execute,blink.user_timing',
        transferMode: 'ReturnAsStream',
      });
      const started = Date.now();
      if (ab) fs.writeFileSync(path.join(output, `run-${run}-manifest.json`), JSON.stringify({
        run, startedUTC: new Date(started).toISOString(), host: ab, profile,
        browserVersion: context.browser()?.version(), seconds, browserComplete: false,
        validation: 'Capture in progress; not a completed run',
      }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ run, started, url, seconds }));
      if (run === 1 && !ab) await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
      else await page.reload({ waitUntil: 'commit', timeout: 60000 });
      // A selector is an optional stop condition, not a claim of application readiness.
      let selectorReached = false;
      if (process.env.READY_SELECTOR) {
        try {
          await page.locator(process.env.READY_SELECTOR).first().waitFor({ state: 'visible', timeout: seconds * 1000 });
          selectorReached = true;
        } catch (error) { if (error.name !== 'TimeoutError') throw error; }
        await page.waitForTimeout(15000);
      } else await page.waitForTimeout(seconds * 1000);
      await page.screenshot({ path: path.join(output, `run-${run}.png`) });
      const state = await page.evaluate(() => ({
        timeOrigin: performance.timeOrigin, now: performance.now(),
        text: document.body.innerText,
        resources: performance.getEntriesByType('resource'),
        navigation: performance.getEntriesByType('navigation'),
      }));
      fs.writeFileSync(path.join(output, `run-${run}-page.json`), JSON.stringify(state, null, 2), { mode: 0o600 });
      const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      const { stream } = await complete;
      const trace = fs.openSync(path.join(output, `run-${run}-trace.json`), 'w', 0o600);
      try {
        for (;;) {
          const chunk = await cdp.send('IO.read', { handle: stream });
          fs.writeSync(trace, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
          if (chunk.eof) break;
        }
      } finally { fs.closeSync(trace); await cdp.send('IO.close', { handle: stream }); }
      await new Promise(resolve => log.end(resolve));
      log = null;
      if (ab) {
        cdp.off('Runtime.consoleAPICalled', observe);
        browserComplete = ['rpc-flow', 'routes-mounted', 'close'].every(event => coverage.has(event));
        fs.writeFileSync(path.join(output, `run-${run}-manifest.json`), JSON.stringify({
          run, startedUTC: new Date(started).toISOString(), finishedUTC: new Date().toISOString(),
          host: ab, profile, browserVersion: context.browser()?.version(),
          seconds, selectorReached, browserCoverage: [...coverage], browserComplete,
          validation: 'Host correlation, stream integrity, errors and resource analysis still required',
        }, null, 2), { mode: 0o600 });
      }
      console.log(JSON.stringify({ run, finished: Date.now(), selectorReached, text: state.text.slice(0, 250) }));
      if (!browserComplete) throw new Error('Incomplete browser coverage; retain run, do not count it or continue');
    }
  } finally {
    try { await context?.close(); } finally { release(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
