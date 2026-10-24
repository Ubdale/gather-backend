const { after } = require("node:test");
const { randomBytes } = require("node:crypto");
module.exports = function useTestDatabase(label) {
  if (!process.env.TEST_DATABASE_URL)
    throw Error(
      "Set TEST_DATABASE_URL to run PostgreSQL integration tests. Tests use a separate temporary schema.",
    );
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const schema = (process.env.DATABASE_SCHEMA =
    "gather_test_" + label + "_" + randomBytes(6).toString("hex"));
  after(async () => {
    const { Database } = require("../dist/database");
    const db = new Database();
    try {
      await db.ready;
      if (
        db.schemaName !== schema ||
        !/^gather_test_[a-z]+_[0-9a-f]{12}$/.test(schema)
      )
        throw Error("Unsafe test schema cleanup");
      await db.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await db.onModuleDestroy();
    }
  });
};
