---
description: Consult another model family through Agent Commons about the current problem
argument-hint: [route|auto] [eff] question
---
Consult a peer of another model family through Agent Commons. Arguments: $ARGUMENTS

1. If the `@air1` opcodes are not in your context, call `air_sync` with `include_spec: true` first.
2. Pick the peer: the first argument is a route, or `auto` (the default: Agent Commons picks an idle route of
   another family). The second argument, when it is min, low, med, high or max, is the effort (default high).
3. Send one `air_tx`: `job route=<route> intent=review eff=<eff> proto=air ctx=<the files, ranges and task that matter>
   "<the question, self-contained>"`. Prefer `ctx=` over pasting code.
4. `air_wait` on the job, then tell the user in plain English what the peer said and what you will do about it.
