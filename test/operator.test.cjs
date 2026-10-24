require("reflect-metadata");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Database } = require("../dist/database");
const { mkdtempSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, sep } = require("node:path");
const { spawnSync } = require("node:child_process");
require("./test-database.cjs")("operator");

test("operator tools verify activation, protect recovery, and restore a PostgreSQL snapshot", async () => {
  const folder = mkdtempSync(join(tmpdir(), "gather-operator-test-"));
  const db = new Database();
  const run = (script, ...args) =>
    spawnSync(
      process.execPath,
      [join(__dirname, "..", "scripts", script), ...args],
      { encoding: "utf8", env: process.env },
    );
  try {
    const user = Number(
      (
        await db.run(
          "INSERT INTO users(name,email,password) VALUES(?,?,?)",
          "Operator Test",
          "operator@example.test",
          "a-test-hash",
        )
      ).lastInsertRowid,
    );
    const workspace = Number(
      (
        await db.run(
          "INSERT INTO workspaces(name,owner_id) VALUES(?,?)",
          "Operator fixture",
          user,
        )
      ).lastInsertRowid,
    );
    const request = Number(
      (
        await db.run(
          "INSERT INTO plan_requests(workspace_id,user_id,plan,note) VALUES(?,?,?,?)",
          workspace,
          user,
          "starter",
          "A disposable test invoice request",
        )
      ).lastInsertRowid,
    );
    assert.equal(run("plans.cjs", "activate", String(request)).status, 1);
    assert.equal(
      (await db.get("SELECT plan FROM workspaces WHERE id=?", workspace)).plan,
      "trial",
    );
    assert.equal(
      run("plans.cjs", "activate", String(request), "--confirm-invoiced")
        .status,
      0,
    );
    assert.equal(
      (await db.get("SELECT plan FROM workspaces WHERE id=?", workspace)).plan,
      "starter",
    );
    assert.equal(
      run("account.cjs", "recovery", "operator@example.test").status,
      1,
    );
    assert.equal(
      run(
        "account.cjs",
        "recovery",
        "operator@example.test",
        "--identity-verified",
      ).status,
      0,
    );
    assert.equal(
      (
        await db.get(
          "SELECT COUNT(*) total FROM recoveries WHERE user_id=?",
          user,
        )
      ).total,
      1,
    );
    const backupPath = join(folder, "backup.json");
    assert.equal(run("backup.cjs", backupPath).status, 0);
    assert.equal(
      JSON.parse(readFileSync(backupPath, "utf8")).tables.workspaces[0].name,
      "Operator fixture",
    );
    assert.equal(
      run("restore.cjs", backupPath).status,
      1,
      "Refuses to overwrite a populated schema",
    );
    const original = process.env.DATABASE_SCHEMA;
    const restoredSchema = original + "_restore";
    process.env.DATABASE_SCHEMA = restoredSchema;
    const backup = new Database();
    try {
      await backup.ready;
      const restored = run("restore.cjs", backupPath);
      assert.equal(restored.status, 0, restored.stderr);
      assert.equal(
        (await backup.get("SELECT name FROM workspaces WHERE id=?", workspace))
          .name,
        "Operator fixture",
      );
    } finally {
      if (
        backup.schemaName !== original + "_restore" ||
        !original.startsWith("gather_test_operator_")
      )
        throw Error("Unsafe restore test cleanup");
      await backup.pool.query(`DROP SCHEMA "${restoredSchema}" CASCADE`);
      await backup.onModuleDestroy();
      process.env.DATABASE_SCHEMA = original;
    }
  } finally {
    await db.onModuleDestroy();
    if (
      !resolve(folder).startsWith(resolve(tmpdir()) + sep) ||
      !folder.includes("gather-operator-test-")
    )
      throw Error("Unsafe test cleanup path");
    rmSync(folder, { recursive: true, force: true });
  }
});
