// One-time, non-destructive import. The old SQLite file remains unchanged.
require("reflect-metadata");
const { DatabaseSync } = require("node:sqlite");
const { resolve } = require("node:path");
const { Database } = require("../dist/database");
const tables = [
  "users",
  "sessions",
  "recoveries",
  "workspaces",
  "memberships",
  "invitations",
  "spaces",
  "posts",
  "comments",
  "reactions",
  "bookmarks",
  "conversations",
  "participants",
  "messages",
  "voice_messages",
  "reports",
  "plan_requests",
  "audit",
];
const identities = [
  "users",
  "workspaces",
  "spaces",
  "posts",
  "comments",
  "conversations",
  "messages",
  "reports",
  "plan_requests",
  "audit",
];
async function main() {
  if (!process.argv[2])
    throw Error(
      "Pass the existing SQLite file to import into an empty Gather PostgreSQL schema.",
    );
  const source = new DatabaseSync(resolve(process.argv[2]), { readOnly: true });
  const db = new Database();
  try {
    const totals = await db.transaction(async () => {
      for (const table of tables)
        if ((await db.get(`SELECT COUNT(*) total FROM ${table}`)).total)
          throw Error(
            "Destination Gather schema is not empty. Import cancelled without changing customer data.",
          );
      const totals = {};
      for (const table of tables) {
        const rows = source.prepare(`SELECT * FROM ${table}`).all();
        for (const row of rows) {
          const columns = Object.keys(row);
          const values = columns.map((column) =>
            ["created", "updated"].includes(column) && row[column]
              ? new Date(String(row[column]).replace(" ", "T") + "Z")
              : row[column],
          );
          await db.run(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
            ...values,
          );
        }
        totals[table] = rows.length;
      }
      for (const table of identities)
        await db.query(
          `SELECT setval(pg_get_serial_sequence(?, 'id'),COALESCE(MAX(id),1),COUNT(*)>0) FROM ${table}`,
          `"${db.schemaName}".${table}`,
        );
      return totals;
    });
    console.log("SQLite import committed. Row counts only:", totals);
  } finally {
    source.close();
    await db.onModuleDestroy();
  }
}
main().catch(() => {
  console.error(
    "Import failed. The source file is unchanged; check connectivity and that the target schema is empty.",
  );
  process.exitCode = 1;
});
