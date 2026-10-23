// Operator-only CLI. Never expose this script as an HTTP endpoint.
require("reflect-metadata");
const { Database } = require("../dist/database");
const { plans } = require("../dist/community");
const db = new Database();
try {
  const [command, rawId, flag] = process.argv.slice(2);
  if (command === "requests") {
    console.table(
      db.all(
        "SELECT r.id,w.name workspace,u.email owner,r.plan,r.status,r.note,r.created FROM plan_requests r JOIN workspaces w ON w.id=r.workspace_id JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 100",
      ),
    );
  } else if (
    ["activate", "decline"].includes(command) &&
    /^\d+$/.test(rawId || "")
  ) {
    const request = db.get(
      "SELECT * FROM plan_requests WHERE id=? AND status='pending'",
      Number(rawId),
    );
    if (!request) throw Error("Pending request not found.");
    if (command === "activate") {
      if (flag !== "--confirm-invoiced")
        throw Error(
          "Arrange and verify payment separately, then pass --confirm-invoiced. This command does not collect payment.",
        );
      if (!plans[request.plan]) throw Error("Unknown plan.");
      const members = db.get(
        "SELECT COUNT(*) total FROM memberships WHERE workspace_id=?",
        request.workspace_id,
      ).total;
      const spaces = db.get(
        "SELECT COUNT(*) total FROM spaces WHERE workspace_id=? AND archived=0",
        request.workspace_id,
      ).total;
      if (
        members > plans[request.plan].members ||
        spaces > plans[request.plan].spaces
      )
        throw Error("Current usage exceeds the requested plan.");
      db.transaction(() => {
        db.run(
          "UPDATE workspaces SET plan=? WHERE id=?",
          request.plan,
          request.workspace_id,
        );
        db.run(
          "UPDATE plan_requests SET status='activated' WHERE id=?",
          request.id,
        );
        db.log(
          request.workspace_id,
          request.user_id,
          `Operator CLI activated the ${request.plan} plan after invoice confirmation`,
        );
      });
      console.log(
        `Activated ${request.plan} for workspace ${request.workspace_id}. No payment was processed by Gather.`,
      );
    } else {
      db.run(
        "UPDATE plan_requests SET status='declined' WHERE id=?",
        request.id,
      );
      db.log(
        request.workspace_id,
        request.user_id,
        "Operator CLI declined the plan request",
      );
      console.log("Request declined.");
    }
  } else {
    console.log(
      "Usage: npm run plan -- requests | activate <requestId> --confirm-invoiced | decline <requestId>",
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.onModuleDestroy();
}
