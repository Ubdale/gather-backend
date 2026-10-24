import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  CanActivate,
  ExecutionContext,
} from "@nestjs/common";
import { z } from "zod";
import { Database } from "./database";
import { hash, idSchema, parse, SessionGuard, text, token } from "./security";

export const plans = {
  trial: { name: "Pilot", price: 0, members: 10, spaces: 3 },
  starter: { name: "Starter", price: 49, members: 100, spaces: 10 },
  growth: { name: "Growth", price: 149, members: 500, spaces: 50 },
};
const roleSchema = z.enum(["admin", "moderator", "member"]);
const takeId = (value: unknown) => parse(idSchema, value);

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private db: Database) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const id = takeId(req.params.workspaceId);
    const membership = await this.db.get(
      "SELECT w.*,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=? AND m.status='active'",
      id,
      req.user.id,
    );
    if (!membership)
      throw new ForbiddenException("You do not have access to this workspace.");
    req.workspace = membership;
    return true;
  }
}

@UseGuards(SessionGuard)
@Controller("workspaces")
export class WorkspacesController {
  constructor(private db: Database) {}
  @Get() list(@Req() req: any) {
    return this.db.all(
      "SELECT w.id,w.name,w.accent,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? AND m.status='active' ORDER BY w.id",
      req.user.id,
    );
  }
  @Post() async create(@Req() req: any, @Body() body: unknown) {
    const data = parse(z.object({ name: text(60) }), body);
    if (
      (
        await this.db.get(
          "SELECT COUNT(*) total FROM workspaces WHERE owner_id=?",
          req.user.id,
        )
      ).total >= 5
    )
      throw new ConflictException(
        "You can own up to five workspaces. Contact support for an agency arrangement.",
      );
    return this.db.transaction(async () => {
      const id = Number(
        (
          await this.db.run(
            "INSERT INTO workspaces(name,owner_id) VALUES(?,?)",
            data.name,
            req.user.id,
          )
        ).lastInsertRowid,
      );
      await this.db.run(
        "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,'owner')",
        id,
        req.user.id,
      );
      await this.db.run(
        "INSERT INTO spaces(workspace_id,name,description) VALUES(?,'General','A place for everyone.')",
        id,
      );
      await this.db.log(id, req.user.id, "Created the workspace");
      return { id };
    });
  }
}

@UseGuards(SessionGuard, WorkspaceGuard)
@Controller("workspaces/:workspaceId")
export class CommunityController {
  constructor(private db: Database) {}
  private staff(req: any, roles = ["owner", "admin", "moderator"]) {
    if (!roles.includes(req.workspace.role))
      throw new ForbiddenException("Your role cannot perform this action.");
  }
  private async post(req: any, value: unknown, staff = false) {
    const post = await this.db.get(
      "SELECT * FROM posts WHERE id=? AND workspace_id=?",
      takeId(value),
      req.workspace.id,
    );
    if (!post || (post.hidden && !staff))
      throw new NotFoundException("Post not found.");
    return post;
  }
  private async conversation(req: any, value: unknown) {
    const id = takeId(value);
    if (
      !(await this.db.get(
        "SELECT c.id FROM conversations c JOIN participants p ON p.conversation_id=c.id WHERE c.id=? AND c.workspace_id=? AND p.user_id=?",
        id,
        req.workspace.id,
        req.user.id,
      ))
    )
      throw new NotFoundException("Conversation not found.");
    return id;
  }
  @Get() async bootstrap(@Req() req: any) {
    const ws = req.workspace;
    const isAdmin = ["owner", "admin"].includes(ws.role);
    return {
      id: ws.id,
      name: ws.name,
      tagline: ws.tagline,
      accent: ws.accent,
      role: ws.role,
      plan: ws.plan,
      limits: plans[ws.plan as keyof typeof plans],
      plans,
      spaces: await this.db.all(
        "SELECT * FROM spaces WHERE workspace_id=? ORDER BY id",
        ws.id,
      ),
      members: await this.db.all(
        `SELECT u.id,u.name,${isAdmin ? "u.email," : ""}m.role,m.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.name`,
        ws.id,
      ),
      counts: {
        posts: (
          await this.db.get(
            "SELECT COUNT(*) total FROM posts WHERE workspace_id=? AND hidden=0",
            ws.id,
          )
        ).total,
        members: (
          await this.db.get(
            "SELECT COUNT(*) total FROM memberships WHERE workspace_id=? AND status='active'",
            ws.id,
          )
        ).total,
        reports: ["owner", "admin", "moderator"].includes(ws.role)
          ? (
              await this.db.get(
                "SELECT COUNT(*) total FROM reports WHERE workspace_id=? AND status='open'",
                ws.id,
              )
            ).total
          : 0,
      },
    };
  }
  @Patch() async branding(@Req() req: any, @Body() body: unknown) {
    this.staff(req, ["owner", "admin"]);
    const data = parse(
      z.object({
        name: text(60),
        tagline: text(120),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
      body,
    );
    await this.db.run(
      "UPDATE workspaces SET name=?,tagline=?,accent=? WHERE id=?",
      data.name,
      data.tagline,
      data.accent,
      req.workspace.id,
    );
    await this.db.log(
      req.workspace.id,
      req.user.id,
      "Updated workspace branding",
    );
    return { ok: true };
  }
  @Post("spaces") async createSpace(@Req() req: any, @Body() body: unknown) {
    this.staff(req, ["owner", "admin"]);
    const data = parse(
      z.object({
        name: text(45),
        description: z.string().trim().max(200).default(""),
      }),
      body,
    );
    const ws = req.workspace;
    if (
      (
        await this.db.get(
          "SELECT COUNT(*) total FROM spaces WHERE workspace_id=? AND archived=0",
          ws.id,
        )
      ).total >= plans[ws.plan as keyof typeof plans].spaces
    )
      throw new ConflictException(
        "Your plan has reached its active space limit. Archive a space or request an upgrade.",
      );
    if (
      await this.db.get(
        "SELECT id FROM spaces WHERE workspace_id=? AND lower(name)=lower(?)",
        ws.id,
        data.name,
      )
    )
      throw new ConflictException("A space with that name already exists.");
    const id = Number(
      (
        await this.db.run(
          "INSERT INTO spaces(workspace_id,name,description) VALUES(?,?,?)",
          ws.id,
          data.name,
          data.description,
        )
      ).lastInsertRowid,
    );
    await this.db.log(ws.id, req.user.id, `Created space: ${data.name}`);
    return { id };
  }
  @Patch("spaces/:id") async archiveSpace(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    this.staff(req, ["owner", "admin"]);
    const data = parse(z.object({ archived: z.boolean() }), body);
    const space = await this.db.get(
      "SELECT * FROM spaces WHERE id=? AND workspace_id=?",
      takeId(id),
      req.workspace.id,
    );
    if (!space) throw new NotFoundException("Space not found.");
    if (
      data.archived &&
      (
        await this.db.get(
          "SELECT COUNT(*) total FROM spaces WHERE workspace_id=? AND archived=0",
          req.workspace.id,
        )
      ).total <= 1
    )
      throw new ConflictException("Keep at least one active space.");
    if (
      !data.archived &&
      space.archived &&
      (
        await this.db.get(
          "SELECT COUNT(*) total FROM spaces WHERE workspace_id=? AND archived=0",
          req.workspace.id,
        )
      ).total >= plans[req.workspace.plan as keyof typeof plans].spaces
    )
      throw new ConflictException("Active space limit reached.");
    await this.db.run(
      "UPDATE spaces SET archived=? WHERE id=?",
      Number(data.archived),
      space.id,
    );
    await this.db.log(
      req.workspace.id,
      req.user.id,
      `${data.archived ? "Archived" : "Restored"} space: ${space.name}`,
    );
    return { ok: true };
  }
  @Post("invitations") async invite(@Req() req: any, @Body() body: unknown) {
    this.staff(req, ["owner", "admin"]);
    const data = parse(
      z.object({
        email: z
          .string()
          .trim()
          .email()
          .max(150)
          .transform((s) => s.toLowerCase()),
        role: roleSchema,
      }),
      body,
    );
    if (data.role === "admin" && req.workspace.role !== "owner")
      throw new ForbiddenException("Only the owner can invite administrators.");
    const member = await this.db.get(
      "SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=? AND m.workspace_id=?",
      data.email,
      req.workspace.id,
    );
    if (member)
      throw new ConflictException("This person is already a workspace member.");
    const used = (
      await this.db.get(
        "SELECT COUNT(*) total FROM memberships WHERE workspace_id=?",
        req.workspace.id,
      )
    ).total;
    if (used >= plans[req.workspace.plan as keyof typeof plans].members)
      throw new ConflictException("Your plan member limit has been reached.");
    const raw = token();
    await this.db.run(
      "DELETE FROM invitations WHERE workspace_id=? AND email=?",
      req.workspace.id,
      data.email,
    );
    await this.db.run(
      "INSERT INTO invitations(hash,workspace_id,email,role,expires) VALUES(?,?,?,?,?)",
      hash(raw),
      req.workspace.id,
      data.email,
      data.role,
      Date.now() + 7 * 86400000,
    );
    await this.db.log(req.workspace.id, req.user.id, "Created an invitation");
    return {
      token: raw,
      url: `${process.env.FRONTEND_URL || "http://127.0.0.1:4200"}/join?token=${raw}`,
      expiresInDays: 7,
    };
  }
  @Get("invitations") invites(@Req() req: any) {
    this.staff(req, ["owner", "admin"]);
    return this.db.all(
      "SELECT email,role,expires FROM invitations WHERE workspace_id=? AND expires>? ORDER BY created DESC",
      req.workspace.id,
      Date.now(),
    );
  }
  @Delete("invitations") async revokeInvite(
    @Req() req: any,
    @Body() body: unknown,
  ) {
    this.staff(req, ["owner", "admin"]);
    const data = parse(z.object({ email: z.string().email() }), body);
    await this.db.run(
      "DELETE FROM invitations WHERE workspace_id=? AND email=?",
      req.workspace.id,
      data.email,
    );
    await this.db.log(req.workspace.id, req.user.id, "Revoked an invitation");
    return { ok: true };
  }
  @Patch("members/:id") async member(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    this.staff(req, ["owner", "admin"]);
    const data = parse(
      z.object({ role: roleSchema, status: z.enum(["active", "suspended"]) }),
      body,
    );
    const member = await this.db.get(
      "SELECT * FROM memberships WHERE workspace_id=? AND user_id=?",
      req.workspace.id,
      takeId(id),
    );
    if (!member) throw new NotFoundException("Member not found.");
    if (member.role === "owner" || member.user_id === req.user.id)
      throw new ForbiddenException(
        "You cannot change the owner or your own access.",
      );
    if (
      req.workspace.role !== "owner" &&
      (data.role === "admin" || member.role === "admin")
    )
      throw new ForbiddenException("Only the owner can manage administrators.");
    await this.db.run(
      "UPDATE memberships SET role=?,status=? WHERE workspace_id=? AND user_id=?",
      data.role,
      data.status,
      req.workspace.id,
      member.user_id,
    );
    await this.db.log(
      req.workspace.id,
      req.user.id,
      `Updated member ${member.user_id}: ${data.role}, ${data.status}`,
    );
    return { ok: true };
  }
  @Get("posts") async posts(@Req() req: any, @Query() query: any) {
    const data = parse(
      z.object({
        before: idSchema.optional(),
        space: idSchema.optional(),
        saved: z.enum(["true", "false"]).optional(),
        mine: z.enum(["true", "false"]).optional(),
        search: z.string().max(100).optional(),
      }),
      query,
    );
    const values: any[] = [req.user.id, req.user.id, req.workspace.id];
    let where = "p.workspace_id=? AND p.hidden=0";
    if (data.before) {
      where += " AND p.id<?";
      values.push(data.before);
    }
    if (data.space) {
      where += " AND p.space_id=?";
      values.push(data.space);
    }
    if (data.mine === "true") {
      where += " AND p.user_id=?";
      values.push(req.user.id);
    }
    if (data.saved === "true") where += " AND b.user_id IS NOT NULL";
    if (data.search) {
      where +=
        " AND (strpos(lower(p.body),lower(?))>0 OR strpos(lower(u.name),lower(?))>0)";
      values.push(data.search, data.search);
    }
    const rows = await this.db.all(
      `SELECT p.*,u.name author,s.name space_name,CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END liked,CASE WHEN b.user_id IS NULL THEN 0 ELSE 1 END saved,(SELECT COUNT(*) FROM reactions WHERE post_id=p.id) likes,(SELECT COUNT(*) FROM comments WHERE post_id=p.id) comment_count FROM posts p JOIN users u ON u.id=p.user_id JOIN spaces s ON s.id=p.space_id LEFT JOIN reactions r ON r.post_id=p.id AND r.user_id=? LEFT JOIN bookmarks b ON b.post_id=p.id AND b.user_id=? WHERE ${where} ORDER BY p.id DESC LIMIT 31`,
      ...values,
    );
    const items = await Promise.all(
      rows.slice(0, 30).map(async (p) => ({
        ...p,
        comments: (
          await this.db.all(
            "SELECT c.*,u.name author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id DESC LIMIT 50",
            p.id,
          )
        ).reverse(),
      })),
    );
    return { items, hasMore: rows.length > 30, nextCursor: items.at(-1)?.id };
  }
  @Post("posts") async publish(@Req() req: any, @Body() body: unknown) {
    const data = parse(z.object({ body: text(5000), spaceId: idSchema }), body);
    if (
      !(await this.db.get(
        "SELECT id FROM spaces WHERE id=? AND workspace_id=? AND archived=0",
        data.spaceId,
        req.workspace.id,
      ))
    )
      throw new BadRequestException(
        "Choose an active space in this workspace.",
      );
    const id = Number(
      (
        await this.db.run(
          "INSERT INTO posts(workspace_id,space_id,user_id,body) VALUES(?,?,?,?)",
          req.workspace.id,
          data.spaceId,
          req.user.id,
          data.body,
        )
      ).lastInsertRowid,
    );
    return { id };
  }
  @Patch("posts/:id") async editPost(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const data = parse(z.object({ body: text(5000) }), body);
    const post = await this.post(req, id);
    if (post.user_id !== req.user.id)
      throw new ForbiddenException("You can only edit your own posts.");
    await this.db.run(
      "UPDATE posts SET body=?,updated=CURRENT_TIMESTAMP WHERE id=?",
      data.body,
      post.id,
    );
    return { ok: true };
  }
  @Delete("posts/:id") async deletePost(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const staff = ["owner", "admin", "moderator"].includes(req.workspace.role);
    const post = await this.post(req, id, staff);
    if (post.user_id !== req.user.id && !staff)
      throw new ForbiddenException("You cannot delete this post.");
    await this.db.run("DELETE FROM posts WHERE id=?", post.id);
    await this.db.log(req.workspace.id, req.user.id, `Deleted post ${post.id}`);
    return { ok: true };
  }
  @Post("posts/:id/comments") async comment(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const post = await this.post(req, id);
    const data = parse(z.object({ body: text(1500) }), body);
    const comment = await this.db.run(
      "INSERT INTO comments(post_id,user_id,body) VALUES(?,?,?)",
      post.id,
      req.user.id,
      data.body,
    );
    return { id: Number(comment.lastInsertRowid) };
  }
  @Get("posts/:id/comments") async earlierComments(
    @Req() req: any,
    @Param("id") id: string,
    @Query("before") before?: string,
  ) {
    const post = await this.post(req, id);
    const cursor = before ? takeId(before) : 2147483647;
    const rows = await this.db.all(
      "SELECT c.*,u.name author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? AND c.id<? ORDER BY c.id DESC LIMIT 51",
      post.id,
      cursor,
    );
    const items = rows.slice(0, 50).reverse();
    return { items, hasMore: rows.length > 50, nextCursor: items[0]?.id };
  }
  @Delete("comments/:id") async deleteComment(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const comment = await this.db.get(
      "SELECT c.* FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=? AND p.workspace_id=?",
      takeId(id),
      req.workspace.id,
    );
    if (!comment) throw new NotFoundException("Comment not found.");
    if (comment.user_id !== req.user.id) this.staff(req);
    await this.db.run("DELETE FROM comments WHERE id=?", comment.id);
    return { ok: true };
  }
  @Post("posts/:id/reaction") like(@Req() req: any, @Param("id") id: string) {
    return this.toggle(req, id, "reactions");
  }
  @Post("posts/:id/bookmark") save(@Req() req: any, @Param("id") id: string) {
    return this.toggle(req, id, "bookmarks");
  }
  private async toggle(req: any, id: string, table: "reactions" | "bookmarks") {
    const post = await this.post(req, id);
    const exists = await this.db.get(
      `SELECT user_id FROM ${table} WHERE post_id=? AND user_id=?`,
      post.id,
      req.user.id,
    );
    if (exists)
      await this.db.run(
        `DELETE FROM ${table} WHERE post_id=? AND user_id=?`,
        post.id,
        req.user.id,
      );
    else
      await this.db.run(
        `INSERT INTO ${table}(post_id,user_id) VALUES(?,?)`,
        post.id,
        req.user.id,
      );
    return { active: !exists };
  }
  @Post("posts/:id/report") async report(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const post = await this.post(req, id);
    const data = parse(z.object({ reason: text(500) }), body);
    if (
      await this.db.get(
        "SELECT id FROM reports WHERE post_id=? AND user_id=? AND status='open'",
        post.id,
        req.user.id,
      )
    )
      throw new ConflictException("You already reported this post.");
    await this.db.run(
      "INSERT INTO reports(workspace_id,post_id,user_id,reason) VALUES(?,?,?,?)",
      req.workspace.id,
      post.id,
      req.user.id,
      data.reason,
    );
    return { ok: true };
  }
  @Get("moderation") async moderation(@Req() req: any) {
    this.staff(req);
    return {
      posts: await this.db.all(
        "SELECT p.*,u.name author FROM posts p JOIN users u ON u.id=p.user_id WHERE p.workspace_id=? ORDER BY p.id DESC LIMIT 200",
        req.workspace.id,
      ),
      reports: await this.db.all(
        "SELECT r.*,u.name reporter,p.body FROM reports r JOIN users u ON u.id=r.user_id JOIN posts p ON p.id=r.post_id WHERE r.workspace_id=? ORDER BY r.id DESC LIMIT 200",
        req.workspace.id,
      ),
    };
  }
  @Patch("moderation/:id") async moderate(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    this.staff(req);
    const post = await this.post(req, id, true);
    const data = parse(z.object({ hidden: z.boolean() }), body);
    await this.db.run(
      "UPDATE posts SET hidden=? WHERE id=?",
      Number(data.hidden),
      post.id,
    );
    await this.db.log(
      req.workspace.id,
      req.user.id,
      `${data.hidden ? "Hid" : "Restored"} post ${post.id}`,
    );
    return { ok: true };
  }
  @Patch("reports/:id") async resolveReport(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    this.staff(req);
    const report = await this.db.get(
      "SELECT id FROM reports WHERE id=? AND workspace_id=?",
      takeId(id),
      req.workspace.id,
    );
    if (!report) throw new NotFoundException("Report not found.");
    await this.db.run(
      "UPDATE reports SET status='resolved' WHERE id=?",
      report.id,
    );
    await this.db.log(
      req.workspace.id,
      req.user.id,
      `Resolved report ${report.id}`,
    );
    return { ok: true };
  }
  @Get("audit") audit(@Req() req: any) {
    this.staff(req, ["owner", "admin"]);
    return this.db.all(
      "SELECT a.id,a.action,a.created,u.name actor FROM audit a JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.id DESC LIMIT 100",
      req.workspace.id,
    );
  }
  @Get("conversations") async conversations(@Req() req: any) {
    const items = await this.db.all(
      "SELECT c.id,p.starred,p.last_read FROM conversations c JOIN participants p ON p.conversation_id=c.id WHERE c.workspace_id=? AND p.user_id=? ORDER BY c.id DESC LIMIT 100",
      req.workspace.id,
      req.user.id,
    );
    return (
      await Promise.all(
        items.map(async (c) => ({
          ...c,
          people: await this.db.all(
            "SELECT u.id,u.name,m.status FROM participants p JOIN users u ON u.id=p.user_id JOIN memberships m ON m.user_id=u.id AND m.workspace_id=? WHERE p.conversation_id=? AND p.user_id!=?",
            req.workspace.id,
            c.id,
            req.user.id,
          ),
          last:
            (await this.db.get(
              "SELECT body,created,id FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1",
              c.id,
            )) || null,
          unread: (
            await this.db.get(
              "SELECT COUNT(*) total FROM messages WHERE conversation_id=? AND id>? AND user_id!=?",
              c.id,
              c.last_read,
              req.user.id,
            )
          ).total,
        })),
      )
    ).sort(
      (a, b) =>
        Number(b.starred) - Number(a.starred) ||
        (b.last?.id || 0) - (a.last?.id || 0),
    );
  }
  @Post("conversations") async startConversation(
    @Req() req: any,
    @Body() body: unknown,
  ) {
    const data = parse(z.object({ userId: idSchema }), body);
    if (
      data.userId === req.user.id ||
      !(await this.db.get(
        "SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=? AND status='active'",
        req.workspace.id,
        data.userId,
      ))
    )
      throw new BadRequestException("Choose another active workspace member.");
    const existing = await this.db.get(
      "SELECT c.id FROM conversations c JOIN participants a ON a.conversation_id=c.id AND a.user_id=? JOIN participants b ON b.conversation_id=c.id AND b.user_id=? WHERE c.workspace_id=?",
      req.user.id,
      data.userId,
      req.workspace.id,
    );
    if (existing) return { id: existing.id };
    for (const user of [req.user.id, data.userId]) {
      if (
        (
          await this.db.get(
            "SELECT COUNT(*) total FROM participants p JOIN conversations c ON c.id=p.conversation_id WHERE p.user_id=? AND c.workspace_id=?",
            user,
            req.workspace.id,
          )
        ).total >= 100
      )
        throw new ConflictException(
          "A participant has reached the conversation limit for this workspace.",
        );
    }
    return this.db.transaction(async () => {
      const id = Number(
        (
          await this.db.run(
            "INSERT INTO conversations(workspace_id) VALUES(?)",
            req.workspace.id,
          )
        ).lastInsertRowid,
      );
      await this.db.run(
        "INSERT INTO participants(conversation_id,user_id) VALUES(?,?),(?,?)",
        id,
        req.user.id,
        id,
        data.userId,
      );
      return { id };
    });
  }
  @Get("conversations/:id/messages") async messages(
    @Req() req: any,
    @Param("id") id: string,
    @Query("before") before?: string,
  ) {
    const conversation = await this.conversation(req, id);
    const cursor = before ? takeId(before) : 2147483647;
    const rows = await this.db.all(
      "SELECT m.*,u.name author,v.duration,v.waveform FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN voice_messages v ON v.message_id=m.id WHERE m.conversation_id=? AND m.id<? ORDER BY m.id DESC LIMIT 51",
      conversation,
      cursor,
    );
    const items = rows
      .slice(0, 50)
      .reverse()
      .map((row) => ({
        ...row,
        waveform: row.waveform ? JSON.parse(row.waveform) : null,
      }));
    if (!before && items.length)
      await this.db.run(
        "UPDATE participants SET last_read=GREATEST(last_read,?) WHERE conversation_id=? AND user_id=?",
        items.at(-1).id,
        conversation,
        req.user.id,
      );
    return { items, hasMore: rows.length > 50, nextCursor: items[0]?.id };
  }
  @Post("conversations/:id/messages") async send(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const conversation = await this.conversation(req, id);
    const data = parse(z.object({ body: text(4000) }), body);
    const suspended = await this.db.get(
      "SELECT p.user_id FROM participants p JOIN memberships m ON m.user_id=p.user_id AND m.workspace_id=? WHERE p.conversation_id=? AND m.status='suspended'",
      req.workspace.id,
      conversation,
    );
    if (suspended)
      throw new ForbiddenException(
        "A participant is suspended. This conversation is read-only.",
      );
    const message = await this.db.run(
      "INSERT INTO messages(conversation_id,user_id,body) VALUES(?,?,?)",
      conversation,
      req.user.id,
      data.body,
    );
    await this.db.run(
      "UPDATE participants SET last_read=? WHERE conversation_id=? AND user_id=?",
      Number(message.lastInsertRowid),
      conversation,
      req.user.id,
    );
    return { id: Number(message.lastInsertRowid) };
  }
  @Post("conversations/:id/voice") async sendVoice(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const conversation = await this.conversation(req, id);
    const data = parse(
      z.object({
        audio: z
          .string()
          .min(1)
          .max(2796204)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        mime: z.enum(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]),
        duration: z.number().min(0.1).max(180),
        waveform: z.array(z.number().min(0).max(1)).min(1).max(64),
      }),
      body,
    );
    const audio = Buffer.from(data.audio, "base64");
    const valid =
      data.mime === "audio/webm"
        ? audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
        : data.mime === "audio/ogg"
          ? audio.toString("ascii", 0, 4) === "OggS"
          : data.mime === "audio/mp4"
            ? audio.toString("ascii", 4, 8) === "ftyp"
            : audio.toString("ascii", 0, 4) === "RIFF" &&
              audio.toString("ascii", 8, 12) === "WAVE";
    if (!valid || audio.length < 12 || audio.length > 2 * 1024 * 1024)
      throw new BadRequestException(
        "Use a supported audio recording under 2 MB.",
      );
    if (
      await this.db.get(
        "SELECT p.user_id FROM participants p JOIN memberships m ON m.user_id=p.user_id AND m.workspace_id=? WHERE p.conversation_id=? AND m.status='suspended'",
        req.workspace.id,
        conversation,
      )
    )
      throw new ForbiddenException(
        "A participant is suspended. This conversation is read-only.",
      );
    return this.db.transaction(async () => {
      const used = (
        await this.db.get(
          "SELECT COALESCE(SUM(length(v.audio)),0) total FROM voice_messages v JOIN messages m ON m.id=v.message_id JOIN conversations c ON c.id=m.conversation_id WHERE c.workspace_id=?",
          req.workspace.id,
        )
      ).total;
      const quota =
        req.workspace.plan === "growth"
          ? 1024
          : req.workspace.plan === "starter"
            ? 256
            : 50;
      if (used + audio.length > quota * 1024 * 1024)
        throw new ConflictException(
          "This workspace has reached its voice storage allowance. Contact the workspace owner.",
        );
      const message = Number(
        (
          await this.db.run(
            "INSERT INTO messages(conversation_id,user_id,body) VALUES(?,?,?)",
            conversation,
            req.user.id,
            "Voice message",
          )
        ).lastInsertRowid,
      );
      await this.db.run(
        "INSERT INTO voice_messages(message_id,audio,mime,duration,waveform) VALUES(?,?,?,?,?)",
        message,
        audio,
        data.mime,
        data.duration,
        JSON.stringify(data.waveform),
      );
      await this.db.run(
        "UPDATE participants SET last_read=? WHERE conversation_id=? AND user_id=?",
        message,
        conversation,
        req.user.id,
      );
      return { id: message };
    });
  }
  @Get("conversations/:id/messages/:messageId/audio") async voice(
    @Req() req: any,
    @Param("id") id: string,
    @Param("messageId") messageId: string,
    @Res() res: any,
  ) {
    const conversation = await this.conversation(req, id);
    const row = await this.db.get(
      "SELECT v.audio,v.mime FROM voice_messages v JOIN messages m ON m.id=v.message_id WHERE m.id=? AND m.conversation_id=?",
      takeId(messageId),
      conversation,
    );
    if (!row) throw new NotFoundException("Voice message not found.");
    const audio = Buffer.from(row.audio);
    res.setHeader("Content-Type", row.mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", "inline");
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1]
        ? Number(match[1])
        : match?.[2]
          ? Math.max(0, audio.length - Number(match[2]))
          : NaN;
      const end =
        match?.[1] && match?.[2]
          ? Math.min(Number(match[2]), audio.length - 1)
          : audio.length - 1;
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start > end ||
        start >= audio.length
      )
        return res
          .status(416)
          .set("Content-Range", `bytes */${audio.length}`)
          .end();
      return res
        .status(206)
        .set("Content-Range", `bytes ${start}-${end}/${audio.length}`)
        .send(audio.subarray(start, end + 1));
    }
    return res.send(audio);
  }
  @Patch("conversations/:id") async star(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const conversation = await this.conversation(req, id);
    const data = parse(z.object({ starred: z.boolean() }), body);
    await this.db.run(
      "UPDATE participants SET starred=? WHERE conversation_id=? AND user_id=?",
      Number(data.starred),
      conversation,
      req.user.id,
    );
    return { ok: true };
  }
  @Get("billing") async billing(@Req() req: any) {
    this.staff(req, ["owner", "admin"]);
    return {
      plan: req.workspace.plan,
      plans,
      requests: await this.db.all(
        "SELECT id,plan,note,status,created FROM plan_requests WHERE workspace_id=? ORDER BY id DESC LIMIT 30",
        req.workspace.id,
      ),
    };
  }
  @Post("billing") async requestPlan(@Req() req: any, @Body() body: unknown) {
    this.staff(req, ["owner"]);
    const data = parse(
      z.object({ plan: z.enum(["starter", "growth"]), note: text(1000) }),
      body,
    );
    if (
      await this.db.get(
        "SELECT id FROM plan_requests WHERE workspace_id=? AND status='pending'",
        req.workspace.id,
      )
    )
      throw new ConflictException(
        "You already have a pending plan request. An operator must review it first.",
      );
    await this.db.run(
      "INSERT INTO plan_requests(workspace_id,user_id,plan,note) VALUES(?,?,?,?)",
      req.workspace.id,
      req.user.id,
      data.plan,
      data.note,
    );
    await this.db.log(
      req.workspace.id,
      req.user.id,
      `Requested the ${data.plan} plan`,
    );
    return {
      ok: true,
      message:
        "Plan request recorded for operator review. No charge has been made. Activation requires a separate invoice agreement.",
    };
  }
}
