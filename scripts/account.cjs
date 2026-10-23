require("reflect-metadata");
const { Database } = require("../dist/database");
const { token, hash } = require("../dist/security");
const db = new Database();
try {
  const [command, email, flag] = process.argv.slice(2);
  if (command !== "recovery" || !email || flag !== "--identity-verified")
    throw Error(
      "After verifying the requester through your support process, run: npm run account -- recovery user@example.com --identity-verified",
    );
  const user = db.get(
    "SELECT id FROM users WHERE email=?",
    email.trim().toLowerCase(),
  );
  if (!user) throw Error("Account not found.");
  const raw = token();
  db.transaction(() => {
    db.run("DELETE FROM recoveries WHERE user_id=?", user.id);
    db.run(
      "INSERT INTO recoveries(hash,user_id,expires) VALUES(?,?,?)",
      hash(raw),
      user.id,
      Date.now() + 30 * 60000,
    );
  });
  console.log(
    "Share this one-use link privately with the verified account owner. It expires in 30 minutes:",
  );
  console.log(
    `${process.env.FRONTEND_URL || "http://127.0.0.1:4200"}/recover?token=${raw}`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.onModuleDestroy();
}
