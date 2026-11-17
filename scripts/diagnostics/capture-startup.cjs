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
(async () => {
  const context = await chromium.launchPersistentContext(path.join(output, 'profile'), {
    headless: process.env.HEADED !== '1',
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = context.pages()[0] || await context.newPage();
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
    for (let run = 1; run <= 2; run++) {
      log = fs.createWriteStream(path.join(output, `run-${run}.ndjson`), { mode: 0o600 });
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,v8.execute,blink.user_timing',
        transferMode: 'ReturnAsStream',
      });
      const started = Date.now();
      console.log(JSON.stringify({ run, started, url, seconds }));
      if (run === 1) await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
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
      console.log(JSON.stringify({ run, finished: Date.now(), selectorReached, text: state.text.slice(0, 250) }));
    }
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
