require("reflect-metadata");
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./test-database.cjs")("postgres");
const { Database } = require("../dist/database");
const { parse, idSchema } = require("../dist/security");
test("invalid PostgreSQL identifiers fail validation before reaching SQL", () => {
  for (const value of ["9007199254740991", "0", "-1", "not-an-id"])
    assert.throws(() => parse(idSchema, value));
  assert.equal(parse(idSchema, "2147483647"), 2147483647);
});
test("PostgreSQL parameter binding and transaction rollback preserve isolation", async () => {
  const db = new Database();
  try {
    assert.deepEqual(
      await db.get("SELECT '?' AS literal, ?::text AS value", "a?'b"),
      { literal: "?", value: "a?'b" },
    );
    await assert.rejects(
      db.transaction(async () => {
        await db.run(
          "INSERT INTO users(name,email,password) VALUES(?,?,?)",
          "Rollback",
          "rollback@example.test",
          "hash",
        );
        throw Error("Abort the complete unit of work");
      }),
      /Abort/,
    );
    assert.equal((await db.get("SELECT COUNT(*) total FROM users")).total, 0);
    const events = [];
    await Promise.all(
      [1, 2].map((id) =>
        db.transaction(async () => {
          events.push("start" + id);
          await db.run(
            "INSERT INTO users(name,email,password) VALUES(?,?,?)",
            "Concurrent",
            "transaction" + id + "@example.test",
            "hash",
          );
          events.push("end" + id);
        }),
      ),
    );
    assert.match(
      events.join(","),
      /^start1,end1,start2,end2$|^start2,end2,start1,end1$/,
    );
    assert.equal((await db.get("SELECT COUNT(*) total FROM users")).total, 2);
  } finally {
    await db.onModuleDestroy();
  }
});
