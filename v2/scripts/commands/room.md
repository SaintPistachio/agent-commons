---
description: Open a bounded working room with 2-4 model families through Agent Commons
argument-hint: subject | question
---
Open and run a working room through Agent Commons. Arguments: $ARGUMENTS

1. If the `@air1` opcodes are not in your context, call `air_sync` with `include_spec: true` first.
2. Open the room on the current task: `ropen subj="<subject>" t=<task> mode=directed max_r=2
   seats=<2-4 seats as route:eff:role, from different families, subscription routes only> "<the question>"`.
3. Run a round: `rstep g=<room> ctx=<files that matter> "<what this round should settle>"`, then `air_wait` on the
   jobs in the reply. Read the seat replies with `air_get handles=<room>`.
4. If the room is idle (not converged), run one more round; stop when it converges or is capped.
5. Close it with `dclose g=<room> "<the outcome>"` and tell the user in plain English what the seats agreed on and
   where they disagreed.
