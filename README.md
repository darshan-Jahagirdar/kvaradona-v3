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

Versioned SQL enforces a shared $2 cumulative OpenAI/Brave envelope ($1.80 OpenAI, $0.20 Brave), a $0.90 campaign ceiling and $0.25 opportunity ceiling. Live execution starts disabled. Billable operations reserve budget before dispatch and checkpoint responses and usage before advancing. An uncertain provider call retains its reservation and blocks automatic replay. Missing usage is unknown, not zero. Raising the cap does not reset spent or held amounts.

An operator can deliberately replace one ambiguous initial draft with `node --import tsx scripts/replace-draft.ts OPERATION_UUID 'Specific reason for replacement'`. The SQL function accepts only a blocked current-version initial draft, preserves its full unknown reservation, queues one Terra replacement with an audit reason, and rejects replacement chains. Normal automatic replay remains blocked.

The explicit local pilot command is `node --import tsx scripts/start-pilot.ts --authorized-two-dollars`. It is only for the already-authorized cumulative verification budget; it does not prove an account balance or buy credits. It enables a one-hour probe window for OpenAI/Brave and queues one discovery run. Other providers remain disabled until their free quotas and endpoints are verified. No schedule is enabled by the pilot.

Apollo contact resolution uses one zero-credit people search (five results maximum) and at most one work-email enrichment credit. Phone, personal-email and waterfall requests are disabled. The current allowance is 75 user-confirmed credits; SQL counts every reserved unit, including uncertain outcomes, against that allowance. `node --import tsx scripts/resolve-contact.ts OPPORTUNITY_UUID` queues a single contact refresh for a checked contact-pending packet. It does not recheck the Apollo balance. Partial names remain candidates until the exact person, current employer, relevant role and verified work-domain email match.

An unchanged recipient reuses the checked draft; a new recipient invalidates its review and queues A5 against the exact new packet hash. `node --import tsx scripts/review-contact-draft.ts OPPORTUNITY_UUID` can recover that review from saved state without rerunning contact lookup or the writer. Fact citations keep their exact evidence anchors; an inference or unknown claim may be reviewed against an attributable version of the same original page. Browser review remains required before any future sending.

Evidence, drafts, review actions and failures persist in Supabase. Edits create a new version and require fresh checking. Contact-pending items are reviewable but cannot be approved for sending. The app never sends mail. Research questions atomically queue one job against the next opportunity version; paused campaigns remain paused. Provider failures retain their budget reservations. Future failures also write a secret-safe diagnostic journal to ignored `.local/provider-failures.jsonl`; this does not settle unknown charges.

Browser probes reuse installed Google Chrome on macOS. On another platform, install the matching Playwright Chromium before running specialist capture.

## Database operations

Use an isolated V3 project. Before applying the first migration, save `scripts/preflight.sql` results using `supabase db query --linked --file scripts/preflight.sql --output json`. The initial Management API migration helper requires a verified empty baseline in `.local/backups/preflight.json`; it prepares one transaction with standard Supabase migration history. Review the generated SQL before applying it. The direct database CLI remains usable when its connection is available.

`supabase/recovery/001_empty_only.sql` is tested recovery to the empty application baseline **only before application data or users exist**. It refuses a populated database. Never run a reset or empty-baseline recovery against an operational project; take a current backup and use a targeted forward migration instead.

Local tests use PGlite for actual SQL execution with simulated Supabase roles. Hosted probes are separately labeled; fixture data and model responses do not establish live provider access or lead quality.

## Completing the draft-ending POC

The local worker supports `--drain --max-jobs=12` to finish at most twelve queued jobs and exit. Saved jobs, evidence and provider responses survive a restart; uncertain operations are never automatically redispatched. Schedules remain off until an operator explicitly enables them.

`node --import tsx scripts/complete-poc.ts prepare` opens one bounded regional/procurement run using already recorded endpoint evidence and the existing cumulative budget. It refuses to overwrite its saved run. Use `next` to queue each remaining configured group, `advance` for one unattempted saved candidate, and `report` to export the actual funnel and usage to ignored local storage. Country targeting is reported separately from buyer geography. Brave's unsupported Singapore filter becomes an explicitly recorded all-country search with a Singapore query term; no Singapore-only coverage is claimed.

Procurement supports SAM metadata and the public Contracts Finder OCDS feed, with buyer/notice identity, repeat-snapshot handling, changed-notice invalidation and an evidence-checked response outline. SAM still needs verified free request access; configuration alone does not enable it. A public-feed match outside the configured service catalogue is held as a service mismatch before further AI work. Descriptions and at most three linked attachments feed the outline. PDF text extraction runs locally in a disposable process, capped at 2 MB, 30 pages, 18,000 characters and ten seconds. Unavailable, scanned, oversized or unsupported files remain explicit missing inputs. No eligibility, company proof, complete amendment history or submission readiness is inferred.

The review app preserves exact edits, queues a fresh A5 check, and records human quality ratings against the exact saved packet. Human ratings are separate from model verdicts and sending approval. The authenticated **POC evidence report** exports decisions, checked drafts, current human ratings, same-pool rule scores and usage; source failures are not counted as qualified decisions. A checked procurement outline still needs supplier details and any missing documents. The Send email control remains informational and makes no network request.
