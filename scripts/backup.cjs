require("reflect-metadata");
const { Database } = require("../dist/database");
const { backup } = require("node:sqlite");
const { resolve } = require("node:path");
async function main() {
  if (!process.argv[2])
    throw Error(
      "Pass a destination filename outside the public web directory.",
    );
  const db = new Database();
  try {
    await backup(db.connection, resolve(process.argv[2]));
    console.log(
      "Consistent SQLite backup completed. Treat it as private customer data.",
    );
  } finally {
    db.onModuleDestroy();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
