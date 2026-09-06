# Kvaradona V3

A Next.js review app, hosted Supabase database, and a separate laptop worker. Outreach sending is disabled while the mail provider is undecided.

## Local use

Use Node 24 (`nvm use`) and `npm ci`. Keep credentials in the root `.env` following `.env.example`. Never copy another project's environment file. The web app requires only the Supabase URL and publishable key; provider and privileged database keys belong on the laptop.

- `npm run dev` — review app on 127.0.0.1:3000.
- `npm run build` / `npm run start` — production build and local server.
- `npm run worker -- --drain` — process currently queued work, then stop.
- `npm run worker:once` — process one durable stage.
- `npm run worker` — poll while the laptop is awake; Ctrl-C stops new claims and lets current work finish.
- `node --import tsx scripts/pause-pilot.ts` — pause campaigns and disable new billable requests while retaining saved work.
- `npm run capabilities` — secret-safe configuration, access and usage report.
- `npm run typecheck` / `npm test` — local type and invariant checks; tests do not call paid providers.

Only a privileged local operator can provision review membership or start a campaign. `npm run setup -- reviewer@example.com` creates a named account, organization and paused campaign; it writes the generated password to ignored `.local/review-login.json` and sends no email. Existing users are preserved. Use the password in the review app; it is not an outreach credential.

## Execution and cost controls

Initial SQL enforces a shared $1 OpenAI/Brave envelope, provider ceilings, a $0.90 campaign ceiling and $0.25 opportunity ceiling. Live execution starts disabled. Billable operations reserve budget before dispatch and checkpoint responses and usage before advancing. An uncertain provider call retains its reservation and blocks automatic replay. Missing usage is unknown, not zero.

The explicit local pilot command is `node --import tsx scripts/start-pilot.ts --authorized-one-dollar`. It is only for the already-authorized initial verification budget; it does not prove an account balance or buy credits. It enables a one-hour probe window for OpenAI/Brave and queues one discovery run. Other providers remain disabled until their free quotas and endpoints are verified. No schedule is enabled by the pilot.

Evidence, drafts, review actions and failures persist in Supabase. Edits create a new version and require fresh checking. Contact-pending items are reviewable but cannot be approved for sending. The app never sends mail. Research questions atomically queue one job against the next opportunity version; paused campaigns remain paused. Provider failures retain their budget reservations. Future failures also write a secret-safe diagnostic journal to ignored `.local/provider-failures.jsonl`; this does not settle unknown charges.

Browser probes reuse installed Google Chrome on macOS. On another platform, install the matching Playwright Chromium before running specialist capture.

## Database operations

Use an isolated V3 project. Before applying the first migration, save `scripts/preflight.sql` results using `supabase db query --linked --file scripts/preflight.sql --output json`. The initial Management API migration helper requires a verified empty baseline in `.local/backups/preflight.json`; it prepares one transaction with standard Supabase migration history. Review the generated SQL before applying it. The direct database CLI remains usable when its connection is available.

`supabase/recovery/001_empty_only.sql` is tested recovery to the empty application baseline **only before application data or users exist**. It refuses a populated database. Never run a reset or empty-baseline recovery against an operational project; take a current backup and use a targeted forward migration instead.

Local tests use PGlite for actual SQL execution with simulated Supabase roles. Hosted probes are separately labeled; fixture data and model responses do not establish live provider access or lead quality.
