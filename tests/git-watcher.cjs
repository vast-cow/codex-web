const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Load the shipped adapter without starting the worker's unrelated services.
// Keep the probe beside worker.js so ESM uses the production resolution paths.
test('extracted Linux adapter delivers Git working-tree changes', {
  skip: process.platform !== 'linux', timeout: 15000,
}, async () => {
  const worker = path.resolve('scratch/asar/.vite/build/worker.js');
  const source = await fs.readFile(worker, 'utf8');
  const start = source.indexOf('async function j9(e, t)');
  const end = source.indexOf('function xRe(', start);
  assert.ok(start >= 0 && end > start, 'upstream watcher adapter must be present');
  const probe = path.join(path.dirname(worker), `.watcher-test-${process.pid}.mjs`);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-web-watcher-'));
  let subscription;
  let timer;
  try {
    await fs.writeFile(probe, `import g from 'node:path';
import * as D from 'node:fs/promises';
function RP() { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; }
${source.slice(start, end)}
export { j9 as watch };
`);
    const { watch } = await import(pathToFileURL(probe).href);
    execFileSync('git', ['init', '--quiet', repo]);
    const file = path.join(repo, 'tracked.txt');
    await fs.writeFile(file, 'before\n');
    execFileSync('git', ['-C', repo, 'add', 'tracked.txt']);
    let notify;
    const changed = new Promise((resolve, reject) => {
      notify = resolve;
      timer = setTimeout(() => reject(new Error('No watcher update delivered')), 10000);
    });
    subscription = await watch({path: repo, onChange(event) {
      if (event.pathChanges?.some(change => change.path === file && change.type === 'update')) notify(event);
    }}, {ignoredPaths: []});
    assert.equal(subscription.coverage.recursive, true);
    await fs.writeFile(file, 'after\n');
    const event = await changed;
    assert.ok(event.changedPaths.includes(file));
    console.log('inotify initialized; tracked file update notification delivered');
  } finally {
    clearTimeout(timer);
    if (subscription) await subscription.dispose();
    await fs.rm(probe, {force: true});
    await fs.rm(repo, {recursive: true, force: true});
  }
});
