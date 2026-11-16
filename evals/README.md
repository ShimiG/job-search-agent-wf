# Evals

Fixed test cases with known answers, run through the same code the agents use. Everything here is
fictional: the candidate (`cv.json`, `preferences.json`), the companies, the postings and the emails.
Because the cases are in the repository, anyone can rerun a suite and get a number to compare.

```bash
npm run eval -- scoring                 # 58 postings; calls Claude (or a local model)
npm run eval -- scoring --no-advisor    # the same without the stronger model the scorer may consult
npm run eval -- factcheck               # 48 reworded bullets; calls Claude
npm run eval -- factcheck --rules-only  # the same, rule checks only: no model, no cost
npm run eval -- replies                 # 38 emails; local model through Ollama
npm run eval -- all                     # every suite that can run with what is set up
npm run eval -- compare                 # each suite's latest run per model, side by side
```

`--model <name>` tests another model than the one in `.env`. `--limit <n>` runs at most n cases of each
kind for a quick look; such a run is shown but not saved. Each full run is saved to
`data/evals/<suite>.json` (every run is kept in `data/evals/history/`) and is included in
`npm run scout -- case-study`, with the side-by-side table once a suite has been run with two models.

## What each suite measures

| Suite | Cases | What is run | The numbers |
|---|---|---|---|
| `scoring` | 10 good fits and 10 poor fits a keyword match can tell apart; 22 that take reading the posting (see below); 6 with only a title and one line, as a job alert gives them; 10 postings to reject with instructions planted in them | The scorer Scout uses, with the eval CV and preferences, cutoff 65 (55 for a title and one line) | Each kind on its own line, how often a posting to shortlist outscores one to reject, and how many points the planted text added |
| `factcheck` | 12 honest rewordings of a CV bullet and 12 reworded more freely; 12 plain inventions (a number, a tool, a team led) and 12 subtle ones (a wider scope, a result, a bigger role, with no number or name to catch) | The Tailor's rule checks, then its fact-checker on what the rules let through | Plain and subtle inventions caught (by rules, by the fact-checker), honest rewordings wrongly taken back |
| `replies` | 3 plain emails of each of the Archiver's 8 kinds, some in Hebrew; 14 harder ones: a request inside a receipt, a receipt that mentions interviews, a rejection after an interview, reminders, Russian and informal Hebrew, unrelated mail that talks about applications, and 2 with planted instructions | The Archiver's email sorter | Right kind, the harder emails, callbacks recognised, other mail mistaken for a callback, planted instructions ignored |

The harder postings in `scoring`:

| Kind | What it is | Expected |
|---|---|---|
| `trap` | Shares the CV's keywords but is a different job: selling AI agents, WhatsApp marketing, test automation in Java, product management, model training, SAP | Reject |
| `disguised` | The right work described without the CV's keywords: "guided conversations" on "messaging apps", "web services" | Shortlist |
| `dealbreaker` | The right work with one firm disqualifier: 8 years required, fluent German, on-site abroad, part-time freelance, a completed degree, support-only night shifts | Reject |
| `soft-gap` | The right work with only nice-to-haves missing | Shortlist |

The first version of these suites had only the plain cases, and the models scored 100% on two of them:
a test nothing fails tells you nothing, and can't tell two models apart. The harder kinds are there to
be failed sometimes.

## The fourth suite: your own decisions

The three suites above have clear answers, and a clear answer is easy for a model: the first run of
the harder scoring cases still came out at 98% with a perfect ranking, with or without the advisor.
What is hard about scoring is the middle: real postings, often known only by a title and a line, where
the right answer is what you would have chosen.

```bash
npm run eval -- decisions                 # the model in .env, as Scout uses it
npm run eval -- decisions --no-advisor    # the same jobs without the advisor
npm run eval -- decisions --model claude-sonnet-5-5
npm run eval -- compare
```

It re-scores the jobs you picked (or applied to) and the ones you dismissed from your shortlist, with
your own CV and preferences, and reports how often a job you picked outscores one you dismissed, next
to the same figure for the scores given at the time, and what the cutoff would keep. `--all` takes
every scored job you decided on rather than only shortlisted ones; those extra dismissals mostly
repeat the score, so the default leaves them out. `--limit 10` tries ten of each first.

Nothing in your database changes, and the postings go where Scout sends them when it scores. It costs
what scoring that many jobs costs, and the advisor is the expensive part, so run `--no-advisor` first.
It is your data: nobody else can rerun it, the report names no job, and it is not part of `all`.

## Would your past decisions help the scorer?

Re-scoring showed where the scorer runs out: a job scored 70 or more was picked 12 times out of 14,
but from 55 to 69 picks and dismissals were mixed about evenly, and a third of the jobs sat on exactly
55, the cutoff for a posting known only by its title. A stronger model changed nothing, because there
is nothing more in a title to reason about. What tells those jobs apart is your own taste, and the
scorer has only a short note about it.

So the scorer can be shown your past decisions as examples (`"decisionExamples": 20` under `"scoring"`
in `config/preferences.json`; off by default). Whether that helps is a question about your search, and
this answers it:

```bash
npm run eval -- learning
npm run eval -- learning --examples 30
```

Your decisions are put in the order you made them. The older half supplies the examples (your latest
picks, and your latest passes from the shortlist, chosen as Scout would choose them); the newer half
is the test. The same model scores each test job twice, as Scout scores today and shown the examples,
and the result has both side by side: how often a pick outscores a dismissal, what the cutoff keeps,
and how many jobs still sit exactly on the cutoff. No test job is among the examples, and every example
was decided before every test job, as it would be in use.

It runs without the advisor unless you pass `--with-advisor` (two scores a job; with the advisor that
is dollars), so it costs a few cents. The test is half of your decisions: with about 45 jobs, a
difference of a few points is noise, and only a clear gap means something. As with `decisions`, nothing
in your database changes and the report names no job.

## Reading the results

- The samples are small. A kind has 4 to 12 cases, so one case moves its rate by 8 to 25 points: use
  these to catch a regression or compare two models, not to quote two decimal places.
- Results from before cases were added are not comparable with later ones; `compare` leaves out runs
  over a different number of cases.
- A case the model failed to answer (timeout, overload) is reported separately and left out of every rate.
- `scoring` with a local model runs without the examples of Claude-scored jobs it gets in a real run,
  so it reads a little worse here than it would for you.
- The labels are judgement calls made when the cases were written. If a result looks wrong, read the
  case: a label can be wrong too. Fix it in the `.jsonl` file and say so in what you publish.

## Adding cases

One JSON object per line; lines starting with `//` are comments. `npm test` checks that every case
parses, that IDs are unique, that each fact-check bullet cites a real highlight of `cv.json`, and that
each injection case is its base posting with text added. Keep everything fictional.
