const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.FRONTEND_URL = 'http://127.0.0.1:4200';
const { createApp } = require('../dist/main');
test('simultaneous registration cannot create duplicate accounts or orphan workspaces', async () => {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    const signup = () => fetch(base + '/api/auth/register', {
      method: 'POST', headers: { Origin: process.env.FRONTEND_URL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Concurrent user', email: 'concurrent@example.test', password: 'An-isolated-test-password' }),
    });
    const responses = await Promise.all([signup(), signup()]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    const { Database } = require('../dist/database');
    const db = app.get(Database);
    assert.equal(db.get('SELECT COUNT(*) total FROM users').total, 1);
    assert.equal(db.get('SELECT COUNT(*) total FROM workspaces').total, 1);
  } finally { await app.close(); }
});
