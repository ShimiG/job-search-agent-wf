# Working on Job Agents

Context for Claude sessions on this repository. The README is the full description of what the
agents do; this file is how to work on them, and what has been decided along the way.

## The project

Four agents and a local review page, in TypeScript on Node 22:

- **Scout** (`src/pipeline`, `src/sources`, `src/llm/scorer.ts`): finds jobs (ATS boards, alert
  emails), filters them by rules, scores them with Claude.
- **Tailor** (`src/tailor`): writes a CV and cover letter per job from the master CV, then rule
  checks and a fact-check model take back anything the CV doesn't say.
- **Submitter** (`src/submit`): fills application forms with Playwright.
- **Archiver** (`src/archiver`): reads replies with a local Ollama model; email never goes to Claude.
- **Review page** (`src/review`): where the user picks, approves and tracks everything.
- **Case study and evals** (`src/report`, `src/evals`, `evals/`): the numbers, and fixed test sets.

## Commands

```bash
npm test             # node:test through tsx; about 370 tests, 2 skipped without a browser
npm run typecheck
TAILOR_TEST_BROWSER=/opt/pw-browsers/chromium npm test   # also the real-browser tests, in a cloud container
npm run eval -- factcheck --rules-only                    # the one eval that needs no API key
```

## Rules that hold

- **Personal data never goes into git.** The repository is public. `config/` and `data/` are
  git-ignored: the master CV, preferences, the job database, logs, eval results and applications live
  only on the user's machine. A CV or a case study the user shares is delivered as a file, never
  committed. Test data is fictional (`evals/cv.json`, `test/fixtures`).
- **The Tailor never adds a fact.** No invented numbers, tools, scope or seniority, in any rewording
  or "improvement". Missing metrics are the user's to supply; the CV check (`src/cv/audit.ts`) lists
  where they would help.
- **No evasion.** No stealth browsers, CAPTCHA solving, or automated applying or scraping on sites
  whose terms forbid it (LinkedIn, Indeed, job boards). Those jobs are handed to the user.
- **Follow-up emails to employers are out:** the user rarely has a real company address.

## How changes are made

- One feature branch, pushed after each change. A PR only when the user asks for one; never
  force-push. After a PR merges, restart the branch from `main` before the next change.
- Database changes are new entries at the end of `MIGRATIONS` in `src/db/store.ts`, never edits to
  old ones; a function entry may repair older databases. `test/migrations.test.ts` checks the version.
- The review page is one `String.raw` template in `src/review/page.ts` with plain old-style
  JavaScript: no template literals inside it, and an apostrophe goes in a double-quoted string.
  `test/review-page.test.ts` parses the script. The page redraws on window focus and every 3 seconds,
  so anything a redraw would lose (a chosen file, a half-typed note) is kept in `ui` state.
- Claude calls go through `timed()` and a `CostMeter` (`src/llm/cost.ts`) so cost, time and failures
  are recorded. Structured answers get `ANSWER_MAX_TOKENS`: the models think first, and thinking
  counts toward `max_tokens`, so a small cap cuts the JSON off.
- Check UI changes in a real browser (Playwright with Chromium) before calling them done, and say
  plainly what could not be checked (live job sites, a real mailbox, a real model).

## Decisions, with the evidence behind them

- **Scoring runs without the advisor model.** Re-scoring 94 of the user's own decisions ranked picks
  over dismissals equally well with and without it (67% and 68%) at about 150 times the cost.
  `npm run eval -- decisions` and `compare` measure this.
- **Scores separate clear fits from clear misses, not the middle.** Of jobs scored 70 or more, the
  user picked 12 of 14; from 55 to 69 it was close to even, and many title-only alerts sat at exactly
  55. Showing the scorer the user's past decisions (`scoring.decisionExamples`, off by default) is the
  attempt to fix that; `npm run eval -- learning` tests it on a time split.
- **CV positioning follows the posting's title** (`rolePositioning` in `src/tailor/llm.ts`). The
  user's main search is AI automation roles, which keep the AI-automation framing, even titled
  "Engineer". Only plain engineering titles get the software-engineer framing.
- **Replies are filed by rule only when they say nothing more than "received".** A "thanks for
  applying" that goes on to a rejection or a next step goes to the model. `--recheck` repairs mail
  filed before that fix.
- **Eval cases are fictional and hand-labelled, and every rate is shown with its counts.** A rate
  from fewer than 20 cases is marked. When a model "fails" a case, read the case before trusting the
  label.

## Talking to the user

Plain language, short sentences, results before process. Say what was verified and what was not.
Numbers as "12 of 14", not bare percentages. Ask before spending real money (evals with the advisor,
re-scoring), and give the estimate's basis.
