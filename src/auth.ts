import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { Database } from './database';
import {
  cookieName,
  hash,
  parse,
  passwordHash,
  passwordMatches,
  passwordSchema,
  SessionGuard,
  sessionToken,
  text,
  token,
} from './security';

@Controller('auth')
export class AuthController {
  constructor(private db: Database) {}
  private session(userId: number, res: Response) {
    this.db.run('DELETE FROM sessions WHERE expires<=?', Date.now());
    const raw = token();
    this.db.run(
      'INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)',
      hash(raw),
      userId,
      Date.now() + 7 * 86400000,
    );
    res.cookie(cookieName, raw, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 86400000,
      path: '/api',
    });
  }
  @Post('register')
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = parse(
      z.object({
        name: text(80),
        email: z
          .string()
          .trim()
          .email()
          .max(150)
          .transform((s) => s.toLowerCase()),
        password: passwordSchema,
        workspaceName: text(60).optional(),
        invitation: z.string().max(100).optional(),
      }),
      body,
    );
    if (this.db.get('SELECT id FROM users WHERE email=?', data.email))
      throw new ConflictException(
        'An account with this email already exists. Sign in instead.',
      );
    const secret = await passwordHash(data.password);
    const id = this.db.transaction(() => {
      if (this.db.get('SELECT id FROM users WHERE email=?', data.email)) {
        throw new ConflictException('An account with this email already exists. Sign in instead.');
      }
      const id = Number(
        this.db.run(
          'INSERT INTO users(name,email,password) VALUES(?,?,?)',
          data.name,
          data.email,
          secret,
        ).lastInsertRowid,
      );
      if (data.invitation) this.accept(id, data.email, data.invitation);
      else {
        const workspace = Number(
          this.db.run(
            'INSERT INTO workspaces(name,owner_id) VALUES(?,?)',
            data.workspaceName || `${data.name.split(' ')[0]}'s community`,
            id,
          ).lastInsertRowid,
        );
        this.db.run(
          "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,'owner')",
          workspace,
          id,
        );
        this.db.run(
          "INSERT INTO spaces(workspace_id,name,description) VALUES(?,'General','A place for everyone in your community.')",
          workspace,
        );
        this.db.log(workspace, id, 'Created the workspace');
      }
      return id;
    });
    this.session(id, res);
    return { id, name: data.name, email: data.email };
  }
  @Post('login')
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = parse(
      z.object({
        email: z
          .string()
          .trim()
          .email()
          .transform((s) => s.toLowerCase()),
        password: z.string().max(128),
      }),
      body,
    );
    const user = this.db.get('SELECT * FROM users WHERE email=?', data.email);
    // Run a password derivation even for unknown accounts to reduce account enumeration by timing.
    const matches = await passwordMatches(
      data.password,
      user?.password || '00000000000000000000000000000000:' + '00'.repeat(64),
    );
    if (!user || !matches)
      throw new UnauthorizedException('Email or password is incorrect.');
    this.session(user.id, res);
    return { id: user.id, name: user.name, email: user.email };
  }
  @UseGuards(SessionGuard) @Get('me') me(@Req() req: any) {
    return req.user;
  }
  @Post('recover') async recover(@Body() body: unknown) {
    const data = parse(
      z.object({ token: text(100), password: passwordSchema }),
      body,
    );
    const recovery = this.db.get(
      'SELECT * FROM recoveries WHERE hash=? AND expires>?',
      hash(data.token),
      Date.now(),
    );
    if (!recovery)
      throw new UnauthorizedException(
        'This recovery link is expired or invalid.',
      );
    const secret = await passwordHash(data.password);
    this.db.transaction(() => {
      const current = this.db.get(
        'SELECT * FROM recoveries WHERE hash=? AND expires>?',
        hash(data.token),
        Date.now(),
      );
      if (!current)
        throw new UnauthorizedException(
          'This recovery link is expired or invalid.',
        );
      this.db.run(
        'UPDATE users SET password=? WHERE id=?',
        secret,
        current.user_id,
      );
      this.db.run('DELETE FROM sessions WHERE user_id=?', current.user_id);
      this.db.run('DELETE FROM recoveries WHERE user_id=?', current.user_id);
    });
    return { ok: true };
  }
  @UseGuards(SessionGuard) @Get('export') export(@Req() req: any) {
    return {
      profile: req.user,
      memberships: this.db.all(
        'SELECT w.id,w.name,m.role,m.status FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=?',
        req.user.id,
      ),
      posts: this.db.all(
        'SELECT id,workspace_id,body,created FROM posts WHERE user_id=?',
        req.user.id,
      ),
      comments: this.db.all(
        'SELECT id,post_id,body,created FROM comments WHERE user_id=?',
        req.user.id,
      ),
      messages: this.db.all(
        'SELECT id,conversation_id,body,created FROM messages WHERE user_id=?',
        req.user.id,
      ),
    };
  }
  @Post('logout') logout(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.db.run('DELETE FROM sessions WHERE hash=?', hash(sessionToken(req)));
    res.clearCookie(cookieName, {
      path: '/api',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    return { ok: true };
  }
  @UseGuards(SessionGuard) @Post('profile') profile(
    @Req() req: any,
    @Body() body: unknown,
  ) {
    const data = parse(z.object({ name: text(80) }), body);
    this.db.run('UPDATE users SET name=? WHERE id=?', data.name, req.user.id);
    return { ...req.user, name: data.name };
  }
  @UseGuards(SessionGuard) @Post('password') async password(
    @Req() req: any,
    @Body() body: unknown,
  ) {
    const data = parse(
      z.object({ current: z.string().max(128), password: passwordSchema }),
      body,
    );
    const user = this.db.get(
      'SELECT password FROM users WHERE id=?',
      req.user.id,
    );
    if (!(await passwordMatches(data.current, user.password)))
      throw new BadRequestException('Current password is incorrect.');
    const secret = await passwordHash(data.password);
    this.db.transaction(() => {
      this.db.run(
        'UPDATE users SET password=? WHERE id=?',
        secret,
        req.user.id,
      );
      this.db.run(
        'DELETE FROM sessions WHERE user_id=? AND hash!=?',
        req.user.id,
        hash(sessionToken(req)),
      );
    });
    return { ok: true };
  }
  private accept(user: number, email: string, raw: string) {
    const invite = this.db.get(
      'SELECT * FROM invitations WHERE hash=? AND expires>?',
      hash(raw),
      Date.now(),
    );
    if (!invite || invite.email !== email)
      throw new UnauthorizedException(
        'This invitation is expired, invalid, or for a different email address.',
      );
    const ws = this.db.get(
      'SELECT plan FROM workspaces WHERE id=?',
      invite.workspace_id,
    );
    const counts = this.db.get(
      'SELECT COUNT(*) total FROM memberships WHERE workspace_id=?',
      invite.workspace_id,
    );
    const limit =
      ({ trial: 10, starter: 100, growth: 500 } as Record<string, number>)[
        ws.plan
      ] || 10;
    const existing = this.db.get(
      'SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=?',
      invite.workspace_id,
      user,
    );
    if (!existing && counts.total >= limit)
      throw new ConflictException(
        'This workspace has reached its member limit. Ask its owner to upgrade.',
      );
    this.db.run(
      'INSERT OR IGNORE INTO memberships(workspace_id,user_id,role) VALUES(?,?,?)',
      invite.workspace_id,
      user,
      invite.role,
    );
    this.db.run('DELETE FROM invitations WHERE hash=?', invite.hash);
    this.db.log(invite.workspace_id, user, 'Accepted a workspace invitation');
  }
  @UseGuards(SessionGuard) @Post('accept-invitation') acceptInvitation(
    @Req() req: any,
    @Body() body: unknown,
  ) {
    const data = parse(z.object({ token: text(100) }), body);
    this.db.transaction(() =>
      this.accept(req.user.id, req.user.email, data.token),
    );
    return { ok: true };
  }
}
