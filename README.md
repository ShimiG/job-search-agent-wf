# Job Agents

A job search pipeline built from three AI agents that share one SQLite database, with a local web page
that coordinates each run.

- **Scout** collects postings from company job boards and from LinkedIn and Indeed alert emails, drops
  the ones that don't fit your rules, merges duplicates, and asks Claude to score the rest against your CV.
- **Tailor** writes a CV and cover letter for each job you pick, then fact-checks every reworded claim
  against your own CV.
- **Submitter** fills in and submits the application forms: with you clicking Submit, or on its own
  within limits you set.
- **The review page** (`npm run review`) is where you follow a run: matches appear as they're scored,
  you pick jobs, read and approve the tailored applications, and watch them being sent.

```
job boards ─┐                                       review page
alert email ┴─► Scout ─► shortlist ─► you pick ─► Tailor ─► you approve* ─► Submitter ─► sent
               filter, dedupe, score,              draft, fact-check,        fill, submit,
               look up full postings               render PDFs               security codes
                                                   * optional: see "Review before sending"
```

LangGraph is optional: the same agents run as LangGraph graphs when its server is up, so every run is
visible in LangGraph Studio.

## Quick start

Requires Node.js 22+, Google Chrome (for PDFs and filling forms), and an
[Anthropic API key](https://platform.claude.com).

1. **Install and create your config files.**
   ```bash
   npm ci
   npm run scout -- init        # creates config/, data/ and .env from examples/
   ```
2. **Add your API key** to `.env` (`ANTHROPIC_API_KEY=...`).
3. **Open the review page and upload your CV.**
   ```bash
   npm run review               # opens http://127.0.0.1:4100
   ```
   In the **Your CV** tab, upload a PDF or Word file. Check the preview (anything not word for word
   from your file is flagged) and click **Save as my CV**. The starter CV is blank, so **Run Scout**
   stays greyed out until you've saved one (scheduled runs skip too: scoring needs your CV).
4. **Say what you're looking for** in `config/preferences.json`: target roles, title keywords,
   locations, seniority, languages.
5. **Add job sources.** Company job boards (see [Job boards](#job-boards)):
   ```bash
   npm run scout -- add-source https://job-boards.greenhouse.io/somecompany
   ```
   and, optionally, alert emails from LinkedIn and Indeed (see [Alert emails](#linkedin-and-indeed-alert-emails)).
6. **Try a free run first.** On the review page, or with
   `npm run scout -- run --no-score`, which fetches and filters without calling Claude. Check what
   gets through, adjust your preferences, then click **Run Scout** for a scored run.
7. **Pick, approve, send.** Tick jobs on the **Shortlist** and click **Send to Tailor**. Read each
   application in **Ready to send** (CV and cover letter PDFs) and click **Approve and send**.
8. **Schedule it** (macOS) so Scout runs before you start your day:
   ```bash
   npm run schedule -- on 08:00 --days sun,tue,thu
   ```

### A typical week

Scout runs on schedule, and when jobs reach your shortlist it opens the review page. You tick the ones
you want and send them to the Tailor. A minute or two later they're in **Ready to send**; you read
them, approve, and the Submitter sends them (in **Auto** mode without a window, in **Assist** mode
with a browser where you click Submit). Applications you send yourself on LinkedIn or elsewhere are
picked up from their confirmation emails, so Scout never shows you those jobs again.

## Configuration

`init` copies these from `examples/`. All are git-ignored: they hold personal data.

| File | What's in it |
|---|---|
| `data/master-cv.json` | Your CV as structured data, blank until you upload one via **Your CV** on the review page. Every highlight has an `id`: the Tailor cites these to prove each claim in a tailored CV comes from you. |
| `config/preferences.json` | Target roles, title keywords, seniority, locations (`allowOnsite`, remote rules), languages, score cutoffs, web lookups. |
| `config/sources.json` | Job boards, and alert-email reading (`emailAlerts`). |
| `config/tailor.json` | Your email and phone for the CV header, languages, length limits, cover-letter style. |
| `config/submit.json` | Submitter settings and your answer bank for screening questions. |
| `.env` | API key and optional settings below. |

| `.env` setting | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required for scoring, tailoring, lookups and CV upload. |
| `SCOUT_MODEL`, `TAILOR_MODEL`, `ENRICH_MODEL` | Models for scoring, tailoring/form answers, and web lookups. `claude-haiku-5-5` is much cheaper for scoring. |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD` | The inbox Scout reads: alert emails, application confirmations, security codes. |
| `REVIEW_REMOTE=true` | Lets your phone open the review page (see [On your phone](#on-your-phone)). |
| `REVIEW_AUTO_OPEN=false` | Stops Scout from opening the review page when it finishes. |
| `REVIEW_PORT`, `LANGGRAPH_URL` | Defaults 4100 and `http://127.0.0.1:2024`. |

## Where jobs come from

### Job boards

Scout reads the public job-board APIs of the systems companies host their careers pages on. Open a
company's careers page, click into any job, copy the URL, then:

```bash
npm run scout -- add-source https://job-boards.greenhouse.io/somecompany
npm run scout -- add-source https://jobs.lever.co/somecompany
npm run scout -- add-source https://jobs.ashbyhq.com/somecompany
npm run scout -- add-source https://apply.workable.com/somecompany --company "Some Company"
npm run scout -- add-source https://www.comeet.com/jobs/somecompany/AB.C12 --token <token>
npm run scout -- sources     # what's configured and whether each board worked last time
```

**Comeet** (common in Israeli tech) needs an API token as well as the company ID: view the careers
page source and search for `token`. A board that returns 404 almost always has the wrong token;
`sources` shows it as FAILING. To pause a board, set `"enabled": false` in `config/sources.json`.

Board jobs have full descriptions, and a job that disappears from its board is closed automatically.

### LinkedIn and Indeed alert emails

LinkedIn and Indeed forbid automated access, but they email you alerts, and Scout reads those:

1. Create job alerts on the sites. Have them sent to a Gmail address you also apply with (that inbox
   also receives application confirmations and security codes, which Scout uses too).
2. Turn on 2-Step Verification in that Google account and create an **app password**.
3. Set `IMAP_USER` and `IMAP_PASSWORD` in `.env`, and `"emailAlerts": { "enabled": true }` in
   `config/sources.json`.

LinkedIn (saved-search alerts and "X is hiring" emails), Indeed and Drushim are built in. Add others
under `emailAlerts.feeds` (capture group 1 of `linkPattern` must be the job ID):

```json
{ "name": "examplejobs", "from": "example-jobs.com", "linkPattern": "example-jobs\\.com/job/(\\d+)", "urlTemplate": "https://example-jobs.com/job/{id}" }
```

`from` is matched by Gmail's search, which matches whole parts of an address: use `linkedin.com`,
not `noreply@linkedin.com`.

Alert emails only say the title, company and location, so these jobs are **partial**:

- They're scored conservatively and have their own cutoff, `scoring.partialThreshold`.
- **Web lookup:** for partial jobs that make your shortlist, Claude looks for the same job on the
  company's own careers page (or a site copying it) and copies the full posting. It's accepted only if
  the text matches a page Claude actually fetched. The job is then scored again against the full-posting
  cutoff, and the company's application page becomes where the Submitter applies. LinkedIn, Indeed,
  Glassdoor and ZipRecruiter are never searched or fetched. About 10 cents per lookup;
  `enrich.maxPerRun` caps them per run.
- **Old jobs:** alert emails carry no posting date, so a LinkedIn job's age is estimated from its job ID
  (they're handed out in order). Jobs clearly past twice `maxAgeDays` are dropped before scoring.
- **Closed jobs:** a looked-up posting that says it's closed, or a company page that disappears, takes
  the job off your shortlist.

### Applications you send yourself

Scout reads application confirmation emails (LinkedIn's "your application was sent to…", Indeed's
"Indeed Application:", and the usual "Thank you for applying" emails from company sites and ATSs) and
marks those jobs as applied. They never come back on your shortlist, a later posting of the same job is
caught as a duplicate, and they count towards the Submitter's per-company limit. Turn it off with
`"trackApplications": false` in `config/sources.json`.

## The review page

```bash
npm run review               # http://127.0.0.1:4100
```

| Tab | What you do there |
|---|---|
| **Shortlist** | Matches appear as they're scored, best first, with why each fits and its gaps. Tick jobs, then **Send to Tailor** or **Dismiss**. Filter to full postings or partial ones. |
| **Tailoring** | Each picked job while its CV and cover letter are written and fact-checked. |
| **Ready to send** | The CV and cover letter (PDF links), anything the fact-check couldn't verify, and the tailoring report. **Approve and send**, **Redo with a note**, or **Reject**. |
| **Sending** | The Submitter at work. Anything that needs you shows the reason and a screenshot, with **Open it in the browser to finish**, **Find the company's application page** (alert jobs) or **I applied myself**. |
| **Sent** | The last 14 days, with every answer Claude wrote on each form. |
| **Below cutoff** | Jobs that scored under your cutoff, in case one deserves a look. |
| **Your CV** | Upload a new CV, see the current one. |

**Run Scout** starts a run from the page. With the LangGraph server up, every step runs there (a
pipeline run waiting at its pick or approval step is continued from the page); without it, the page
runs the agents itself. Leave the page running until the **Sending** tab is done.

### Submitter modes

Chosen at the top of the page; the mode set when you approve is the one used.

| Mode | Browser | Submits? |
|---|---|---|
| **Assist** | visible | You click Submit. Missing answers are outlined in red. |
| **Prepare** | hidden | Never. Fills the form and saves a screenshot, to check what it would send. |
| **Auto** | hidden | Yes, within the limits in [Auto mode](#auto-mode). Needs `"autoSubmit": true`. |

### Review before sending

The switch at the top (`requireApproval` in `config/submit.json`). **On** (default): each tailored
application waits in **Ready to send** for you. **Off**: applications go to the Submitter as soon as
they're tailored, in the current mode. Ones with claims the fact-check couldn't verify still wait for you.

### Your CV

Upload a PDF or Word (.docx) CV and Claude converts it into `data/master-cv.json`, keeping your wording
(about 5 cents). You see the result before saving: any line not word for word in your file is flagged,
and you can add LinkedIn, GitHub and website links that a PDF only shows as clickable words. Saving keeps
the previous CV as a backup and puts your email and phone in `config/tailor.json`.

### On your phone

Off by default: the page answers only the computer it runs on. To use it from your phone:

1. Add `REVIEW_REMOTE=true` to `.env` and restart the page. Allow `node` to accept incoming connections
   if macOS asks.
2. Click **On your phone** on the computer's page and scan the QR code once. The link carries a secret
   key (kept in `data/review-key`); the phone remembers it, and other devices get nothing.

That works on the same Wi-Fi. To use it anywhere, install [Tailscale](https://tailscale.com) on the
computer and the phone: the panel then also shows a Tailscale address, private to your devices. The
computer must be awake with the page running; use Auto mode from the phone (Assist opens forms on the
computer). To lock out every device that has the link, delete `data/review-key` and restart the page.

## Running on a schedule

On macOS, `npm run schedule` installs a launchd job, so nothing needs to be running: not VS Code, not a
terminal, not a server.

```bash
npm run schedule -- on 08:00 --days sun,tue,thu   # or --days sun-thu; every day if left out
npm run schedule -- status                         # when it runs, and the end of its log
npm run schedule -- off
```

Each run is a full Scout run; when jobs reach your shortlist it starts the review page and opens it. If
the Mac is asleep at that time, the run happens when it wakes; if it's off, that run is skipped. A run is
skipped if Scout is already running. The log is `data/logs/scout-schedule.log`. If you switch Node
versions, run `on` again: the job points at the current Node.

Elsewhere, keep `npm run scout -- watch --cron "0 8 * * 0,2,4"` running, or have cron or Task Scheduler
run `npm run scout -- run --open-review` in the project folder.

## LangGraph (optional)

The agents are also LangGraph graphs (`src/graph/graphs.ts`):

| Graph | What it does |
|---|---|
| `pipeline` | Scout → pause for your picks → Tailor → pause for your approval → Submitter |
| `scout`, `tailor`, `submitter` | One agent each |

```bash
npm run graph          # LangGraph dev server on http://127.0.0.1:2024
```

Open `https://smith.langchain.com/studio?baseUrl=http://127.0.0.1:2024` in Chrome (Safari blocks it;
use `npm run graph:tunnel` there). Starting the `pipeline` graph opens the review page, which answers
its pauses for you. You can also answer them in Studio with `{"pick": [ids]}` and
`{"approve": [ids], "force": false}`.

LangGraph adds a record of every run in Studio, and runs that carry on if the review page closes. It's
also the place to grow the design: splitting an agent into a coordinator and specialists, parallel
steps, retries. Use the npm-installed CLI (`langgraphjs`); the Python `langgraph` CLI can't run these
TypeScript graphs without Docker.

## How each agent works

### Scout

Filters run before any model call, so tuning them is free:

```bash
npm run scout -- run --no-score
npm run scout -- list --status filtered_out    # every dropped job shows its reason
npm run scout -- list --status queued          # what would be scored
```

- Keyword lists are whole-word, case-insensitive and work in Hebrew: `"ai"` matches "AI Engineer" but
  not "Maintenance".
- `locations.allow` includes `"israel"`, so any Israeli location passes; `allowOnsite: false` keeps only
  hybrid and remote jobs there. Remote jobs restricted to excluded regions are dropped.
- If good jobs show up as `title_include` in `filtered_out`, add words rather than removing the filter.
- `languages.blockRequired` drops "Fluent German required" but keeps "German is a plus".

Each remaining posting goes to Claude with your CV and preferences and gets a 0–100 score, match
reasons, gaps and dealbreakers (a dealbreaker caps the score at 40). Jobs at or above
`scoring.threshold` (default 65) are shortlisted; partial ones need `scoring.partialThreshold`. Editing
either cutoff re-sorts scored jobs on the next run without scoring them again. `scoring.maxJobsPerRun`
caps scoring per run; the rest wait for the next run. Postings are untrusted input: the prompt tells the
model to ignore instructions inside them. After changing preferences or your CV,
`npm run scout -- reevaluate` sends Scout's jobs back through filters and scoring.

### Tailor

1. **Draft.** Claude selects and rewords highlights from your CV for this posting, picks skills, writes
   a headline, summary and cover letter, and lists requirements your CV doesn't show.
2. **Rules.** Bullets must cite real highlight IDs, skills must be yours, every job in your history
   stays, and a reworded line that adds a number or a tool name your CV doesn't contain reverts to your
   exact wording.
3. **Fact-check.** A second call checks every reworded claim and cover-letter paragraph against your CV.
   Unsupported bullets revert to your wording; flagged letter paragraphs get one rewrite and are checked
   again. Anything still unsupported is listed for you, and approving it needs an explicit "send anyway".
4. **Render.** Employers, titles and dates come straight from your CV. Plain one-column templates (what
   ATS parsers read best) are printed to PDF with Chrome.

Each version lands in `data/applications/<job>-<company>/v<N>/`: the PDFs (the file names recruiters
see), HTML versions, `content.json` (edit it, then `npm run tailor -- render <id>`) and `report.md`.
The cover letter can match the posting's language (English, Hebrew or Russian; Hebrew renders
right-to-left): `languages.coverLetter: "match"` in `config/tailor.json`.

### Submitter

It reads forms by their labels, so one Submitter handles Greenhouse, Lever, Ashby, Workable, Comeet and
company-site forms, including iframes and forms behind an "Apply" button. Answers come from, in order:
the tailored PDFs; your **answer bank** in `config/submit.json` (an empty answer means "always ask
me"); policies (demographic questions declined; consent boxes only with `consentToPrivacyPolicies`);
your profile (name, email, phone, city, links); and finally the model, which may copy facts from your CV
and draft short answers like "Why us?". Autocomplete fields (city, country) are filled by picking from
their suggestions, and the form can't be submitted while it's being filled.

**Security codes:** when a site (Greenhouse, typically) emails a code after you click Submit, the
Submitter reads it from your inbox, enters it and submits again.

**Alert jobs** are applied to on the company's own application page found by the web lookup, never on
LinkedIn or Indeed, and only if that page mentions the job's title.

#### Auto mode

Off until `"autoSubmit": true`. `autoSubmitModelAnswers` says which answers Claude wrote may be sent
without you seeing them first: `none` (every answer must come from your data), `facts` (taken from your
CV; written answers like "Why us?" stop it) or `all`. The **Sent** tab lists them afterwards. Auto mode
always stops and hands the job to you when:

- a required question is unanswered, or your answer bank says to ask you,
- the page shows a CAPTCHA or a sign-in,
- it can't find a button that says submit or apply, or
- it clicked Submit and saw no confirmation (it never retries: check your email first).

#### Things it will not do

- **Solve CAPTCHAs or use stealth tricks.**
- **Create accounts or sign in.** Workday, iCIMS, Taleo and SuccessFactors are handed to you.
- **Apply on LinkedIn, Indeed or Israeli job boards**: their terms forbid it.
- **Apply twice,** or more than `maxPerCompanyPer30Days` (default 2) times to one company in 30 days.

Screenshots of every attempt go to `submission/` in the job's application folder. The browser uses its
own profile in `data/browser-profile`.

## Costs

Measured or estimated with the default models:

| Step | Cost |
|---|---|
| Scoring | about 0.1¢ per job with Haiku 5.5, more with Sonnet |
| Web lookup for a shortlisted alert job | about 10¢ each (capped by `enrich.maxPerRun`) |
| Tailoring | about 10–30¢ per application |
| Submitter | a few cents per application, only for questions it answers itself |
| CV upload | about 5¢ |
| Reading email, security codes, tracking your applications | free |

Set a monthly spend limit in the [Claude Console](https://platform.claude.com) to cap the total.

## Command reference

```bash
# Scout
npm run scout -- run [--no-score] [--open-review]
npm run scout -- list [--status s1,s2] [--all] [--limit N] [--json] [--brief] [--md]
npm run scout -- show <id> | pick <id...> | dismiss <id...> | reevaluate
npm run scout -- sources | add-source <careers-url> [--company "Name"] [--token T]
npm run scout -- watch [--cron "0 8 * * *"]

# Tailor
npm run tailor -- run [--job 12,15] [--no-pdf]
npm run tailor -- list | show <id> | open <id> | render <id>
npm run tailor -- approve <id> [--force] | reject <id> | redo <id> --note "..."

# Submitter
npm run submit -- run [--mode assist|prepare|auto] [--job 12,15]
npm run submit -- list | show <id> | retry <id> | mark-submitted <id> [--note "..."]

# Everything else
npm run review                          # the review page
npm run schedule -- on [HH:MM] [--days sun-thu] | status | off
npm run graph                           # LangGraph dev server (graph:tunnel for Safari)
```

## Data model

Everything lives in `data/scout.db` (SQLite). The `jobs` table has one row per posting, with a `status`
the agents move forward:

```
discovered ─► filtered_out | duplicate
           ─► queued ─► score_error (retried) | low_score
                     ─► shortlisted ─► selected (you) ─► tailored ─► approved (you or auto) ─► submitted
                                    ─► dismissed (you)   ─► tailor_error            ─► needs_manual | failed
```

Scout only changes statuses up to `shortlisted`. Every change is recorded in `status_history` with who
made it (`scout`, `user`, `tailor`, `submitter`). `applications` keeps every tailored version,
`submissions` every Submitter attempt (fields, sources, screenshots, confirmation), `runs` per-run
stats, and `source_health` each board's last result.

## Project layout

```
src/
  cli.ts                 Scout commands
  config.ts              schemas: preferences, sources, master CV
  types.ts               job schema and status flow
  decisions.ts           your picks and approvals (shared by the graph and the review page)
  schedule.ts            the launchd schedule
  db/store.ts            SQLite store, migrations, history
  sources/               ATS adapters, alert emails, application confirmations, URL detection
  pipeline/              filters, dedupe, run steps, applied jobs, job age, closed postings
  llm/                   scoring, and web lookups for full postings
  cv/import.ts           CV upload: PDF/Word to the master CV
  tailor/                draft, rules, fact-check, render
  submit/                answers, form filling, security codes, modes and records
  graph/graphs.ts        the LangGraph graphs
  review/                the review page (server, page, launcher)
examples/                templates copied by init
test/                    node:test suites and fixtures
```

## Development

```bash
npm test             # node:test
npm run typecheck
```

Tests cover the adapters, email parsing, filters, dedupe, scoring with a fake Claude client, full Scout
runs on an in-memory database, the Tailor's rules and real PDF rendering, the CV import, and Submitter
runs in headless Chrome against local pages modeled on Greenhouse (including autocomplete fields and
emailed security codes), Lever, CAPTCHA, sign-in and iframe pages. Browser tests find Chrome on macOS
automatically; elsewhere, point `TAILOR_TEST_BROWSER` at a Chromium binary.

## Known limitations

- **Live coverage is thin.** The Submitter has completed real Greenhouse applications, but other ATSs
  were tested only against local look-alike pages. Use Prepare or Assist mode on a new site first.
- **The fact-check is a strong filter, not a guarantee,** and the rule checks catch new numbers and tool
  names, not subtler inflation ("built" becoming "led"). Read applications before approving them.
- **Web lookups and alert parsing are heuristic.** A lookup may find nothing, and alert email layouts
  change. A job only on LinkedIn can't be applied to automatically, and its closing can't be detected.
- **Indeed jobs can't be dated:** their IDs don't increase over time.
- **Comeet tokens** must be found by hand.
- The Anthropic SDK's structured-output helper doesn't enforce string enums or numeric ranges, so the
  scoring schema uses plain types and `postProcess()` in `src/llm/scorer.ts` enforces them.
