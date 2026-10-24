import "reflect-metadata";
import { Module, Controller, Get } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { WriteTransactionInterceptor } from "./write-transaction";
import { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { json } from "express";
import { Database } from "./database";
import { SessionGuard } from "./security";
import { AuthController } from "./auth";
import {
  CommunityController,
  WorkspacesController,
  WorkspaceGuard,
  plans,
} from "./community";

@Controller()
class PublicController {
  @Get("health") health() {
    return { status: "ok", service: "gather-api" };
  }
  @Get("plans") plans() {
    return {
      plans,
      currency: "USD",
      billing: "Manual invoice after operator review. No automatic charges.",
    };
  }
}
@Module({
  controllers: [
    PublicController,
    AuthController,
    WorkspacesController,
    CommunityController,
  ],
  providers: [
    Database,
    SessionGuard,
    WorkspaceGuard,
    { provide: APP_INTERCEPTOR, useClass: WriteTransactionInterceptor },
  ],
})
export class AppModule {}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.NODE_ENV === "test" ? false : ["error", "warn", "log"],
  });
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.setGlobalPrefix("api");
  app.use(helmet());
  app.use(
    "/api/workspaces/:workspaceId/conversations/:id/voice",
    json({ limit: "3mb" }),
  );
  app.use(json({ limit: "32kb" }));
  const frontend = process.env.FRONTEND_URL || "http://127.0.0.1:4200";
  const allowed = new Set([new URL(frontend).origin]);
  if (process.env.NODE_ENV !== "production") {
    allowed.add("http://localhost:4200");
    allowed.add("http://127.0.0.1:4200");
  }
  app.use((req: any, res: any, next: any) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (!req.headers.origin || !allowed.has(req.headers.origin))
    )
      return res
        .status(403)
        .json({ message: "Request origin is not allowed." });
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: process.env.NODE_ENV === "test" ? 5000 : 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { message: "Too many requests. Please try again in a minute." },
    }),
  );
  app.use(
    "/api/auth/login",
    rateLimit({
      windowMs: 15 * 60000,
      limit: process.env.NODE_ENV === "test" ? 100 : 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        message: "Too many sign-in attempts. Try again in 15 minutes.",
      },
    }),
  );
  app.use(
    "/api/auth/register",
    rateLimit({
      windowMs: 60 * 60000,
      limit: process.env.NODE_ENV === "test" ? 100 : 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { message: "Too many registrations. Try again later." },
    }),
  );
  app.use(
    "/api/auth/recover",
    rateLimit({
      windowMs: 15 * 60000,
      limit: process.env.NODE_ENV === "test" ? 100 : 15,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { message: "Too many recovery attempts. Try again later." },
    }),
  );
  app.enableShutdownHooks();
  return app;
}
if (require.main === module) {
  createApp()
    .then((app) =>
      app.listen(
        Number(process.env.PORT || 3000),
        process.env.HOST || "127.0.0.1",
      ),
    )
    .catch(() => {
      console.error(
        "Gather API failed to start. Check the database path and server configuration.",
      );
      process.exitCode = 1;
    });
}
