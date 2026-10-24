const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.NODE_ENV = "test";
require("./test-database.cjs")("api");
process.env.FRONTEND_URL = "http://127.0.0.1:4200";
const { createApp } = require("../dist/main");

test("Gather API: real multi-user workflows and authorization boundaries", async (t) => {
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  const password = "Gather-test-password-2026";
  class Client {
    cookie = "";
    async call(path, method = "GET", body, origin = true) {
      const response = await fetch(base + "/api/" + path, {
        method,
        headers: {
          ...(origin ? { Origin: process.env.FRONTEND_URL } : {}),
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) this.cookie = setCookie.split(";")[0];
      return {
        status: response.status,
        body: await response.json(),
        cookie: setCookie,
        headers: response.headers,
      };
    }
    async ok(path, method, body) {
      const result = await this.call(path, method, body);
      assert.ok(result.status < 300, JSON.stringify(result.body));
      return result.body;
    }
    async register(name, email, invitation) {
      return this.ok("auth/register", "POST", {
        name,
        email,
        password,
        ...(invitation
          ? { invitation }
          : { workspaceName: name + " community" }),
      });
    }
  }
  const owner = new Client(),
    member = new Client(),
    outsider = new Client(),
    otherOwner = new Client();
  let ws, general, memberUser, outsiderUser, postId, conversation;
  try {
    await t.test("health and plans expose no private data", async () => {
      assert.equal((await owner.ok("health")).status, "ok");
      assert.equal((await owner.ok("plans")).plans.starter.price, 49);
      assert.equal((await owner.call("workspaces")).status, 401);
    });
    await t.test(
      "rejects missing and untrusted origins on writes",
      async () => {
        assert.equal(
          (await owner.call("auth/register", "POST", {}, false)).status,
          403,
        );
        const result = await fetch(base + "/api/auth/register", {
          method: "POST",
          headers: {
            Origin: "https://attacker.invalid",
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        assert.equal(result.status, 403);
      },
    );
    await t.test(
      "registration creates an isolated workspace and an HttpOnly session",
      async () => {
        const result = await owner.call("auth/register", "POST", {
          name: "Owner",
          email: "owner@example.test",
          password,
          workspaceName: "The Collective",
        });
        assert.equal(result.status, 201);
        assert.match(result.cookie, /HttpOnly/);
        assert.match(result.cookie, /SameSite=Lax/);
        assert.equal(result.body.password, undefined);
        ws = (await owner.ok("workspaces"))[0].id;
        const state = await owner.ok(`workspaces/${ws}`);
        general = state.spaces[0].id;
        assert.equal(state.role, "owner");
        assert.equal(state.counts.posts, 0);
        assert.equal(
          (
            await owner.call("auth/register", "POST", {
              name: "Duplicate",
              email: "owner@example.test",
              password,
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      "password validation and sign-in errors are enforced",
      async () => {
        assert.equal(
          (
            await outsider.call("auth/register", "POST", {
              name: "Weak",
              email: "weak@example.test",
              password: "short",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await outsider.call("auth/login", "POST", {
              email: "owner@example.test",
              password: "incorrect",
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      "invitation acceptance checks the email and consumes its token once",
      async () => {
        const invite = await owner.ok(`workspaces/${ws}/invitations`, "POST", {
          email: "member@example.test",
          role: "member",
        });
        assert.equal(
          (
            await outsider.call("auth/register", "POST", {
              name: "Wrong recipient",
              email: "wrong@example.test",
              password,
              invitation: invite.token,
            })
          ).status,
          401,
        );
        memberUser = await member.register(
          "Member",
          "member@example.test",
          invite.token,
        );
        assert.equal((await member.ok(`workspaces/${ws}`)).role, "member");
        assert.equal(
          (
            await member.call("auth/accept-invitation", "POST", {
              token: invite.token,
            })
          ).status,
          401,
        );
        const second = await owner.ok(`workspaces/${ws}/invitations`, "POST", {
          email: "outsider@example.test",
          role: "member",
        });
        outsiderUser = await outsider.register(
          "Third Member",
          "outsider@example.test",
          second.token,
        );
      },
    );
    await t.test(
      "workspace membership is required even when object IDs are known",
      async () => {
        await otherOwner.register("Other Owner", "other@example.test");
        assert.equal((await otherOwner.call(`workspaces/${ws}`)).status, 403);
        assert.equal(
          (
            await otherOwner.call(`workspaces/${ws}/posts`, "POST", {
              body: "Intrusion",
              spaceId: general,
            })
          ).status,
          403,
        );
        assert.equal(
          (await otherOwner.call(`workspaces/${ws}/audit`)).status,
          403,
        );
      },
    );
    await t.test(
      "member role cannot manage members, branding, spaces, moderation, or billing",
      async () => {
        for (const [part, method, body] of [
          ["", "PATCH", { name: "No", tagline: "No", accent: "#123456" }],
          ["spaces", "POST", { name: "No" }],
          ["members/1", "PATCH", { role: "member", status: "suspended" }],
          ["moderation", "GET"],
          ["billing", "POST", { plan: "growth", note: "No" }],
          ["invitations", "POST", { email: "x@example.test", role: "admin" }],
        ]) {
          assert.equal(
            (
              await member.call(
                `workspaces/${ws}${part ? "/" + part : ""}`,
                method,
                body,
              )
            ).status,
            403,
          );
        }
      },
    );
    await t.test(
      "posting, editing, search, comments, reactions, and saved posts persist on the server",
      async () => {
        postId = (
          await member.ok(`workspaces/${ws}/posts`, "POST", {
            body: "A real community update",
            spaceId: general,
          })
        ).id;
        assert.equal(
          (
            await member.call(`workspaces/${ws}/posts`, "POST", {
              body: "   ",
              spaceId: general,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await outsider.call(`workspaces/${ws}/posts/${postId}`, "PATCH", {
              body: "Not mine",
            })
          ).status,
          403,
        );
        await member.ok(`workspaces/${ws}/posts/${postId}`, "PATCH", {
          body: "An updated community post",
        });
        await owner.ok(`workspaces/${ws}/posts/${postId}/comments`, "POST", {
          body: "A thoughtful reply",
        });
        await owner.ok(`workspaces/${ws}/posts/${postId}/reaction`, "POST");
        await owner.ok(`workspaces/${ws}/posts/${postId}/bookmark`, "POST");
        const page = await owner.ok(
          `workspaces/${ws}/posts?saved=true&search=updated`,
        );
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0].likes, 1);
        assert.equal(page.items[0].comment_count, 1);
        assert.equal(page.items[0].comments[0].body, "A thoughtful reply");
        await owner.ok(`workspaces/${ws}/posts/${postId}/reaction`, "POST");
        assert.equal(
          (await owner.ok(`workspaces/${ws}/posts`)).items[0].likes,
          0,
        );
      },
    );
    await t.test(
      "private messages are shared with participants and hidden from other members",
      async () => {
        conversation = (
          await owner.ok(`workspaces/${ws}/conversations`, "POST", {
            userId: memberUser.id,
          })
        ).id;
        assert.equal(
          (
            await owner.ok(`workspaces/${ws}/conversations`, "POST", {
              userId: memberUser.id,
            })
          ).id,
          conversation,
        );
        await owner.ok(
          `workspaces/${ws}/conversations/${conversation}/messages`,
          "POST",
          { body: "A private hello" },
        );
        assert.equal(
          (await member.ok(`workspaces/${ws}/conversations`))[0].unread,
          1,
        );
        const messages = await member.ok(
          `workspaces/${ws}/conversations/${conversation}/messages`,
        );
        assert.equal(messages.items[0].body, "A private hello");
        assert.equal(
          (await member.ok(`workspaces/${ws}/conversations`))[0].unread,
          0,
        );
        assert.equal(
          (
            await outsider.call(
              `workspaces/${ws}/conversations/${conversation}/messages`,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await outsider.call(
              `workspaces/${ws}/conversations/${conversation}/messages`,
              "POST",
              { body: "Intrusion" },
            )
          ).status,
          404,
        );
        await member.ok(
          `workspaces/${ws}/conversations/${conversation}`,
          "PATCH",
          { starred: true },
        );
        assert.equal(
          (await member.ok(`workspaces/${ws}/conversations`))[0].starred,
          1,
        );
      },
    );
    await t.test(
      "voice messages persist bytes, support seeking and remain private",
      async () => {
        const wav = Buffer.alloc(64044);
        wav.write("RIFF");
        wav.writeUInt32LE(wav.length - 8, 4);
        wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(8000, 24);
        wav.writeUInt32LE(16000, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write("data", 36);
        wav.writeUInt32LE(64000, 40);
        const path = `workspaces/${ws}/conversations/${conversation}`;
        const draft = {
          audio: wav.toString("base64"),
          mime: "audio/wav",
          duration: 1,
          waveform: [0.1, 0.3, 0.5, 0.2],
        };
        const sent = await owner.ok(path + "/voice", "POST", draft);
        const received = (await member.ok(path + "/messages")).items.find(
          (m) => m.id === sent.id,
        );
        assert.equal(received.duration, 1);
        assert.deepEqual(received.waveform, draft.waveform);
        assert.equal(received.audio, undefined);
        const url = base + "/api/" + path + `/messages/${sent.id}/audio`;
        const audio = await fetch(url, { headers: { Cookie: member.cookie } });
        assert.equal(audio.status, 200);
        assert.equal(audio.headers.get("content-type"), "audio/wav");
        assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav);
        const range = await fetch(url, {
          headers: { Cookie: member.cookie, Range: "bytes=44-99" },
        });
        assert.equal(range.status, 206);
        assert.equal((await range.arrayBuffer()).byteLength, 56);
        assert.equal(
          (await fetch(url, { headers: { Cookie: outsider.cookie } })).status,
          404,
        );
        assert.equal((await fetch(url)).status, 401);
        assert.equal(
          (
            await owner.call(path + "/voice", "POST", {
              ...draft,
              audio: Buffer.from("not audio at all").toString("base64"),
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await owner.call(path + "/voice", "POST", {
              ...draft,
              duration: 181,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await owner.call(path + "/voice", "POST", {
              ...draft,
              waveform: [2],
            })
          ).status,
          400,
        );
        const huge = Buffer.alloc(2 * 1024 * 1024 + 1);
        wav.copy(huge);
        assert.equal(
          (
            await owner.call(path + "/voice", "POST", {
              ...draft,
              audio: huge.toString("base64"),
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "moderators can hide and restore content, and hidden posts leave the saved feed",
      async () => {
        await member.ok(`workspaces/${ws}/posts/${postId}/report`, "POST", {
          reason: "Please review this test post",
        });
        assert.equal(
          (
            await member.call(
              `workspaces/${ws}/posts/${postId}/report`,
              "POST",
              { reason: "Duplicate" },
            )
          ).status,
          409,
        );
        const reports = await owner.ok(`workspaces/${ws}/moderation`);
        await owner.ok(`workspaces/${ws}/moderation/${postId}`, "PATCH", {
          hidden: true,
        });
        assert.equal(
          (await member.ok(`workspaces/${ws}/posts`)).items.length,
          0,
        );
        assert.equal(
          (await owner.ok(`workspaces/${ws}/posts?saved=true`)).items.length,
          0,
        );
        assert.equal(
          (
            await member.call(
              `workspaces/${ws}/posts/${postId}/comments`,
              "POST",
              { body: "Hidden" },
            )
          ).status,
          404,
        );
        await owner.ok(
          `workspaces/${ws}/reports/${reports.reports[0].id}`,
          "PATCH",
        );
        await owner.ok(`workspaces/${ws}/moderation/${postId}`, "PATCH", {
          hidden: false,
        });
        assert.equal(
          (await member.ok(`workspaces/${ws}/posts`)).items.length,
          1,
        );
      },
    );
    await t.test(
      "space quotas and archive rules are enforced by the API",
      async () => {
        const space = (
          await owner.ok(`workspaces/${ws}/spaces`, "POST", {
            name: "Design",
            description: "Design conversations",
          })
        ).id;
        await owner.ok(`workspaces/${ws}/spaces`, "POST", { name: "Updates" });
        assert.equal(
          (
            await owner.call(`workspaces/${ws}/spaces`, "POST", {
              name: "Over quota",
            })
          ).status,
          409,
        );
        await owner.ok(`workspaces/${ws}/spaces/${space}`, "PATCH", {
          archived: true,
        });
        assert.equal(
          (
            await member.call(`workspaces/${ws}/posts`, "POST", {
              body: "Archived",
              spaceId: space,
            })
          ).status,
          400,
        );
        await owner.ok(`workspaces/${ws}/spaces/${space}`, "PATCH", {
          archived: false,
        });
        const state = await owner.ok(`workspaces/${ws}`);
        for (const s of state.spaces.slice(1))
          await owner.ok(`workspaces/${ws}/spaces/${s.id}`, "PATCH", {
            archived: true,
          });
        assert.equal(
          (
            await owner.call(`workspaces/${ws}/spaces/${general}`, "PATCH", {
              archived: true,
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      "owner access is protected and suspension applies to existing sessions immediately",
      async () => {
        const user = await owner.ok("auth/me");
        assert.equal(
          (
            await owner.call(`workspaces/${ws}/members/${user.id}`, "PATCH", {
              role: "member",
              status: "suspended",
            })
          ).status,
          403,
        );
        await owner.ok(`workspaces/${ws}/members/${memberUser.id}`, "PATCH", {
          role: "member",
          status: "suspended",
        });
        assert.equal((await member.call(`workspaces/${ws}`)).status, 403);
        assert.equal(
          (
            await owner.call(
              `workspaces/${ws}/conversations/${conversation}/messages`,
              "POST",
              { body: "Should not send" },
            )
          ).status,
          403,
        );
        await owner.ok(`workspaces/${ws}/members/${memberUser.id}`, "PATCH", {
          role: "member",
          status: "active",
        });
      },
    );
    await t.test(
      "administrators cannot promote themselves or manage peer administrators",
      async () => {
        await owner.ok(`workspaces/${ws}/members/${memberUser.id}`, "PATCH", {
          role: "admin",
          status: "active",
        });
        await owner.ok(`workspaces/${ws}/members/${outsiderUser.id}`, "PATCH", {
          role: "admin",
          status: "active",
        });
        assert.equal(
          (
            await member.call(
              `workspaces/${ws}/members/${outsiderUser.id}`,
              "PATCH",
              { role: "member", status: "active" },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await member.call(`workspaces/${ws}/invitations`, "POST", {
              email: "admin@example.test",
              role: "admin",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "billing is a recorded request, not a client-controlled plan upgrade",
      async () => {
        await owner.ok(`workspaces/${ws}/billing`, "POST", {
          plan: "starter",
          note: "Ready to discuss the invoice for our community.",
        });
        assert.equal((await owner.ok(`workspaces/${ws}`)).plan, "trial");
        assert.equal(
          (await owner.ok(`workspaces/${ws}/billing`)).requests[0].status,
          "pending",
        );
        assert.equal(
          (
            await owner.call(`workspaces/${ws}/billing`, "POST", {
              plan: "growth",
              note: "Duplicate",
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await owner.call(`workspaces/${ws}`, "PATCH", {
              name: "Still pilot",
              tagline: "Hello",
              accent: "#247461",
              plan: "growth",
            })
          ).status,
          200,
        );
        assert.equal((await owner.ok(`workspaces/${ws}`)).plan, "trial");
      },
    );
    await t.test(
      "branding and audit history reflect real administrative actions",
      async () => {
        await owner.ok(`workspaces/${ws}`, "PATCH", {
          name: "Gather Customers",
          tagline: "A place to grow together.",
          accent: "#345678",
        });
        const state = await owner.ok(`workspaces/${ws}`);
        assert.equal(state.accent, "#345678");
        assert.equal(state.name, "Gather Customers");
        assert.ok(
          (await owner.ok(`workspaces/${ws}/audit`)).some(
            (event) => event.action === "Updated workspace branding",
          ),
        );
      },
    );
    await t.test(
      "post deletion cascades to comments and bookmarks",
      async () => {
        await member.ok(`workspaces/${ws}/posts/${postId}`, "DELETE");
        assert.equal(
          (await owner.ok(`workspaces/${ws}/posts?saved=true`)).items.length,
          0,
        );
        assert.equal(
          (
            await owner.call(
              `workspaces/${ws}/posts/${postId}/reaction`,
              "POST",
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      "password change checks the current password and revokes other sessions",
      async () => {
        const secondSession = new Client();
        await secondSession.ok("auth/login", "POST", {
          email: "owner@example.test",
          password,
        });
        assert.equal(
          (
            await owner.call("auth/password", "POST", {
              current: "wrong",
              password: "An-even-better-password",
            })
          ).status,
          400,
        );
        await owner.ok("auth/password", "POST", {
          current: password,
          password: "An-even-better-password",
        });
        assert.equal((await secondSession.call("auth/me")).status, 401);
        assert.equal((await owner.ok("auth/me")).email, "owner@example.test");
        await owner.ok("auth/logout", "POST");
        assert.equal((await owner.call("auth/me")).status, 401);
      },
    );
    await t.test(
      "personal exports contain only the requesting user’s authored content and no password",
      async () => {
        const data = await member.ok("auth/export");
        assert.equal(data.profile.id, memberUser.id);
        assert.equal(data.profile.password, undefined);
        assert.equal(data.messages.length, 0); // The message in this test was authored by the owner.
      },
    );
    await t.test(
      "recovery tokens are one-use, expire, and revoke all existing sessions",
      async () => {
        const { Database } = require("../dist/database");
        const { hash } = require("../dist/security");
        const db = app.get(Database);
        const recovering = new Client();
        const user = await recovering.register(
          "Recovery User",
          "recovery@example.test",
        );
        const raw = "a-private-one-time-test-recovery-token";
        db.run(
          "INSERT INTO recoveries(hash,user_id,expires) VALUES(?,?,?)",
          hash(raw),
          user.id,
          Date.now() + 30000,
        );
        assert.equal(
          (
            await recovering.call("auth/recover", "POST", {
              token: "wrong",
              password: "A-new-recovery-password",
            })
          ).status,
          401,
        );
        await recovering.ok("auth/recover", "POST", {
          token: raw,
          password: "A-new-recovery-password",
        });
        assert.equal((await recovering.call("auth/me")).status, 401);
        assert.equal(
          (
            await recovering.call("auth/recover", "POST", {
              token: raw,
              password: "Another-new-password",
            })
          ).status,
          401,
        );
        await recovering.ok("auth/login", "POST", {
          email: "recovery@example.test",
          password: "A-new-recovery-password",
        });
        db.run(
          "INSERT INTO recoveries(hash,user_id,expires) VALUES(?,?,?)",
          hash("expired"),
          user.id,
          Date.now() - 1000,
        );
        assert.equal(
          (
            await recovering.call("auth/recover", "POST", {
              token: "expired",
              password: "Another-new-password",
            })
          ).status,
          401,
        );
      },
    );
  } finally {
    await app.close();
  }
});

test("PostgreSQL data survives a pool close and reopen", async () => {
  const { Database } = require("../dist/database");
  {
    const first = new Database();
    await first.run(
      "INSERT INTO users(name,email,password) VALUES(?,?,?)",
      "Persisted",
      "persist@example.test",
      "a-hashed-test-value",
    );
    await first.onModuleDestroy();
    const second = new Database();
    assert.equal(
      (
        await second.get(
          "SELECT name FROM users WHERE email=?",
          "persist@example.test",
        )
      ).name,
      "Persisted",
    );
    await second.onModuleDestroy();
  }
});
