const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

test('Vite rejects an occupied configured port and preserves proxy routes', async () => {
  const { resolveConfig, createServer } = await import('vite');
  const config = await resolveConfig({ configFile: 'vite.browser.config.ts' }, 'serve');
  assert.equal(config.server.port, 4173);
  assert.equal(config.server.strictPort, true);
  assert.equal(config.server.proxy['/__backend/ipc'].target, 'ws://127.0.0.1:8214');
  assert.equal(config.server.proxy['/__backend/ipc'].ws, true);
  assert.equal(config.server.proxy['/__backend/upload'].target, 'http://127.0.0.1:8214');
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  let server;
  try {
    const port = blocker.address().port;
    server = await createServer({ configFile: false, server: {
      host: config.server.host, port, strictPort: config.server.strictPort,
    }});
    await assert.rejects(server.listen(), new RegExp(`Port ${port} is already in use`));
  } finally {
    if (server) await server.close();
    await new Promise(resolve => blocker.close(resolve));
  }
});
