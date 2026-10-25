// The coordinator page, served by server.ts. Client script is plain JS in a string: no build step.
// No template literals in the client code: this whole page is one String.raw template.
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Search Run</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --text: #16181d; --muted: #5f6672; --line: #e3e6eb;
    --accent: #2f6fec; --accent-text: #ffffff; --good: #1e8a4c; --ok: #0f7f86; --warn: #a86400; --low: #7a808a;
    --good-bg: #e6f5ec; --ok-bg: #e2f4f5; --warn-bg: #fdf1dc; --low-bg: #eef0f3; --danger: #c23a32; --danger-bg: #fbe7e5;
    --sel: #eaf1ff; --shadow: 0 1px 2px rgba(16, 24, 40, .06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111317; --card: #1a1d23; --text: #e8eaee; --muted: #9aa1ad; --line: #2b3038;
      --accent: #5b8ff5; --accent-text: #0b0d10; --good: #5cc98a; --ok: #4fc3c9; --warn: #e8a948; --low: #9aa1ad;
      --good-bg: #173324; --ok-bg: #133234; --warn-bg: #3a2c12; --low-bg: #262a31; --danger: #f07167; --danger-bg: #3a1d1b;
      --sel: #1d2a44; --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Hebrew", sans-serif; }
  main { max-width: 940px; margin: 0 auto; padding: 22px 16px 120px; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 6px; }
  h1 { font-size: 22px; margin: 0; }
  .spacer { flex: 1; }
  select, textarea { font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; max-width: 100%; }
  textarea { width: 100%; min-height: 64px; resize: vertical; margin-top: 8px; }
  .status { margin: 4px 0 12px; color: var(--muted); font-size: 14px; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
  .status strong { color: var(--text); font-weight: 600; }
  .progress { height: 6px; background: var(--line); border-radius: 99px; overflow: hidden; width: 160px; display: inline-block; vertical-align: middle; }
  .progress > span { display: block; height: 100%; background: var(--accent); }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 14px; }
  .tabs button { border: 0; background: none; color: var(--muted); padding: 8px 10px; font: inherit; font-size: 14px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tabs button[aria-selected=true] { color: var(--text); font-weight: 650; border-bottom-color: var(--accent); }
  .tabs .n { display: inline-block; min-width: 20px; padding: 0 6px; margin-left: 4px; border-radius: 99px; background: var(--low-bg); font-size: 12px; text-align: center; }
  .tabs .n.hot { background: var(--accent); color: var(--accent-text); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; color: var(--muted); font-size: 14px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--card); }
  .seg button { border: 0; background: none; color: var(--muted); padding: 5px 11px; font: inherit; font-size: 13px; cursor: pointer; }
  .seg button[aria-pressed=true] { background: var(--sel); color: var(--text); font-weight: 600; }
  label.all { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
  .card { display: grid; grid-template-columns: 28px 52px 1fr; gap: 0 12px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 10px; box-shadow: var(--shadow); }
  .card.selected { border-color: var(--accent); background: var(--sel); }
  .card input[type=checkbox] { width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--accent); cursor: pointer; }
  .score { align-self: start; text-align: center; border-radius: 8px; padding: 4px 0; font-weight: 700; font-size: 17px; font-variant-numeric: tabular-nums; }
  .s-good { background: var(--good-bg); color: var(--good); } .s-ok { background: var(--ok-bg); color: var(--ok); }
  .s-warn { background: var(--warn-bg); color: var(--warn); } .s-low { background: var(--low-bg); color: var(--low); }
  .body { grid-column: 3; min-width: 0; }
  .title { font-weight: 650; font-size: 16px; color: var(--text); text-decoration: none; }
  .title:hover { text-decoration: underline; }
  .meta { color: var(--muted); font-size: 14px; margin-top: 2px; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); text-decoration: none; }
  a.tag:hover { color: var(--text); }
  .tag.warn { border-color: transparent; background: var(--warn-bg); color: var(--warn); }
  .tag.good { border-color: transparent; background: var(--good-bg); color: var(--good); }
  .tag.bad { border-color: transparent; background: var(--danger-bg); color: var(--danger); }
  .tag.doc { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .summary { margin: 8px 0 0; }
  .note { margin: 8px 0 0; font-size: 14px; color: var(--muted); }
  .flags { margin: 8px 0 0; padding: 8px 10px 8px 26px; background: var(--warn-bg); color: var(--warn); border-radius: 8px; font-size: 14px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: var(--accent); font-size: 14px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
  .cols h3 { font-size: 12px; margin: 0 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .cols ul { margin: 0; padding-left: 18px; }
  .pre { white-space: pre-wrap; font-size: 13px; color: var(--muted); max-height: 380px; overflow: auto; border-top: 1px solid var(--line); margin-top: 10px; padding-top: 10px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .working { display: inline-flex; align-items: center; gap: 8px; color: var(--accent); font-size: 14px; margin-top: 8px; }
  .spin { width: 14px; height: 14px; flex: none; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  .empty { text-align: center; color: var(--muted); padding: 40px 0; }
  .btn { border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 8px; padding: 7px 13px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  .btn.small { padding: 4px 10px; font-size: 13px; }
  .btn.danger { color: var(--danger); }
  .btn:disabled { opacity: .5; cursor: default; }
  .actions { position: fixed; left: 0; right: 0; bottom: 0; background: var(--card); border-top: 1px solid var(--line); padding: 12px 16px; display: none; }
  .actions.show { display: block; }
  .actions .inner { max-width: 940px; margin: 0 auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .hint { color: var(--muted); font-size: 13px; }
  .switch { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); cursor: pointer; }
  .switch input { width: 34px; height: 20px; appearance: none; background: var(--line); border-radius: 99px; position: relative; cursor: pointer; margin: 0; }
  .switch input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--card); transition: left .15s; }
  .switch input:checked { background: var(--accent); }
  .switch input:checked::after { left: 16px; }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  .panel h2 { font-size: 17px; margin: 0 0 4px; }
  .panel h3 { font-size: 13px; margin: 14px 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .panel ul { margin: 4px 0 0; padding-left: 18px; }
  .role { margin-top: 10px; }
  .role strong { font-weight: 650; }
  .phone { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .phone .qr { background: #fff; padding: 8px; border-radius: 8px; line-height: 0; }
  .phone .qr svg { width: 200px; height: 200px; }
  .phone code { font-size: 12px; word-break: break-all; }
  .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 10px 16px; border-radius: 8px; font-size: 14px; display: none; max-width: calc(100% - 32px); z-index: 2; }
  @media (max-width: 600px) {
    .card { grid-template-columns: 24px 44px 1fr; gap: 0 10px; }
    .cols { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Job search run</h1>
    <span class="spacer"></span>
    <label class="switch" title="When off, tailored applications go straight to the Submitter"><input type="checkbox" id="review" role="switch"> Review before sending</label>
    <label class="hint" for="mode">Submitter</label>
    <select id="mode">
      <option value="assist">Assist: fills the form, you click Submit</option>
      <option value="prepare">Prepare: fills and screenshots, never submits</option>
      <option value="auto">Auto: submits when every answer is yours</option>
    </select>
    <button class="btn" id="phoneBtn" type="button" hidden>On your phone</button>
    <span id="runWrap"><button class="btn primary" id="run" type="button">Run Scout</button></span>
  </header>
  <div class="status" id="status">Loading…</div>
  <div id="phone"></div>
  <nav class="tabs" role="tablist" id="tabs"></nav>
  <div class="toolbar" id="toolbar"></div>
  <div id="list"></div>
</main>
<div class="actions" id="actions"><div class="inner" id="actionsInner"></div></div>
<div class="toast" id="toast" role="status"></div>
<script>
(function () {
  var TABS = [
    { id: 'shortlist', label: 'Shortlist', empty: 'Nothing on your shortlist. Run Scout, or check Below cutoff.' },
    { id: 'tailoring', label: 'Tailoring', empty: 'Nothing being tailored.' },
    { id: 'ready', label: 'Ready to send', empty: 'No applications waiting for your approval.' },
    { id: 'sending', label: 'Sending', empty: 'Nothing waiting for the Submitter.' },
    { id: 'sent', label: 'Sent', empty: 'No applications sent in the last 14 days.' },
    { id: 'below', label: 'Below cutoff', empty: 'Nothing below the cutoff.' },
    { id: 'cv', label: 'Your CV', empty: '' }
  ];
  var ui = {
    tab: 'shortlist', filter: 'all', data: null, below: null, hash: '',
    picked: new Set(), approve: new Set(), open: new Set(), notes: {}, redoOpen: new Set(), busy: false,
    cv: null, cvPreview: null, cvBusy: false,
    linkOpen: new Set(), links: {}, linkBusy: null
  };
  var $ = function (id) { return document.getElementById(id); };
  try { var saved = localStorage.getItem('mode'); if (saved) $('mode').value = saved; } catch (e) {}
  $('mode').addEventListener('change', function () { try { localStorage.setItem('mode', $('mode').value); } catch (e) {} render(); });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function link(href, cls, text) { var a = el('a', cls, text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
  function btn(text, cls, onClick) { var b = el('button', 'btn ' + (cls || ''), text); b.type = 'button'; b.addEventListener('click', onClick); return b; }
  function scoreClass(s) { return s >= 75 ? 's-good' : s >= 65 ? 's-ok' : s >= 55 ? 's-warn' : 's-low'; }
  function day(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''; }
  function time(iso) { return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
  function file(j, name) { return '/files/' + j.id + '/' + name.split('/').map(encodeURIComponent).join('/'); }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.style.display = 'none'; }, 7000);
  }
  function fail(e) { toast('Failed: ' + e.message); }
  function bullets(title, items) {
    var box = el('div'); box.appendChild(el('h3', null, title));
    var ul = el('ul'); (items.length ? items : ['—']).forEach(function (t) { ul.appendChild(el('li', null, t)); });
    box.appendChild(ul); return box;
  }
  // Details stay open across the 3-second refreshes.
  function keep(details, key) {
    details.open = ui.open.has(key);
    details.addEventListener('toggle', function () { if (details.open) ui.open.add(key); else ui.open.delete(key); });
    return details;
  }

  // ------------------------------------------------------------ server
  function post(action, body) {
    ui.busy = true; render();
    return fetch('/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || r.status); return d; }); })
      .finally(function () { ui.busy = false; refresh(true); });
  }
  function refresh(force) {
    return fetch('/api/state').then(function (r) { return r.json(); }).then(function (d) {
      var h = JSON.stringify(d);
      ui.data = d;
      if (ui.tab === 'below' && (force || !ui.below)) loadBelow();
      // Only redraw when something changed, so typing a note or reading isn't interrupted.
      if (h !== ui.hash || force) { ui.hash = h; render(); }
    }).catch(function (e) { $('status').textContent = 'Lost contact with the review page server: ' + e.message; });
  }
  function loadBelow() { fetch('/api/below-cutoff').then(function (r) { return r.json(); }).then(function (d) { ui.below = d; render(); }); }
  setInterval(refresh, 3000);
  window.addEventListener('focus', function () { refresh(true); });

  // ------------------------------------------------------------ status line
  var STAGES = {
    scouting: 'Scout is collecting and scoring jobs',
    pick: 'waiting for your picks',
    tailoring: 'the Tailor is writing applications',
    review: 'waiting for your approval in Ready to send',
    submitting: 'the Submitter is working',
    working: 'working',
    done: 'finished',
    error: 'stopped with an error (see it in Studio)'
  };
  function scoutRunning(d) {
    return Boolean(d.scouting) || Boolean(d.pipeline && d.pipeline.stage === 'scouting') || d.tasks.some(function (t) { return t.kind === 'scout' && !t.done; });
  }
  function renderStatus(d) {
    var s = $('status'); s.textContent = '';
    if (d.scouting) {
      var total = d.scouting.scored + d.scouting.remaining;
      var line = el('span');
      line.appendChild(el('strong', null, 'Scoring: '));
      line.appendChild(document.createTextNode(d.scouting.scored + ' scored' + (d.scouting.remaining ? ', ' + d.scouting.remaining + ' to go ' : ' ')));
      if (total) { var bar = el('span', 'progress'); var fill = el('span'); fill.style.width = Math.round(100 * d.scouting.scored / total) + '%'; bar.appendChild(fill); line.appendChild(bar); }
      s.appendChild(line);
    }
    if (d.pipeline && d.pipeline.stage !== 'done') {
      var p = el('span');
      p.appendChild(el('strong', null, 'Pipeline run: '));
      p.appendChild(document.createTextNode(STAGES[d.pipeline.stage] + ' · Submitter mode ' + d.pipeline.mode + ' '));
      if (d.pipeline.stage === 'pick' || d.pipeline.stage === 'review') {
        p.appendChild(btn('End this run', 'small', function () {
          if (confirm('End this pipeline run? Nothing is deleted; your jobs stay where they are.')) post('end').then(function () { toast('Run ended.'); }, fail);
        }));
      }
      s.appendChild(p);
    }
    d.tasks.filter(function (t) { return !t.done; }).forEach(function (t) {
      var w = el('span', 'working'); w.appendChild(el('span', 'spin'));
      var what = { scout: 'Scout running', tailor: 'Tailor working on ', submit: 'Submitter working on ' }[t.kind];
      w.appendChild(document.createTextNode(what + (t.jobIds.length ? t.jobIds.length + ' job(s)' : '') + (t.via === 'langgraph' ? ' (LangGraph)' : '')));
      s.appendChild(w);
    });
    d.tasks.filter(function (t) { return t.error; }).forEach(function (t) { s.appendChild(el('span', 'tag bad', t.kind + ' failed: ' + t.error)); });
    s.appendChild(el('span', 'hint', d.langgraph ? 'LangGraph server on: runs show in Studio' : 'LangGraph server off: this page runs the agents itself'));
    var running = scoutRunning(d);
    var noCv = !(d.cv && d.cv.ready);
    $('run').disabled = noCv || running || ui.busy;
    $('run').textContent = running ? 'Scout is running…' : 'Run Scout';
    // A disabled button gets no hover events, so the tooltip sits on its wrapper.
    $('runWrap').title = noCv ? 'Please upload a CV first' : '';
    $('run').style.pointerEvents = noCv ? 'none' : '';
    $('runWrap').style.cursor = noCv ? 'not-allowed' : '';
    $('review').checked = d.requireApproval;
    var autoOpt = $('mode').querySelector('option[value=auto]');
    autoOpt.disabled = !d.autoSubmitAllowed;
    autoOpt.textContent = d.autoSubmitAllowed ? 'Auto: submits when every answer is yours' : 'Auto: off (autoSubmit in config/submit.json)';
    if (!d.autoSubmitAllowed && $('mode').value === 'auto') $('mode').value = 'assist';
  }

  // ------------------------------------------------------------ cards
  function jobCard(j, opts) {
    var selectable = opts.select;
    var card = el('article', 'card' + (selectable && selectable.has(j.id) ? ' selected' : ''));
    if (selectable) {
      var box = el('input'); box.type = 'checkbox'; box.checked = selectable.has(j.id);
      box.setAttribute('aria-label', 'Select ' + j.title + ' at ' + j.company);
      box.addEventListener('change', function () { if (box.checked) selectable.add(j.id); else selectable.delete(j.id); render(); });
      card.appendChild(box);
    } else card.appendChild(el('span'));
    card.appendChild(el('div', 'score ' + scoreClass(j.score || 0), j.score === null ? '–' : String(j.score)));
    var body = el('div', 'body');
    body.appendChild(link(j.applyPage || j.fullPosting || j.url, 'title', j.title));
    // Alert emails carry no posting date: what's stored is when the alert arrived.
    var when = j.postedAt ? (j.partial ? 'alert ' : 'posted ') + day(j.postedAt) : '';
    var arrangement = j.workplaceType !== 'unknown' && j.location.toLowerCase().replace(/-/g, '').indexOf(j.workplaceType) < 0 ? j.workplaceType : '';
    body.appendChild(el('div', 'meta', [j.company, j.location, arrangement, when, '#' + j.id].filter(Boolean).join(' · ')));
    var tags = el('div', 'tags');
    (opts.tags || []).forEach(function (t) { tags.appendChild(t); });
    if (j.partial) tags.appendChild(el('span', 'tag warn', 'Partial: title, company and location only'));
    if (j.applyPage) tags.appendChild(link(j.applyPage, 'tag good', 'Apply page ↗'));
    if (j.fullPosting && j.fullPosting !== j.applyPage) tags.appendChild(link(j.fullPosting, 'tag', 'Full posting ↗'));
    if (j.source === 'email') tags.appendChild(link(j.url, 'tag', 'Alert link ↗'));
    tags.appendChild(el('span', 'tag', j.source === 'email' ? 'job alert' : j.source));
    body.appendChild(tags);
    (opts.extra || []).forEach(function (n) { body.appendChild(n); });
    if (opts.summary !== false && j.summary) body.appendChild(el('p', 'summary', j.summary));
    if (opts.details !== false) {
      var more = keep(el('details'), 'fit-' + j.id);
      more.appendChild(el('summary', null, 'Why it fits, gaps' + (j.description ? ', full posting' : '')));
      var cols = el('div', 'cols');
      cols.appendChild(bullets('Why it fits', j.matchReasons));
      cols.appendChild(bullets('Gaps', j.gaps.concat(j.dealbreakers.map(function (x) { return 'Dealbreaker: ' + x; }))));
      more.appendChild(cols);
      if (j.description) more.appendChild(el('div', 'pre', j.description));
      body.appendChild(more);
    }
    (opts.after || []).forEach(function (n) { body.appendChild(n); });
    card.appendChild(body);
    return card;
  }

  function docTags(j) {
    var out = [];
    if (!j.docs) return out;
    if (j.docs.cv) out.push(link(file(j, j.docs.cv), 'tag doc', 'CV ↗'));
    if (j.docs.letter) out.push(link(file(j, j.docs.letter), 'tag doc', 'Cover letter ↗'));
    out.push(el('span', 'tag', 'v' + j.docs.version));
    return out;
  }

  function working(text) { var w = el('div', 'working'); w.appendChild(el('span', 'spin')); w.appendChild(document.createTextNode(text)); return w; }

  function redoBox(j) {
    var wrap = el('div');
    if (!ui.redoOpen.has(j.id)) return wrap;
    var ta = el('textarea'); ta.placeholder = 'What should change? e.g. "lead with the integration work, keep it to one page"';
    ta.setAttribute('aria-label', 'Note for the Tailor');
    ta.value = ui.notes[j.id] || '';
    ta.addEventListener('input', function () { ui.notes[j.id] = ta.value; });
    wrap.appendChild(ta);
    var row = el('div', 'row');
    row.appendChild(btn('Tailor again with this note', 'primary small', function () {
      var note = (ui.notes[j.id] || '').trim();
      if (note.length < 3) return toast('Write what should change first.');
      post('redo', { id: j.id, note: note, mode: $('mode').value }).then(function () {
        ui.redoOpen.delete(j.id); delete ui.notes[j.id]; ui.approve.delete(j.id); ui.tab = 'tailoring';
        toast('Tailoring #' + j.id + ' again.');
      }, fail);
    }));
    row.appendChild(btn('Cancel', 'small', function () { ui.redoOpen.delete(j.id); render(); }));
    wrap.appendChild(row);
    return wrap;
  }

  // A link to the company's own page for the job. What it does depends on where the job is:
  // on the Shortlist it reads the full posting and tailors from it; once the application is written
  // (Ready to send, stuck in Sending) it's simply where to apply, so it goes to the Submitter.
  var LINK = {
    tailor: { button: 'Fetch and tailor', busy: 'Reading the page, then scoring and tailoring…',
      note: "The company's own page for this job (from LinkedIn's Apply button, a careers site…). It's read in a hidden browser, the full posting is copied from it and scored, and your application is tailored from it. About 2–3¢ plus tailoring." },
    ready: { button: 'Approve and apply there', busy: 'Checking the page, then sending…',
      note: "Where to apply for this job (from LinkedIn's Apply button, a careers site…). Your application is already written, so this approves it and the Submitter applies on that page. The page is checked first: it must be open and about this job. No cost." },
    sending: { button: 'Apply there', busy: 'Checking the page, then sending…',
      note: "Where to apply for this job (from LinkedIn's Apply button, a careers site…). The Submitter applies on that page with your written application. The page is checked first: it must be open and about this job. No cost." }
  };
  function linkBox(j, stage) {
    var t = LINK[stage];
    var wrap = el('div');
    if (ui.linkBusy === j.id) { wrap.appendChild(working(t.busy)); return wrap; }
    if (!ui.linkOpen.has(j.id)) {
      var r = el('div', 'row');
      r.appendChild(btn(stage === 'tailor' ? 'Paste application link' : 'Paste where to apply', 'small', function () { ui.linkOpen.add(j.id); render(); }));
      wrap.appendChild(r);
      return wrap;
    }
    wrap.appendChild(el('p', 'note', t.note));
    var inp = el('input'); inp.type = 'url'; inp.placeholder = 'https://…'; inp.setAttribute('aria-label', 'Application link');
    inp.value = ui.links[j.id] || '';
    inp.style.cssText = 'width:100%;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);margin-top:8px';
    inp.addEventListener('input', function () { ui.links[j.id] = inp.value; });
    wrap.appendChild(inp);
    var row = el('div', 'row');
    row.appendChild(btn(t.button, 'primary small', function () {
      var url = (ui.links[j.id] || '').trim();
      if (!url) return toast('Paste the link first.');
      var force = false;
      if (stage === 'ready' && j.docs && j.docs.unverified.length) {
        if (!confirm('This application has claims the fact-check could not verify against your CV:\n\n' + j.docs.unverified.join('\n') + '\n\nSend anyway?')) return;
        force = true;
      }
      ui.linkBusy = j.id; render();
      post('useLink', { id: j.id, url: url, mode: $('mode').value, force: force }).then(function (r) {
        if (r.ok) {
          ui.linkOpen.delete(j.id); delete ui.links[j.id]; ui.picked.delete(j.id); ui.approve.delete(j.id);
          if (r.stage === 'tailor') { ui.tab = 'tailoring'; toast('Full posting found' + (r.score !== null ? ' (score ' + r.score + ')' : '') + ': tailoring #' + j.id + ' from it.'); }
          else { ui.tab = 'sending'; toast('Applying on that page (' + r.mode + ' mode).'); }
        } else if (r.closed) { ui.linkOpen.delete(j.id); toast('That job is no longer accepting applications: removed.'); }
        else toast('Not used: ' + r.reason + '.');
      }, fail).finally(function () { ui.linkBusy = null; render(); });
    }));
    row.appendChild(btn('Cancel', 'small', function () { ui.linkOpen.delete(j.id); render(); }));
    wrap.appendChild(row);
    return wrap;
  }

  // ------------------------------------------------------------ layout
  function renderTabs(d) {
    var nav = $('tabs'); nav.textContent = '';
    var c = { shortlist: d.shortlist.length, tailoring: d.tailoring.length, ready: d.ready.length, sending: d.sending.length, sent: d.sent.length, below: ui.below ? ui.below.length : null, cv: null };
    TABS.forEach(function (t) {
      var b = el('button', null, t.label); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(ui.tab === t.id));
      if (c[t.id] !== null) b.appendChild(el('span', 'n' + ((t.id === 'ready' || t.id === 'shortlist') && c[t.id] ? ' hot' : ''), String(c[t.id])));
      b.addEventListener('click', function () { ui.tab = t.id; if (t.id === 'below') loadBelow(); if (t.id === 'cv') loadCv(); render(); });
      nav.appendChild(b);
    });
  }

  function filtered(list) {
    return list.filter(function (j) { return ui.filter === 'all' || (ui.filter === 'partial' ? j.partial : !j.partial); });
  }

  function renderToolbar(list, selectable) {
    var bar = $('toolbar'); bar.textContent = '';
    if (ui.tab === 'shortlist' || ui.tab === 'below') {
      var seg = el('div', 'seg');
      [['all', 'All'], ['full', 'Full postings'], ['partial', 'Partial']].forEach(function (f) {
        var b = el('button', null, f[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(ui.filter === f[0]));
        b.addEventListener('click', function () { ui.filter = f[0]; render(); });
        seg.appendChild(b);
      });
      bar.appendChild(seg);
    }
    bar.appendChild(el('span', 'spacer'));
    if (selectable && list.length) {
      var lab = el('label', 'all'); var all = el('input'); all.type = 'checkbox';
      all.checked = list.every(function (j) { return selectable.has(j.id); });
      all.addEventListener('change', function () { list.forEach(function (j) { if (all.checked) selectable.add(j.id); else selectable.delete(j.id); }); render(); });
      lab.appendChild(all); lab.appendChild(document.createTextNode(' Select all shown')); bar.appendChild(lab);
    }
  }

  function renderActions(d) {
    var box = $('actions'), inner = $('actionsInner'); inner.textContent = '';
    if ((ui.tab === 'shortlist' || ui.tab === 'below') && ui.picked.size) {
      inner.appendChild(el('strong', null, ui.picked.size + ' selected'));
      // The pipeline only takes picks at its pick step, after scoring.
      var waitScout = scoutRunning(d) && !(d.pipeline && d.pipeline.stage === 'pick');
      if (waitScout) inner.appendChild(el('span', 'hint', 'You can send them once scoring finishes.'));
      inner.appendChild(el('span', 'spacer'));
      inner.appendChild(btn('Clear', '', function () { ui.picked.clear(); render(); }));
      inner.appendChild(btn('Dismiss', '', function () {
        var ids = Array.from(ui.picked);
        if (!confirm('Dismiss ' + ids.length + ' job(s)? They leave your shortlist.')) return;
        post('dismiss', { ids: ids }).then(function () { ui.picked.clear(); toast('Dismissed ' + ids.length + '.'); }, fail);
      }));
      var send = btn('Send to Tailor', 'primary', function () {
        var ids = Array.from(ui.picked);
        post('pick', { ids: ids, mode: $('mode').value }).then(function (r) {
          ui.picked.clear(); ui.tab = 'tailoring';
          toast('Tailoring ' + (r.picked ? r.picked.length : ids.length) + ' job(s)' + (r.via === 'pipeline' ? ' in your pipeline run.' : '.'));
        }, fail);
      });
      send.disabled = waitScout || ui.busy;
      inner.appendChild(send);
    } else if (ui.tab === 'ready' && ui.approve.size) {
      var chosen = d.ready.filter(function (j) { return ui.approve.has(j.id); });
      var flagged = chosen.filter(function (j) { return j.docs && j.docs.unverified.length; });
      var inPipeline = d.pipeline && d.pipeline.stage === 'review';
      var mode = inPipeline ? d.pipeline.mode : $('mode').value;
      inner.appendChild(el('strong', null, chosen.length + ' selected'));
      inner.appendChild(el('span', 'hint', 'Submitter mode: ' + mode + (inPipeline ? ' (set when the pipeline run started)' : '')));
      inner.appendChild(el('span', 'spacer'));
      inner.appendChild(btn('Clear', '', function () { ui.approve.clear(); render(); }));
      var go = btn('Approve and send', 'primary', function () {
        var force = false;
        if (flagged.length) {
          var lines = flagged.map(function (j) { return '#' + j.id + ' ' + j.company + ': ' + j.docs.unverified.join('; '); }).join('\n');
          if (!confirm(flagged.length + ' application(s) have claims the fact-check could not verify against your CV:\n\n' + lines + '\n\nSend anyway?')) return;
          force = true;
        }
        var ids = chosen.map(function (j) { return j.id; });
        post('approve', { ids: ids, force: force, mode: $('mode').value }).then(function (r) {
          ui.approve.clear(); ui.tab = 'sending';
          toast('Approved ' + ids.length + '. ' + (r.mode === 'assist' ? 'A browser window opens with each form filled: check it and click Submit.' : r.mode === 'prepare' ? 'Prepare mode: forms are filled and screenshotted, nothing is submitted.' : 'Auto mode: forms are submitted when every answer is yours.'));
        }, fail);
      });
      go.disabled = ui.busy;
      inner.appendChild(go);
    }
    box.classList.toggle('show', inner.childNodes.length > 0);
  }

  function render() {
    var d = ui.data; if (!d) return;
    renderStatus(d);
    renderTabs(d);
    var root = $('list'); root.textContent = '';
    var tab = TABS.filter(function (t) { return t.id === ui.tab; })[0];
    var list = [];
    if (ui.tab === 'shortlist' || ui.tab === 'below') {
      list = filtered(ui.tab === 'shortlist' ? d.shortlist : (ui.below || []));
      renderToolbar(list, ui.picked);
      list.forEach(function (j) { root.appendChild(jobCard(j, { select: ui.picked, after: [linkBox(j, 'tailor')] })); });
    } else if (ui.tab === 'tailoring') {
      list = d.tailoring; renderToolbar(list, null);
      list.forEach(function (j) {
        var extra = [];
        if (j.status === 'tailor_error') {
          extra.push(el('p', 'note', 'Tailoring failed: ' + (j.reason || 'unknown error')));
          var r = el('div', 'row');
          r.appendChild(btn('Try again', 'small', function () { post('retry', { ids: [j.id], mode: $('mode').value }).then(function () { toast('Tailoring #' + j.id + ' again.'); }, fail); }));
          extra.push(r);
        } else {
          var tailoring = d.tasks.some(function (t) { return t.kind === 'tailor' && !t.done && t.jobIds.indexOf(j.id) >= 0; }) || (d.pipeline && d.pipeline.stage === 'tailoring');
          if (tailoring) extra.push(working(j.reason && j.reason.indexOf('redo:') === 0 ? 'Tailoring again:' + j.reason.slice(5) : 'Writing the CV and cover letter, then fact-checking them'));
          else {
            extra.push(el('p', 'note', 'Picked, waiting for the Tailor.'));
            var r2 = el('div', 'row');
            r2.appendChild(btn('Start the Tailor', 'small primary', function () { post('pick', { ids: [j.id], mode: $('mode').value }).then(function () { toast('Tailoring #' + j.id + '.'); }, fail); }));
            extra.push(r2);
          }
        }
        root.appendChild(jobCard(j, { extra: extra, summary: false, details: false, tags: j.status === 'tailor_error' ? [el('span', 'tag bad', 'failed')] : [] }));
      });
    } else if (ui.tab === 'ready') {
      list = d.ready; renderToolbar(list, ui.approve);
      if (!d.requireApproval) root.appendChild(el('p', 'note', 'Review is off: applications go straight to the Submitter after tailoring. Only ones with claims the fact-check could not verify wait here for you.'));
      list.forEach(function (j) {
        var extra = [];
        if (j.docs && j.docs.unverified.length) {
          var ul = el('ul', 'flags');
          j.docs.unverified.forEach(function (x) { ul.appendChild(el('li', null, 'Not verified against your CV: ' + x)); });
          extra.push(ul);
        }
        if (j.docs && j.docs.feedback) extra.push(el('p', 'note', 'Your note for this version: ' + j.docs.feedback));
        var after = [];
        if (j.docs && j.docs.report) {
          var rep = keep(el('details'), 'report-' + j.id);
          rep.appendChild(el('summary', null, 'Tailoring report: what was emphasized, gaps, warnings'));
          rep.appendChild(el('div', 'pre', j.docs.report));
          after.push(rep);
        }
        var row = el('div', 'row');
        row.appendChild(btn('Redo with a note', 'small', function () { ui.redoOpen.add(j.id); render(); }));
        row.appendChild(btn('Reject', 'small danger', function () {
          if (!confirm('Reject #' + j.id + ' ' + j.company + '? You will not apply.')) return;
          post('reject', { ids: [j.id] }).then(function () { ui.approve.delete(j.id); toast('Rejected #' + j.id + '.'); }, fail);
        }));
        after.push(row);
        after.push(redoBox(j));
        after.push(linkBox(j, 'ready'));
        var tags = docTags(j);
        if (j.docs && j.docs.unverified.length) tags.push(el('span', 'tag warn', j.docs.unverified.length + ' to check'));
        root.appendChild(jobCard(j, { select: ui.approve, tags: tags, extra: extra, after: after, summary: false }));
      });
    } else if (ui.tab === 'sending') {
      list = d.sending; renderToolbar(list, null);
      list.forEach(function (j) {
        var extra = [], tags = docTags(j);
        if (j.status === 'approved') {
          var submitting = d.tasks.some(function (t) { return t.kind === 'submit' && !t.done && t.jobIds.indexOf(j.id) >= 0; }) || (d.pipeline && d.pipeline.stage === 'submitting');
          if (submitting) extra.push(working('Submitter is filling the form' + ($('mode').value === 'assist' ? ': check the browser window and click Submit' : '')));
          else {
            extra.push(el('p', 'note', 'Approved, waiting for the Submitter.'));
            var r0 = el('div', 'row');
            r0.appendChild(btn('Start the Submitter', 'small primary', function () { post('retry', { ids: [j.id], mode: $('mode').value }).then(function () { toast('Submitter started.'); }, fail); }));
            extra.push(r0);
          }
        } else {
          tags.unshift(el('span', 'tag ' + (j.status === 'failed' ? 'bad' : 'warn'), j.status === 'failed' ? 'failed' : 'needs you'));
          if (j.last) extra.push(el('p', 'note', time(j.last.at) + ' (' + j.last.mode + '): ' + (j.last.reason || j.last.outcome)));
          if (j.last && j.last.screenshot) extra.push(link(file(j, j.last.screenshot), 'tag', 'Screenshot of the form ↗'));
          var r = el('div', 'row');
          // LinkedIn and Indeed can't be applied to automatically; a copy site has no form.
          var noForm = j.last && /LinkedIn|Indeed|no application form|doesn't mention/.test(j.last.reason || '');
          if (noForm) {
            r.appendChild(btn("Find the company's application page (~7¢)", 'small primary', function () {
              toast('Looking for the application page…');
              post('findApplyPage', { id: j.id, mode: $('mode').value }).then(function (res) {
                if (res.closed) toast('That job is no longer accepting applications: removed.');
                else if (res.found) toast('Found it: the Submitter is applying (' + res.mode + ' mode).');
                else toast('No application page found: ' + res.reason + '. Apply via the alert link, then click "I applied myself".');
              }, fail);
            }));
            r.appendChild(link(j.url, 'btn small', 'Apply via the alert link ↗'));
          } else {
            r.appendChild(btn('Open it in the browser to finish', 'small primary', function () {
              post('retry', { ids: [j.id], mode: 'assist' }).then(function () { toast('Opening the form: check it and click Submit.'); }, fail);
            }));
          }
          r.appendChild(btn('I applied myself', 'small', function () {
            post('markApplied', { id: j.id }).then(function () { toast('Recorded #' + j.id + ' as applied.'); }, fail);
          }));
          extra.push(r);
          extra.push(linkBox(j, 'sending'));
        }
        root.appendChild(jobCard(j, { tags: tags, extra: extra, summary: false, details: false }));
      });
    } else if (ui.tab === 'sent') {
      list = d.sent; renderToolbar(list, null);
      list.forEach(function (j) {
        var extra = j.last.confirmation ? [el('p', 'note', j.last.confirmation)] : [];
        var after = [];
        if (j.last.modelAnswers && j.last.modelAnswers.length) {
          var box = keep(el('details'), 'answers-' + j.id);
          box.appendChild(el('summary', null, 'Answers Claude wrote on the form (' + j.last.modelAnswers.length + ')'));
          var ul = el('ul');
          j.last.modelAnswers.forEach(function (a) { ul.appendChild(el('li', null, a.label + ' (' + a.kind + '): ' + a.value)); });
          box.appendChild(ul); after.push(box);
        }
        root.appendChild(jobCard(j, { tags: [el('span', 'tag good', 'sent ' + time(j.last.at))], extra: extra, after: after, summary: false, details: false }));
      });
    }
    if (ui.tab === 'cv') { $('toolbar').textContent = ''; renderCv(root); renderActions(d); return; }
    if (!list.length) root.appendChild(el('p', 'empty', ui.tab === 'below' && !ui.below ? 'Loading…' : tab.empty));
    renderActions(d);
  }

  // ------------------------------------------------------------ your CV
  function loadCv() { fetch('/api/cv').then(function (r) { return r.json(); }).then(function (c) { ui.cv = c; render(); }); }

  function cvBody(cv, contact) {
    var box = el('div');
    box.appendChild(el('h2', null, cv.name || '(no name)'));
    var who = [cv.headline, cv.location, contact && contact.email, contact && contact.phone].filter(Boolean).join(' · ');
    if (who) box.appendChild(el('p', 'meta', who));
    var links = Object.keys(cv.links || {});
    if (links.length) { var lt = el('div', 'tags'); links.forEach(function (k) { lt.appendChild(link(cv.links[k], 'tag', k + ' ↗')); }); box.appendChild(lt); }
    if (cv.summary) { box.appendChild(el('h3', null, 'Summary')); box.appendChild(el('p', null, cv.summary)); }
    if (cv.experience.length) {
      box.appendChild(el('h3', null, 'Experience'));
      cv.experience.forEach(function (e) {
        var r = el('div', 'role'); r.appendChild(el('strong', null, e.role + ', ' + e.company));
        r.appendChild(el('span', 'hint', '  ' + [e.start, e.end || 'present'].filter(Boolean).join(' – ')));
        var ul = el('ul'); e.highlights.forEach(function (h) { ul.appendChild(el('li', null, h.text)); }); r.appendChild(ul); box.appendChild(r);
      });
    }
    if (cv.projects.length) {
      box.appendChild(el('h3', null, 'Projects'));
      cv.projects.forEach(function (p) {
        var r = el('div', 'role'); r.appendChild(el('strong', null, p.name)); if (p.stack.length) r.appendChild(el('span', 'hint', '  ' + p.stack.join(', ')));
        var ul = el('ul'); p.highlights.forEach(function (h) { ul.appendChild(el('li', null, h.text)); }); r.appendChild(ul); box.appendChild(r);
      });
    }
    if (cv.skills.length) { box.appendChild(el('h3', null, 'Skills')); var su = el('ul'); cv.skills.forEach(function (s) { su.appendChild(el('li', null, s.category + ': ' + s.items.join(', '))); }); box.appendChild(su); }
    if (cv.education.length) { box.appendChild(el('h3', null, 'Education')); var eu = el('ul'); cv.education.forEach(function (e) { eu.appendChild(el('li', null, [e.degree, e.institution, e.year].filter(Boolean).join(', '))); }); box.appendChild(eu); }
    if (cv.languages.length) { box.appendChild(el('h3', null, 'Languages')); box.appendChild(el('p', null, cv.languages.map(function (l) { return l.language + (l.level ? ' (' + l.level + ')' : ''); }).join(', '))); }
    return box;
  }

  function renderCv(root) {
    var up = el('div', 'panel');
    up.appendChild(el('h2', null, 'Upload your CV'));
    up.appendChild(el('p', 'note', 'A PDF or Word (.docx) file. Claude turns it into the CV the agents work from, keeping your own wording, and you check the result before it is saved. About 3–6¢ per upload.'));
    var row = el('div', 'row');
    var input = el('input'); input.type = 'file'; input.accept = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    input.setAttribute('aria-label', 'CV file');
    row.appendChild(input);
    var go = btn(ui.cvBusy ? 'Reading your CV…' : 'Upload CV', 'primary', function () {
      var f = input.files && input.files[0];
      if (!f) return toast('Choose a PDF or Word file first.');
      if (f.size > 10 * 1024 * 1024) return toast('That file is over 10 MB.');
      var reader = new FileReader();
      reader.onload = function () {
        ui.cvBusy = true; ui.cvPreview = null; render();
        var data = String(reader.result).split(',')[1];
        fetch('/api/cvParse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, data: data }) })
          .then(function (r) { return r.json().then(function (x) { if (!r.ok) throw new Error(x.error || r.status); return x; }); })
          .then(function (x) { ui.cvPreview = x; }, fail)
          .finally(function () { ui.cvBusy = false; render(); });
      };
      reader.readAsDataURL(f);
    });
    go.disabled = ui.cvBusy;
    row.appendChild(go);
    if (ui.cvBusy) row.appendChild(working('This takes up to a minute'));
    up.appendChild(row);
    root.appendChild(up);

    if (ui.cvPreview) {
      var pv = el('div', 'panel');
      pv.appendChild(el('p', 'note', 'Check this before saving: it replaces the CV the agents use (the current one is kept as a backup). Converted for about $' + ui.cvPreview.cost.toFixed(2) + '.'));
      if (ui.cvPreview.warnings.length) {
        var ul = el('ul', 'flags'); ui.cvPreview.warnings.forEach(function (w) { ul.appendChild(el('li', null, w)); }); pv.appendChild(ul);
      }
      pv.appendChild(cvBody(ui.cvPreview.cv, ui.cvPreview.contact));
      // Links are often clickable words with no visible address: let them be filled in here.
      pv.appendChild(el('h3', null, 'Links'));
      var linkRow = el('div', 'row');
      [['linkedin', 'LinkedIn URL'], ['github', 'GitHub URL'], ['website', 'Website or portfolio']].forEach(function (f) {
        var inp = el('input'); inp.type = 'url'; inp.placeholder = f[1]; inp.setAttribute('aria-label', f[1]);
        inp.value = ui.cvPreview.cv.links[f[0]] || '';
        inp.style.cssText = 'flex:1;min-width:200px;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)';
        inp.addEventListener('input', function () { if (inp.value.trim()) ui.cvPreview.cv.links[f[0]] = inp.value.trim(); else delete ui.cvPreview.cv.links[f[0]]; });
        linkRow.appendChild(inp);
      });
      pv.appendChild(linkRow);
      var raw = keep(el('details'), 'cv-json'); raw.appendChild(el('summary', null, 'The JSON that will be saved')); raw.appendChild(el('div', 'pre', JSON.stringify(ui.cvPreview.cv, null, 2))); pv.appendChild(raw);
      var act = el('div', 'row');
      act.appendChild(btn('Save as my CV', 'primary', function () {
        post('cvSave', { cv: ui.cvPreview.cv, contact: ui.cvPreview.contact }).then(function (r) {
          ui.cvPreview = null; loadCv(); toast('Saved.' + (r.backup ? ' The previous CV is kept as a backup.' : ''));
        }, fail);
      }));
      act.appendChild(btn('Discard', '', function () { ui.cvPreview = null; render(); }));
      pv.appendChild(act);
      root.appendChild(pv);
    }

    var cur = el('div', 'panel');
    if (!ui.cv) cur.appendChild(el('p', 'note', 'Loading your current CV…'));
    else if (!ui.cv.exists) cur.appendChild(el('p', 'note', 'No CV yet: upload one above.'));
    else {
      cur.appendChild(el('p', 'note', 'Your current CV (' + ui.cv.path + ')' + (ui.cv.todos ? ': ' + ui.cv.todos + ' TODO(s) still to fill in' : '')));
      cur.appendChild(cvBody(ui.cv.cv, ui.cv.contact));
    }
    root.appendChild(cur);
  }

  // ------------------------------------------------------------ phone access (shown on the Mac only)
  var phoneOpen = false;
  fetch('/api/phone').then(function (r) { if (r.ok) $('phoneBtn').hidden = false; }, function () {});
  $('phoneBtn').addEventListener('click', function () {
    phoneOpen = !phoneOpen;
    var box = $('phone'); box.textContent = '';
    if (!phoneOpen) return;
    fetch('/api/phone').then(function (r) { return r.json(); }).then(function (p) {
      var panel = el('div', 'panel');
      panel.appendChild(el('h2', null, 'Use this page on your phone'));
      if (!p.enabled) {
        panel.appendChild(el('p', 'note', 'Phone access is off: right now the page only answers this Mac. To turn it on, add REVIEW_REMOTE=true to .env and restart the page (npm run review). Then scan the code that appears here with your phone.'));
        panel.appendChild(el('p', 'note', 'To use it away from home, install Tailscale (free) on this Mac and your phone, signed in to the same account.'));
      } else if (!p.links.length) {
        panel.appendChild(el('p', 'note', 'This Mac has no network address right now: connect to Wi-Fi or Tailscale.'));
      } else {
        var wrap = el('div', 'phone');
        if (p.qr) { var qr = el('div', 'qr'); qr.innerHTML = p.qr; qr.setAttribute('aria-label', 'QR code for ' + p.links[0].via); wrap.appendChild(qr); }
        var info = el('div');
        info.appendChild(el('p', 'note', 'Scan with your phone camera once; the phone then remembers the key. The link contains a secret key: anyone with it can use this page, so do not share it.'));
        p.links.forEach(function (l) { var row = el('p'); row.appendChild(el('strong', null, l.via + ': ')); row.appendChild(el('code', null, l.url)); info.appendChild(row); });
        info.appendChild(el('p', 'note', 'Your Mac has to be awake with this page running. From the phone, use Auto mode: Assist opens the form on the Mac.'));
        wrap.appendChild(info);
        panel.appendChild(wrap);
      }
      panel.appendChild(btn('Close', 'small', function () { phoneOpen = false; box.textContent = ''; }));
      box.appendChild(panel);
    });
  });

  $('review').addEventListener('change', function () {
    var on = $('review').checked;
    // Shown right away, so the redraw while saving doesn't flip the switch back.
    if (ui.data) ui.data.requireApproval = on;
    post('settings', { requireApproval: on }).then(function () {
      toast(on ? 'Review is on: tailored applications wait for you in Ready to send.' : 'Review is off: tailored applications go straight to the Submitter (' + $('mode').value + ' mode). Ones with unverified claims still wait for you.');
    }, fail);
  });

  // Without a CV, clicking the greyed-out button takes you to where you upload one.
  $('runWrap').addEventListener('click', function () {
    if (ui.data && !(ui.data.cv && ui.data.cv.ready)) { ui.tab = 'cv'; loadCv(); render(); toast('Please upload a CV first.'); }
  });

  $('run').addEventListener('click', function () {
    post('run', { mode: $('mode').value }).then(function (r) {
      ui.tab = 'shortlist';
      toast((r.via === 'pipeline' ? 'Pipeline run started. ' : 'Scout started. ') + 'Matches appear here as they are scored.');
    }, fail);
  });
  refresh(true);
})();
</script>
</body>
</html>`;
