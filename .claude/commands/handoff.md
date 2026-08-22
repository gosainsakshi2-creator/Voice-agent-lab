---
description: Update HANDOFF.md with the current state before ending the conversation
---

Update `HANDOFF.md` so a fresh Claude conversation can resume from it.

Steps:

1. Gather the real state — do not guess:
   - `git status --short` and `git log --oneline -5`
   - `git diff --stat` for uncommitted work
   - Re-read the current `HANDOFF.md`.
2. Rewrite `HANDOFF.md`, keeping its existing section order:
   updated date / branch / last commit / dialing state, then **What was
   completed**, **In progress**, **Pending**, **Important decisions carried
   forward**, **Files changed this conversation**, **Current errors / known
   issues**, **Exact next steps**.
3. Rules:
   - Keep it short enough to paste into a new conversation. Push detail into
     `docs/` and link to it.
   - Carry forward pending items that are still pending; delete ones that are done.
   - Record failures and unfinished work honestly, including anything skipped
     and why.
   - "In progress" means genuinely mid-edit. If the tree is clean, say so.
4. Only if something **structural** changed this conversation — architecture, a
   locked constraint, a convention, the stack — also update `MEMORY.md`, and add
   an entry to `docs/DECISIONS.md` for any decision made. Otherwise leave both
   alone.
5. Report what you changed in one short paragraph.
