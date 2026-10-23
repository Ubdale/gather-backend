require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Database } = require('../dist/database');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { spawnSync } = require('node:child_process');

test('operator tools verify activation, protect recovery, and produce a readable backup', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gather-operator-test-'));
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(folder, 'operator.sqlite');
  const db = new Database();
  const run = (script, ...args) => spawnSync(process.execPath, [join(__dirname, '..', 'scripts', script), ...args], { encoding: 'utf8', env: process.env });
  try {
    const user = Number(db.run('INSERT INTO users(name,email,password) VALUES(?,?,?)', 'Operator Test', 'operator@example.test', 'a-test-hash').lastInsertRowid);
    const workspace = Number(db.run('INSERT INTO workspaces(name,owner_id) VALUES(?,?)', 'Operator fixture', user).lastInsertRowid);
    const request = Number(db.run('INSERT INTO plan_requests(workspace_id,user_id,plan,note) VALUES(?,?,?,?)', workspace, user, 'starter', 'A disposable test invoice request').lastInsertRowid);
    assert.equal(run('plans.cjs', 'activate', String(request)).status, 1);
    assert.equal(db.get('SELECT plan FROM workspaces WHERE id=?', workspace).plan, 'trial');
    assert.equal(run('plans.cjs', 'activate', String(request), '--confirm-invoiced').status, 0);
    assert.equal(db.get('SELECT plan FROM workspaces WHERE id=?', workspace).plan, 'starter');
    assert.equal(run('account.cjs', 'recovery', 'operator@example.test').status, 1);
    assert.equal(run('account.cjs', 'recovery', 'operator@example.test', '--identity-verified').status, 0);
    assert.equal(db.get('SELECT COUNT(*) total FROM recoveries WHERE user_id=?', user).total, 1);
    const backupPath = join(folder, 'backup.sqlite');
    assert.equal(run('backup.cjs', backupPath).status, 0);
    process.env.DATABASE_PATH = backupPath;
    const backup = new Database();
    assert.equal(backup.get('SELECT name FROM workspaces WHERE id=?', workspace).name, 'Operator fixture');
    backup.onModuleDestroy();
  } finally {
    db.onModuleDestroy();
    process.env.DATABASE_PATH = previous;
    if (!resolve(folder).startsWith(resolve(tmpdir()) + sep) || !folder.includes('gather-operator-test-')) throw Error('Unsafe test cleanup path');
    rmSync(folder, { recursive: true, force: true });
  }
});
