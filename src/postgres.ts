import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, PoolClient, types } from "pg";
import { schema } from "./schema";
types.setTypeParser(20, (value) => Number(value));

@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;
  readonly schemaName: string;
  readonly ready: Promise<void>;
  private readonly transactionClient = new AsyncLocalStorage<PoolClient>();
  constructor() {
    if (!process.env.DATABASE_URL)
      throw new Error(
        "DATABASE_URL is required. Configure PostgreSQL in the backend environment.",
      );
    this.schemaName = process.env.DATABASE_SCHEMA || "gather";
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schemaName))
      throw new Error("Invalid DATABASE_SCHEMA.");
    const url = new URL(process.env.DATABASE_URL);
    const tls = url.searchParams.get("sslmode") !== "disable";
    url.searchParams.delete("sslmode");
    this.pool = new Pool({
      connectionString: url.toString(),
      ssl: tls ? { rejectUnauthorized: true } : false,
      enableChannelBinding: true,
      max: 10,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
    });
    this.pool.on("error", () =>
      console.error("PostgreSQL pool connection failed."),
    );
    this.ready = this.initialize();
  }
  private async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "gather-schema-" + this.schemaName,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schemaName}"`);
      await client.query(`SET LOCAL search_path TO "${this.schemaName}"`);
      await client.query(schema);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async onModuleInit() {
    await this.ready;
  }
  private prepare(sql: string) {
    let index = 0;
    return sql
      .split(/('(?:''|[^'])*')/g)
      .map((part, i) =>
        i % 2
          ? part
          : part
              .replace(/\?/g, () => "$" + ++index)
              .replace(
                /\b(FROM|JOIN|INTO|UPDATE)\s+(users|sessions|recoveries|workspaces|memberships|invitations|spaces|posts|comments|reactions|bookmarks|conversations|participants|messages|voice_messages|reports|plan_requests|audit)\b/gi,
                (_, keyword, table) =>
                  `${keyword} "${this.schemaName}".${table}`,
              ),
      )
      .join("");
  }
  async query(sql: string, ...params: any[]) {
    await this.ready;
    return (this.transactionClient.getStore() || this.pool).query(
      this.prepare(sql),
      params,
    );
  }
  async get(sql: string, ...params: any[]): Promise<any> {
    return (await this.query(sql, ...params)).rows[0];
  }
  async all(sql: string, ...params: any[]): Promise<any[]> {
    return (await this.query(sql, ...params)).rows;
  }
  async run(sql: string, ...params: any[]) {
    const result = await this.query(
      /^\s*INSERT\b/i.test(sql) ? sql + " RETURNING *" : sql,
      ...params,
    );
    return {
      lastInsertRowid: result.rows[0]?.id,
      changes: result.rowCount || 0,
    };
  }
  async transaction<T>(
    work: () => T | Promise<T>,
    readOnly = false,
  ): Promise<T> {
    await this.ready;
    if (this.transactionClient.getStore()) return work();
    const client = await this.pool.connect();
    try {
      await client.query(
        readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
      // Serializes multi-step quota checks across backend instances.
      if (!readOnly)
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "gather-write-" + this.schemaName,
        ]);
      const result = await this.transactionClient.run(client, work);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async log(workspace: number, user: number, action: string) {
    await this.run(
      "INSERT INTO audit(workspace_id,user_id,action) VALUES(?,?,?)",
      workspace,
      user,
      action,
    );
  }
  async onModuleDestroy() {
    try {
      await this.ready;
    } finally {
      await this.pool.end();
    }
  }
}
