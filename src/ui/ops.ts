// Typed person-op calls (the kit's PersonOps map: id → {input, output}, generated from the manifest).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import type { PersonOps } from "#kit";

export function person<K extends keyof PersonOps>(op: K, input: PersonOps[K]["input"]): Promise<PersonOps[K]["output"]> {
  return callOp<PersonOps[K]["output"]>(op as string, input as never);
}

export type Out<K extends keyof PersonOps> = PersonOps[K]["output"];

/** The one honest sentence about Bound workflows (G11), shown wherever allowed operations appear. */
export const ALLOWLIST_TEXT =
  "The agent may call these operations; the bridge blocks every other operation. The steps are guidance you reviewed: nothing forces the agent to follow them in order.";

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

/**
 * RUL-01: Approve / Deny on the Holds page. An expired hold, a 409 or a network error must reach the owner as a message,
 * never as an unhandled rejection. Returns the error text, or null when the decision went through.
 */
export async function decideOrError<D extends string>(decide: (id: never, decision: D) => Promise<void>, id: string, decision: D): Promise<string | null> {
  try {
    await decide(id as never, decision);
    return null;
  } catch (e) {
    return errorText(e);
  }
}
