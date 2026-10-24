require("reflect-metadata");
const { readFile } = require("node:fs/promises");
const { Database } = require("../dist/database");
const { tables, identities } = require("./data-tables.cjs");
async function main() {
  if (!process.argv[2])
    throw Error(
      "Pass a Gather PostgreSQL snapshot filename. The destination schema must be empty.",
    );
  const snapshot = JSON.parse(await readFile(process.argv[2], "utf8"));
  if (
    snapshot.format !== "gather-postgresql-v1" ||
    !tables.every((table) => Array.isArray(snapshot.tables?.[table]))
  )
    throw Error("Unsupported backup format.");
  const db = new Database();
  try {
    await db.transaction(async () => {
      for (const table of tables)
        if ((await db.get(`SELECT COUNT(*) total FROM ${table}`)).total)
          throw Error("Destination is not empty; restore cancelled.");
      for (const table of tables)
        for (const row of snapshot.tables[table]) {
          const columns = Object.keys(row);
          if (!columns.every((column) => /^[a-z_]+$/.test(column)))
            throw Error("Invalid backup column.");
          const values = columns.map((column) =>
            column === "audio" ? Buffer.from(row[column].data) : row[column],
          );
          await db.run(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
            ...values,
          );
        }
      for (const table of identities)
        await db.query(
          `SELECT setval(pg_get_serial_sequence(?, 'id'),COALESCE(MAX(id),1),COUNT(*)>0) FROM ${table}`,
          `"${db.schemaName}".${table}`,
        );
    });
    console.log("PostgreSQL snapshot restored.");
  } finally {
    await db.onModuleDestroy();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
