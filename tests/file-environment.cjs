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

const sharedSource = fs.readFileSync('scratch/asar/webview/assets/app-shared-8bd9d0399038.js', 'utf8');
const diagnosticSource = sharedSource.slice(sharedSource.indexOf('async function codexWebReadFileDiagnostic('));
assert.ok(diagnosticSource.startsWith('async function codexWebReadFileDiagnostic('));
function diagnosticReader(warn) {
  return vm.runInNewContext(`${diagnosticSource}\ncodexWebReadFileDiagnostic`, { console: { warn } });
}

test('local path-only reads preserve parameters, receiver and result without logging', async () => {
  const read = diagnosticReader(() => assert.fail('successful reads must not warn'));
  const params = { path: '/private/local' };
  const result = { dataBase64: 'b2s=' };
  const client = { hostId: 'local', async sendRequest(method, value) {
    assert.equal(this, client);
    assert.equal(method, 'fs/readFile');
    assert.equal(value, params);
    return result;
  }};
  assert.equal(await read(client, 'workspace-snapshot', params), result);
});

test('candidate rejections emit only bounded metadata and preserve the original error', async () => {
  for (const callPath of ['pasted-text-registry', 'plugin-inventory', 'workspace-snapshot', '/secret']) {
    const logs = [];
    const read = diagnosticReader((...args) => logs.push(args));
    const error = Error('fs/readFile requires an environmentId');
    await assert.rejects(read({ hostId: 'durable', sendRequest: async () => { throw error; } },
      callPath, { path: '/secret', conversationId: 'secret', credential: 'secret' }), e => e === error);
    assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['[codex-web:file-read]', {
      boundary: 'shared-caller-rejection', callPath: callPath === '/secret' ? 'other' : callPath,
      context: 'hosted', hasEnvironmentId: false,
    }]]);
  }
});

test('unrelated failures and logging failures retain original rejection', async () => {
  for (const message of ['not found', 'fs/readFile requires an environmentId']) {
    const error = Error(message);
    const read = diagnosticReader(() => { throw Error('logger unavailable'); });
    await assert.rejects(read({ sendRequest: async () => { throw error; } }, 'plugin-inventory', {}), e => e === error);
  }
});

test('all three candidate callers use the diagnostic wrapper', () => {
  for (const callPath of ['pasted-text-registry', 'plugin-inventory', 'workspace-snapshot']) {
    assert.ok(sharedSource.includes(`, \`${callPath}\`, {`));
  }
});

test('shared dispatch diagnostics expose presence flags without identifiers', () => {
  const start = sharedSource.indexOf('        createRequest(e, t, n, r = null) {');
  const end = sharedSource.indexOf('          let i = jj(', start);
  const body = sharedSource.slice(start + '        createRequest(e, t, n, r = null) {'.length, end);
  const logs = [];
  const dispatch = vm.runInNewContext(`(function(e, t) { ${body} })`, {
    console: { debug: (...args) => logs.push(args) }, Ufn: value => value?.threadId,
  });
  dispatch.call({ hostId: 'durable' }, 'fs/readFile', { path: '/secret', environmentId: 'secret', threadId: 'secret' });
  dispatch.call({ hostId: 'local' }, 'fs/readFile', { path: '/secret' });
  dispatch.call({ hostId: 'private-host' }, 'other', {});
  assert.deepEqual(JSON.parse(JSON.stringify(logs)), [
    ['[codex-web:file-read]', { boundary: 'shared-client-dispatch', context: 'hosted', hasEnvironmentId: true, hasConversationContext: true }],
    ['[codex-web:file-read]', { boundary: 'shared-client-dispatch', context: 'local', hasEnvironmentId: false, hasConversationContext: false }],
  ]);
});
