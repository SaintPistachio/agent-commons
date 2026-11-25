# Gemini credit helper

Agent Commons uses this standard-library-only helper for the `gemini-api` route. It
admits requests against eligible promotional or prepaid credit that the operator records.

## Safety model

- The helper admits requests against an explicit allocation of promotional and already-purchased credit. Google
  draws from eligible promotional credit before its prepaid balance. Charges elsewhere on the billing account
  can reduce either balance between observations. Refresh the balances after outside use and before re-enabling.
- Every request reserves its worst case first: the input tokens counted by the free `countTokens` method at the full
  input price, plus `max_output_tokens` and an explicit thinking budget (sent to the API, default 24,576) at the
  output price, plus 15%, using the highest scheduled price from now on. It must fit the job ceiling (at most
  `max_job_usd`), the spendable balance (allocation minus a 5% margin, minus every charge from requests created
  after the observation less a 48-hour billing lag, minus open reservations), and a rolling 30-day budget
  (`monthly_target_usd`). Admission and reservation commit in one SQLite transaction, with time read under the
  write lock.
- A charge above its reservation pauses new requests until `clear-overrun`.
- Refusals that mean nothing was processed (HTTP 400, 401, 403, 404, 429) settle at $0. A timeout, connection
  failure, other HTTP error or a reply without usage keeps the reservation held as `uncertain`; it is never
  retried. Settle it by hand with billing evidence (`settle-uncertain`), which also recovers a job left
  `submitting` by a crash after twice the request timeout. Each job settles once.
- New requests are blocked when a recorded grant has expired, the balance observation is older than 35 days, or
  the key changed since the balance was recorded.
- The key is stored with Windows DPAPI for the current user in `.local/secrets/gemini-key.bin`, entered with hidden
  input (refused if the console cannot hide it), never printed, and never sent on a redirect. `.local/` is ignored
  by Git. The setup script creates private Windows directories and records the Python interpreter the service uses.
  Defaults live in `ledger.DEFAULT_POLICY`; an optional `.local/policy.json` overrides them.

## Setup

1. In AI Studio, verify which billing account and credits cover the Gemini API project.
   Confirm that the provider applies those credits to Gemini API requests.
2. Create a project for Agent Commons on that billing account and a Gemini API key in it.
3. Store the key (hidden input):

   ```powershell
   pwsh -NoProfile -File tools\gemini-capabilities\Enter-ApiKey.ps1
   ```

   Expected result: `"status": "saved"`.
4. Run `python tools\gemini-capabilities\run.py models` to check the key's project visibility without
   generating a response. AC startup and daily discovery, or `models --route gemini-api --refresh`,
   read the public Gemini model catalog, Standard USD pricing, and the authenticated project list.
   Discovery keeps the latest visible stable text model in each line, checks that it supports
   `generateContent` and `countTokens`, and records its token limits. An ambiguous price leaves that
   model ineligible. Cached input is accounted for at the full Standard input rate. The local catalog
   replaces the original checked-in prices after the first successful refresh.
5. Save a funding snapshot in private local storage. The example uses synthetic
   values. Substitute your observation timestamp, available balances, expiration
   dates, and intended allocation before running the commands.

   ```json
   {"funding_window_id": "example-funding-window", "source": "example billing observation",
    "verified_at": "2030-01-01T00:00:00Z", "allocation_usd": "3.50",
    "grants": [{"grant_id": "example-promotion", "kind": "promotional", "balance_usd": "2.50", "expires_on": "2030-02-01"},
               {"grant_id": "example-prepayment", "kind": "prepaid", "balance_usd": "1.00", "expires_on": "2030-03-01"}]}
   ```

   ```powershell
   python tools\gemini-capabilities\run.py refresh-funding --snapshot <file>
   python tools\gemini-capabilities\run.py enable
   ```

6. An operator adds `gemini-api` to AC's existing local worker policy and preserves the other route and
   tool settings. Restart AC to apply the worker policy. Verify the route and credit rows in AC status.

The private off-drive backup includes an online snapshot at `mirror/gemini-capabilities/usage.sqlite3`.
For recovery, keep the Gemini helper disabled, restore that snapshot to `.local/usage.sqlite3`, re-enter the key
locally, reconcile open requests, and refresh both Google balances before enabling. Keep the Gemini route
disabled after a cloud-only restore until its off-drive ledger is recovered or outstanding Google charges
are reconciled. The credential, result files, and interpreter pin stay on the machine.

## Commands

`status`, `credits`, `enable`, `disable`, `set-key`, `models`, `sync-models`, `refresh-funding --snapshot FILE`,
`invoke --request FILE` (`job_id`, `model`, `prompt`, optional `system`, `max_output_tokens`, `thinking_budget`,
`max_cost_usd`, `purpose`, `deliverable`), `lookup --job-id ID`, `clear-overrun`, `settle-uncertain --job-id ID --actual-usd X
--evidence TEXT`. Each prints one JSON object; exit 0 on success, 2 when blocked, refused or uncertain, 1 on a local
error.

## Test

```powershell
python -m unittest discover -s tools\gemini-capabilities\tests
```
