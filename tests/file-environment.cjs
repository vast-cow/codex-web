const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the shipped hosted-file adapter, without starting Electron or cloud services.
const source = fs.readFileSync('scratch/asar/.vite/build/main-CqEoQDOU.js', 'utf8');
const methodStart = source.indexOf('    async readFile(e) {\n      mg(e.environmentId);');
const methodEnd = source.indexOf('    async getMetadata(e)', methodStart);
const helperStart = source.indexOf('async function pg(e, t) {');
const helperEnd = source.indexOf('var hg =', helperStart);
assert.ok(methodStart >= 0 && methodEnd > methodStart && helperStart >= 0 && helperEnd > helperStart,
  'upstream hosted-file adapter must be present');
const Adapter = vm.runInNewContext(`class Adapter {
  constructor(sendRequest) { this.sendRequest = sendRequest; }
${source.slice(methodStart, methodEnd)}
}
${source.slice(helperStart, helperEnd)}
Adapter`, {
  TextDecoder,
  n: { O: () => ({ parse(value) {
    assert.equal(typeof value.dataBase64, 'string');
    return value;
  }}), N: () => {} },
  i: { yn: value => Buffer.from(value, 'base64') },
});

test('hosted file reading preserves the supplied environment and path', async () => {
  const request = { environmentId: 'test-environment', path: '/workspace/example.txt' };
  const adapter = new Adapter(async (method, params) => {
    assert.equal(method, 'fs/readFile');
    assert.equal(params, request);
    return { dataBase64: Buffer.from('example\n').toString('base64') };
  });
  assert.equal((await adapter.readFile(request)).contents, 'example\n');
});

test('missing or empty environments fail before dispatch; remote errors propagate', async () => {
  let calls = 0;
  const adapter = new Adapter(async () => { calls++; throw Error('Unknown environment'); });
  for (const environmentId of [undefined, null, '']) {
    await assert.rejects(adapter.readFile({ environmentId, path: '/file' }), /No executor is attached/);
  }
  assert.equal(calls, 0);
  await assert.rejects(adapter.readFile({ environmentId: 'unknown', path: '/file' }), /Unknown environment/);
  assert.equal(calls, 1);
});
