require("reflect-metadata");
const { Database } = require("../dist/database");
const { resolve } = require("node:path");
const { writeFile } = require("node:fs/promises");
const { tables } = require("./data-tables.cjs");
async function main() {
  if (!process.argv[2])
    throw Error(
      "Pass a destination filename outside the public web directory.",
    );
  const db = new Database();
  try {
    const data = await db.transaction(async () => {
      const data = {};
      for (const table of tables)
        data[table] = await db.all(`SELECT * FROM ${table}`);
      return data;
    }, true);
    await writeFile(
      resolve(process.argv[2]),
      JSON.stringify({
        format: "gather-postgresql-v1",
        created: new Date().toISOString(),
        tables: data,
      }),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Consistent PostgreSQL snapshot completed, including voice bytes. Treat it as private customer data.",
    );
  } finally {
    await db.onModuleDestroy();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
