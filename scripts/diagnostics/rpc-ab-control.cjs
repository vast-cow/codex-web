// Offline validation and serialization for the opt-in startup A/B capture mode.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function validateReady(ready, url, now = Date.now()) {
  assert.equal(ready.confirmation, `HOST READY — ${ready.captureId} — ${ready.configuration}`);
  assert.match(ready.captureId, /^[a-zA-Z0-9_-]+$/);
  assert.ok(['A', 'B'].includes(ready.configuration));
  assert.equal(ready.url, url);
  const age = now - Date.parse(ready.confirmedUTC);
  assert.ok(age >= 0 && age <= 30 * 60 * 1000, 'Host confirmation must be at most 30 minutes old');
  assert.equal(ready.window.minimumBytes, ready.configuration === 'A' ? 65536 : 524288);
  for (const key of ['initialBytes', 'minimumBytes', 'maximumBytes']) {
    assert.ok(Number.isSafeInteger(ready.window[key]) && ready.window[key] > 0, key);
  }
  if (ready.configuration === 'A') {
    assert.equal(ready.window.initialBytes, 262144);
    assert.equal(ready.window.maximumBytes, 1073741824);
  }
  assert.ok(ready.window.maximumBytes >= Math.max(ready.window.minimumBytes, ready.window.initialBytes));
  for (const key of ['source', 'revision', 'processIdentity', 'hostLog', 'resourceCapture', 'baselineLocation']) {
    assert.ok(typeof ready[key] === 'string' && ready[key].trim(), `Missing ${key}`);
  }
  assert.ok(typeof ready.window.clampBehavior === 'string' && ready.window.clampBehavior.trim());
  for (const key of ['hostBundleSha256', 'browserBundleSha256']) assert.match(ready[key], /^[a-f0-9]{64}$/i);
  assert.equal(ready.bootstrapDiagnostics, true);
  assert.equal(ready.rpcDiagnostics, true);
  assert.equal(ready.exclusiveTraffic, true);
  for (const key of ['deploymentAcceptanceSatisfied', 'activeConfigurationVerified', 'rollbackReady']) {
    assert.equal(ready[key], true, `Host must explicitly confirm ${key}`);
  }
  assert.ok(typeof ready.acceptanceEvidence === 'string' && ready.acceptanceEvidence.trim(),
    'Missing host deployment acceptance evidence');
  for (const key of ['identity', 'stopCommand', 'startCommand', 'rollbackCommand']) {
    assert.ok(typeof ready.supervisor?.[key] === 'string' && ready.supervisor[key].trim(),
      `Missing actual supervisor ${key}`);
  }
  for (const key of ['adaptiveFlightLimitBytes', 'rssIncreaseBytes', 'ackP95RegressionPercent',
    'minimumBodyImprovementPercent']) {
    assert.ok(Number.isFinite(ready.safety?.[key]) && ready.safety[key] > 0,
      `Missing approved safety threshold ${key}`);
  }
  for (const key of ['approvalReference', 'flightGuardMode', 'flightScope', 'breachAction', 'queueRule']) {
    assert.ok(typeof ready.safety?.[key] === 'string' && ready.safety[key].trim(),
      `Missing approved safety rule ${key}`);
  }
  return ready;
}

function acquireControl(profile, controls) {
  // Never reclaim a stale lock automatically: its owner may still be capturing.
  const lock = `${profile}.rpc-ab.lock`;
  fs.mkdirSync(path.dirname(profile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedUTC: new Date().toISOString() }));
  fs.closeSync(fd);
  try {
    const file = `${profile}.rpc-ab-controls.json`;
    if (fs.existsSync(file)) assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), controls,
      'A/B capture controls changed; use identical settings');
    else fs.writeFileSync(file, JSON.stringify(controls, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.unlinkSync(lock);
    throw error;
  }
  return () => fs.unlinkSync(lock);
}

module.exports = { validateReady, acquireControl };
