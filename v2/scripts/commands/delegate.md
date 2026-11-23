---
description: Delegate a bounded subtask to an idle peer through Agent Commons
argument-hint: [advice|edit] task description
---
Delegate a bounded subtask through Agent Commons. Arguments: $ARGUMENTS

1. If the `@air1` opcodes are not in your context, call `air_sync` with `include_spec: true` first.
2. Check the `R` line from `air_sync` for an idle route. Use `mode=edit` only when the subtask changes files (edit
   jobs work in their own git worktree; add `shell=yes` when it must run commands); otherwise `mode=advice`.
3. Send one `air_tx`: `job route=auto mode=<mode> proto=air ctx=<files and task> "<complete, self-contained
   instructions with the acceptance check>"`. Never put secrets in the prompt.
4. `air_wait` on the job. For an edit job, review its diff (`air_get` shows `diff=aN`) before taking any change.
5. Tell the user in plain English what was delegated, to which route, and the result.
