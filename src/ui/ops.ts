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
