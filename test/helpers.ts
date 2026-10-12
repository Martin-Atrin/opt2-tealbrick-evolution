// Test helpers: a migrated node:sqlite database shaped like the SDK's Db, and fake handler contexts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Caller, CompanionResult, Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { migrationsDir } from "../src/app.ts";

export function migratedDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const v = fn();
        raw.exec("COMMIT");
        return v;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return db as unknown as Db;
}

export const AGENT_A: Caller = { type: "agent", id: "agt_01J0000000000000000000000A" as Caller["id"], name: "Agent A", mode: "free" };
export const AGENT_B: Caller = { type: "agent", id: "agt_01J0000000000000000000000B" as Caller["id"], name: "Agent B", mode: "free" };
export const OWNER: Caller = { type: "person", id: "per_01J0000000000000000000000P" as Caller["id"], name: "owner", mode: null };

export type CallApp = (product: string, op: string, input: unknown, opts?: unknown) => Promise<CompanionResult>;

export function ctxFor(db: Db, caller: Caller, callApp?: CallApp): OpContext {
  const refuse: CallApp = async () => {
    throw new Error("no companion in this test");
  };
  return { db, caller, callApp: callApp ?? refuse } as unknown as OpContext;
}

/** Runs a handler from the app's handler map with a typed input. */
export async function call<O>(handlers: Record<string, { run: (i: never, c: OpContext) => Promise<unknown> } | unknown>, id: string, input: unknown, ctx: OpContext): Promise<O> {
  const h = handlers[id] as { run: (i: unknown, c: OpContext) => Promise<unknown> };
  return (await h.run(input, ctx)) as O;
}
