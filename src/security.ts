import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { Database } from "./database";
import { z } from "zod";
const scrypt = promisify(scryptCallback);
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return (
    salt + ":" + ((await scrypt(password, salt, 64)) as Buffer).toString("hex")
  );
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, hex] = stored.split(":");
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return result.data;
}
export const passwordSchema = z.string().min(10).max(128);
export const idSchema = z.coerce.number().int().positive().max(2147483647);
export const text = (max: number) => z.string().trim().min(1).max(max);
export const cookieName = "gather_session";
export function sessionToken(request: any): string {
  return (
    String(request.headers.cookie || "")
      .split(";")
      .map((s: string) => s.trim())
      .find((s: string) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) || ""
  );
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private db: Database) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const session = await this.db.get(
      "SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?",
      hash(sessionToken(request)),
      Date.now(),
    );
    if (!session)
      throw new UnauthorizedException("Please sign in to continue.");
    request.user = session;
    return true;
  }
}
