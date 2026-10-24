import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { from, lastValueFrom } from "rxjs";
import { Database } from "./database";
import { SessionGuard } from "./security";
import { WorkspaceGuard } from "./community";

// Keep role/participant checks and their writes atomic after moving to async SQL.
@Injectable()
export class WriteTransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionGuard,
    private readonly workspaces: WorkspaceGuard,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const method = context.switchToHttp().getRequest().method;
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return next.handle();
    return from(
      this.db.transaction(async () => {
        // Recheck access after acquiring the write lock, including queued suspensions.
        const req = context.switchToHttp().getRequest();
        if (req.user) await this.sessions.canActivate(context);
        if (req.workspace) await this.workspaces.canActivate(context);
        return lastValueFrom(next.handle());
      }),
    );
  }
}
