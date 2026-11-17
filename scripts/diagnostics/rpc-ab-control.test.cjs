const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateReady, acquireControl } = require('./rpc-ab-control.cjs');

const now = Date.now();
const ready = {
  captureId: 'rpc-ab-A', configuration: 'A', confirmation: 'HOST READY — rpc-ab-A — A',
  confirmedUTC: new Date(now).toISOString(), url: 'https://example.invalid/',
  window: { initialBytes: 262144, minimumBytes: 65536, maximumBytes: 1073741824,
    clampBehavior: 'original adaptive algorithm' },
  source: 'test fixture', revision: 'test', processIdentity: 'test', hostLog: '/test/log',
  resourceCapture: 'unavailable', baselineLocation: '/test/baseline',
  hostBundleSha256: 'a'.repeat(64), browserBundleSha256: 'b'.repeat(64),
  bootstrapDiagnostics: true, rpcDiagnostics: true, exclusiveTraffic: true,
};

test('readiness gate rejects stale, wrong-origin, ambiguous or incomplete host confirmations', () => {
  assert.equal(validateReady(ready, ready.url, now), ready);
  for (const change of [
    { confirmation: 'ready' }, { configuration: 'B' }, { confirmedUTC: 'invalid' },
    { confirmedUTC: new Date(now - 1800001).toISOString() },
    { confirmedUTC: new Date(now + 1).toISOString() },
    { rpcDiagnostics: false }, { bootstrapDiagnostics: false }, { exclusiveTraffic: false },
    { hostBundleSha256: 'unknown' }, { baselineLocation: '' },
    { window: { ...ready.window, minimumBytes: 524288 } },
  ]) assert.throws(() => validateReady({ ...ready, ...change }, ready.url, now));
  assert.throws(() => validateReady(ready, 'https://other.invalid/', now));
  assert.doesNotThrow(() => validateReady({ ...ready, configuration: 'B',
    confirmation: 'HOST READY — rpc-ab-A — B',
    window: { ...ready.window, minimumBytes: 524288 } }, ready.url, now));
});

test('shared profile lock prevents overlap and controls cannot change between configurations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-ab-control-'));
  try {
    const profile = path.join(dir, 'profile');
    const controls = { seconds: 360, cache: 'normal' };
    const release = acquireControl(profile, controls);
    assert.throws(() => acquireControl(profile, controls), /EEXIST/);
    release();
    assert.throws(() => acquireControl(profile, { ...controls, seconds: 300 }), /controls changed/);
    const releaseAgain = acquireControl(profile, controls);
    releaseAgain();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capture harness performs three warm reloads per arm and records exact settings without a network', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-ab-harness-'));
  try {
    const mock = path.join(dir, 'playwright.cjs');
    fs.writeFileSync(mock, `
      const fs = require('node:fs');
      const { EventEmitter } = require('node:events');
      const cdp = new EventEmitter();
      cdp.send = async name => {
        if (name === 'Tracing.end') cdp.emit('Tracing.tracingComplete', { stream: 'test' });
        return name === 'IO.read' ? { data: '{}', eof: true } : {};
      };
      const page = {
        goto: async () => fs.appendFileSync(process.env.TEST_CALLS, 'warmup\\n'),
        reload: async () => {
          fs.appendFileSync(process.env.TEST_CALLS, 'reload\\n');
          for (const record of [{diagnostic:'rpc-flow'}, {event:'routes-mounted'},
            {event:'browser-receipt', operation:'close'}])
            cdp.emit('Runtime.consoleAPICalled', { args: [{value:JSON.stringify(record)}] });
        },
        locator: () => ({ first: () => ({waitFor: async () => {}}) }),
        waitForTimeout: async () => {}, screenshot: async () => {},
        evaluate: async () => ({text:'test', resources:[], navigation:[]})
      };
      exports.chromium = {launchPersistentContext: async () => ({
        pages: () => [page], newCDPSession: async () => cdp, addInitScript: async () => {},
        browser: () => ({version: () => 'test-browser'}), close: async () => {}
      })};
    `);
    for (const configuration of ['A', 'B']) {
      const relay = { ...ready, configuration, confirmedUTC: new Date().toISOString(),
        confirmation: `HOST READY — rpc-ab-A — ${configuration}`,
        window: { ...ready.window, minimumBytes: configuration === 'A' ? 65536 : 524288 } };
      const relayFile = path.join(dir, `${configuration}.json`);
      fs.writeFileSync(relayFile, JSON.stringify(relay));
      const output = path.join(dir, configuration);
      const result = spawnSync(process.execPath, [path.join(__dirname, 'capture-startup.cjs'), ready.url, output], {
        encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_MODULE: mock, CHROMIUM_PATH: mock,
          RPC_AB_HOST_READY: relayFile, CAPTURE_PROFILE: path.join(dir, 'profile'),
          CAPTURE_CLIENT_PATH: 'offline mock', CAPTURE_SECONDS: '360', CAPTURE_RUNS: '3',
          READY_SELECTOR: '', HEADED: '0', TEST_CALLS: path.join(dir, 'calls') },
      });
      assert.equal(result.status, 0, result.stderr);
      for (let run = 1; run <= 3; run++) {
        const manifest = JSON.parse(fs.readFileSync(path.join(output, `run-${run}-manifest.json`)));
        assert.deepEqual(manifest.host, relay);
        assert.equal(manifest.browserComplete, true);
      }
    }
    assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'),
      'warmup\nreload\nreload\nreload\nwarmup\nreload\nreload\nreload\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
