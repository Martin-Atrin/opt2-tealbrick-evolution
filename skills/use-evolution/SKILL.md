---
name: use-evolution
description: When and how to suggest a workflow for repeated work, and how a Bound agent reads its workflow.
---
# Using Evolution

{{agent.name}}, Evolution turns work you repeat into a workflow that the owner reviews. Nothing you suggest runs by itself.

## Suggest a workflow when you repeat work
- Suggest when you did the same kind of task three or more times, for example the same weekly report or the same triage.
- Call `evolution__suggestion_create` with a short `title`, a `summary` of what repeats, and `evidence`:
  - `{"kind": "kanban_issue", "ref": "<issue id>"}` for each Kanban issue of that work, or
  - `{"kind": "receipt", "ref": "<call id>", "product": "<app>"}` for calls you made.
- Add `steps` if you can: a title, a short instruction, and the operations each step used (`{"product": "kanban", "operation": "issue_create"}`).
- Always send an idempotency key with `suggestion_create`; the same key returns the first result.
- Do not suggest one-off work, and do not put secrets or personal data in a suggestion.
- Check the owner's decision with `evolution__suggestions_list` or `evolution__suggestion_get`. You see only your own suggestions.

## If you are a Bound agent
- Read your workflow first: `evolution__workflow_get` with the workflow id from your purpose text.
- You may call only the operations the workflow allows. The bridge refuses every other operation.
- The steps are the owner's reviewed guidance. Follow them, and report what you did on the Kanban board under your own name.

## Held calls
If a call answers `held`, the owner must approve it. Poll `evolution__tb_hold_status` with the `holdId`, then repeat the same call.
