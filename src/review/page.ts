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
  .stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-top: 12px; }
  .stat { border-radius: 8px; background: var(--low-bg); padding: 8px 10px; }
  .stat strong { display: block; font-size: 22px; line-height: 1.2; }
  .stat span { font-size: 12px; color: var(--muted); }
  .stat.good { background: var(--good-bg); } .stat.good strong { color: var(--good); }
  .stat.warn { background: var(--warn-bg); } .stat.warn strong { color: var(--warn); }
  .stat.bad { background: var(--danger-bg); } .stat.bad strong { color: var(--danger); }
  .panel.app { padding: 12px 14px; margin-bottom: 8px; }
  .panel.app a { color: inherit; text-decoration: none; }
  .note.todo { color: var(--warn); font-weight: 600; }
  .stage-pick { display: inline-flex; gap: 8px; align-items: center; }
  .stage-pick select { padding: 3px 6px; font-size: 14px; }
  .stats.four { grid-template-columns: repeat(4, 1fr); }
  .stats.three { grid-template-columns: repeat(3, 1fr); }
  .stat strong { word-break: break-word; }
  .bars { display: grid; grid-template-columns: minmax(90px, max-content) 1fr 32px; gap: 6px 10px; align-items: center; margin-top: 10px; font-size: 14px; }
  .bar-label { color: var(--muted); }
  .bar-track { height: 14px; background: var(--low-bg); border-radius: 4px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
  .bar-fill.good { background: var(--good); } .bar-fill.warn { background: var(--warn); }
  .bar-n { text-align: right; font-variant-numeric: tabular-nums; }
  table.grid { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
  table.grid th { text-align: left; color: var(--muted); font-weight: 600; font-size: 13px; }
  table.grid th, table.grid td { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--line); }
  @media (max-width: 560px) { .stats { grid-template-columns: repeat(3, 1fr); } .stats.four { grid-template-columns: repeat(2, 1fr); } }
  .panel h3 { font-size: 13px; margin: 14px 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .panel ul { margin: 4px 0 0; padding-left: 18px; }
  .role { margin-top: 10px; }
  .role strong { font-weight: 650; }
  .phone { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .phone .qr { background: #fff; padding: 8px; border-radius: 8px; line-height: 0; }
  .phone .qr svg { width: 200px; height: 200px; }
  .phone code { font-size: 12px; word-break: break-all; }
  dialog { border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--text); padding: 18px; width: min(600px, calc(100% - 32px)); box-shadow: 0 12px 40px rgba(0, 0, 0, .25); }
  dialog::backdrop { background: rgba(0, 0, 0, .4); }
  dialog h2 { font-size: 18px; margin: 0 0 4px; }
  dialog label { display: block; font-weight: 600; font-size: 14px; margin-top: 12px; }
  dialog label .hint { font-weight: 400; }
  dialog input[type=url] { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); margin-top: 6px; }
  dialog textarea { min-height: 180px; margin-top: 6px; }
  .settings-nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .settings-h { font-size: 13px; margin: 22px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; scroll-margin-top: 12px; }
  .field { display: grid; gap: 4px; margin-top: 10px; }
  .field label { font-weight: 600; font-size: 14px; }
  .field input[type=text], .field input[type=number] { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); max-width: 100%; }
  .slider { display: flex; gap: 12px; align-items: center; }
  .slider input[type=range] { flex: 1; accent-color: var(--accent); }
  .slider input[type=number] { width: 80px; }
  .cert { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; padding: 8px 0; border-top: 1px solid var(--line); }
  .cert:first-child { border-top: 0; }
  .add-error { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--danger-bg); color: var(--danger); font-size: 14px; }
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
    <label class="hint" for="mode">Submitter</label>
    <select id="mode">
      <option value="assist">Assist: fills the form, you click Submit</option>
      <option value="prepare">Prepare: fills and screenshots, never submits</option>
      <option value="auto">Auto: submits when every answer is yours</option>
    </select>
    <button class="btn" id="phoneBtn" type="button" hidden>On your phone</button>
    <button class="btn" id="add" type="button">Add a job</button>
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
<dialog id="addDlg" aria-labelledby="addTitle">
  <h2 id="addTitle">Add a job</h2>
  <label for="addUrl">Link to the job <span class="hint">(required)</span></label>
  <input id="addUrl" type="url" placeholder="https://…" required>
  <label for="addDesc">Job description <span class="hint">(optional: paste the posting's text)</span></label>
  <textarea id="addDesc" placeholder="Leave empty to have the posting read from the link."></textarea>
  <p class="note" id="addNote"></p>
  <p class="add-error" id="addError" role="alert" hidden></p>
  <div class="row" id="addButtons"></div>
</dialog>
<script>
(function () {
  var TABS = [
    { id: 'shortlist', label: 'Shortlist', empty: 'Nothing on your shortlist. Run Scout, or check Below cutoff.' },
    { id: 'tailoring', label: 'Tailoring', empty: 'Nothing being tailored.' },
    { id: 'ready', label: 'Ready to send', empty: 'No applications waiting for your approval.' },
    { id: 'sending', label: 'Sending', empty: 'Nothing waiting for the Submitter.' },
    { id: 'applied', label: 'Applied', empty: '' },
    { id: 'below', label: 'Below cutoff', empty: 'Nothing below the cutoff.' },
    { id: 'stats', label: 'Stats', empty: '' },
    { id: 'settings', label: 'Settings', empty: '' }
  ];
  var ui = {
    tab: 'shortlist', filter: 'all', data: null, below: null, hash: '',
    picked: new Set(), approve: new Set(), open: new Set(), notes: {}, redoOpen: new Set(), busy: false,
    cv: null, cvPreview: null, cvBusy: false, apps: null, archiveFilter: 'all',
    linkOpen: new Set(), links: {}, linkBusy: null,
    // Settings being edited: kept here so the page's redraws don't wipe what you're typing.
    cutoff: null, cert: { title: '', issuer: '', year: '', file: null }, certBusy: false, certError: ''
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
      if (ui.tab === 'applied' || ui.tab === 'stats' || ui.tab === 'settings') loadApps();
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
    tags.appendChild(el('span', 'tag', j.source === 'email' ? 'job alert' : j.source === 'manual' ? 'added by you' : j.source));
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

  // View (opens in a new tab) and download links for a tailored CV and cover letter.
  function docLinks(jobId, docs) {
    var out = [], j = { id: jobId };
    [[docs.cv, 'CV'], [docs.letter, 'Cover letter']].forEach(function (d) {
      if (!d[0]) return;
      out.push(link(file(j, d[0]), 'tag doc', d[1] + ' ↗'));
      var dl = el('a', 'tag doc', '⬇'); dl.href = file(j, d[0]) + '?download=1'; dl.setAttribute('download', '');
      dl.title = 'Download the ' + d[1].toLowerCase(); dl.setAttribute('aria-label', dl.title);
      out.push(dl);
    });
    return out;
  }
  function docTags(j) {
    if (!j.docs) return [];
    var out = docLinks(j.id, j.docs);
    out.push(el('span', 'tag', 'v' + j.docs.version));
    return out;
  }
  // The application's stage, changeable by hand. Applied and the Archive share it.
  function stageSelect(jobId, outcome) {
    var wrap = el('label', 'stage-pick');
    wrap.appendChild(el('span', 'hint', 'Status'));
    var sel = el('select');
    ['awaiting', 'viewed', 'assessment', 'interview', 'offer', 'rejected'].forEach(function (k) {
      var o = el('option', null, STAGE[k][0]); o.value = k; sel.appendChild(o);
    });
    var auto = el('option', null, 'Back to: from emails'); auto.value = 'auto'; sel.appendChild(auto);
    sel.value = outcome ? outcome.stage : 'awaiting';
    sel.addEventListener('change', function () {
      post('setStage', { id: jobId, stage: sel.value }).then(function () { toast(sel.value === 'auto' ? 'Status follows your email again.' : 'Status set to ' + STAGE[sel.value][0] + '.' + (sel.value === 'rejected' ? ' It moves to the Archive in Settings.' : '')); loadApps(); }, fail);
    });
    wrap.appendChild(sel);
    if (outcome && outcome.manual) wrap.appendChild(el('span', 'hint', 'set by you'));
    return wrap;
  }

  function working(text) { var w = el('div', 'working'); w.appendChild(el('span', 'spin')); w.appendChild(document.createTextNode(text)); return w; }

  // Takes a job off every list, whatever stage it's at. A sent application is archived instead.
  function removeRow(j) {
    var row = el('div', 'row');
    row.appendChild(btn('Remove', 'small danger', function () {
      if (!confirm('Remove #' + j.id + ' ' + j.company + ' — ' + j.title + '? It leaves every list and is not applied to.')) return;
      post('remove', { id: j.id }).then(function () { ui.picked.delete(j.id); ui.approve.delete(j.id); toast('Removed #' + j.id + '.'); }, fail);
    }));
    return row;
  }

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
    var c = { shortlist: d.shortlist.length, tailoring: d.tailoring.length, ready: d.ready.length, sending: d.sending.length, applied: ui.apps ? ui.apps.rows.filter(function (r) { return !r.archived; }).length : null, below: ui.below ? ui.below.length : null, stats: null, settings: null };
    TABS.forEach(function (t) {
      var b = el('button', null, t.label); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(ui.tab === t.id));
      if (c[t.id] !== null) b.appendChild(el('span', 'n' + ((t.id === 'ready' || t.id === 'shortlist') && c[t.id] ? ' hot' : ''), String(c[t.id])));
      b.addEventListener('click', function () { ui.tab = t.id; if (t.id === 'below') loadBelow(); if (t.id === 'settings') loadCv(); if (t.id === 'applied' || t.id === 'stats' || t.id === 'settings') loadApps(); render(); });
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
      list.forEach(function (j) { root.appendChild(jobCard(j, { select: ui.picked, after: [linkBox(j, 'tailor'), removeRow(j)] })); });
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
        extra.push(removeRow(j));
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
        extra.push(removeRow(j));
        root.appendChild(jobCard(j, { tags: tags, extra: extra, summary: false, details: false }));
      });
    }
    if (ui.tab === 'settings') { $('toolbar').textContent = ''; renderSettings(root, d); renderActions(d); return; }
    if (ui.tab === 'applied') { $('toolbar').textContent = ''; renderApplications(root, 'applied'); renderActions(d); return; }
    if (ui.tab === 'stats') { $('toolbar').textContent = ''; renderStats(root); renderActions(d); return; }
    if (!list.length) root.appendChild(el('p', 'empty', ui.tab === 'below' && !ui.below ? 'Loading…' : tab.empty));
    renderActions(d);
  }

  // ------------------------------------------------------------ stats and archive (the Archiver's report)
  var APPS_HASH = '';
  function loadApps() {
    fetch('/api/applications').then(function (r) { return r.json(); }).then(function (a) {
      var h = JSON.stringify(a); if (h === APPS_HASH) return;
      APPS_HASH = h; ui.apps = a; render();
    });
  }
  var STAGE = { awaiting: ['Waiting', ''], viewed: ['Viewed', ''], assessment: ['Assessment', 'warn'], interview: ['Interview', 'good'], offer: ['Offer', 'good'], rejected: ['Rejected', 'bad'] };
  var STAGE_ORDER = ['awaiting', 'viewed', 'assessment', 'interview', 'offer'];
  var KIND = { confirmation: 'Received', viewed: 'Viewed', rejection: 'Rejected', assessment: 'Assessment', interview: 'Interview', offer: 'Offer', update: 'Update' };
  function pct(x) { return Math.round(x * 100) + '%'; }
  function reachedAtLeast(r, stage) { return STAGE_ORDER.indexOf(r.reached) >= STAGE_ORDER.indexOf(stage); }
  function replied(r) { return r.stage === 'rejected' || reachedAtLeast(r, 'assessment'); }

  // When the Archiver last read your email, and a button to run it now.
  function archiverBar(a) {
    var top = el('div', 'row'); top.style.marginTop = '0'; top.style.alignItems = 'center';
    var running = a.lastRun && !a.lastRun.finishedAt;
    top.appendChild(el('span', 'hint', running ? 'The Archiver is reading your email…' : a.lastRun ? 'Email last checked ' + time(a.lastRun.finishedAt) + '. Checked every hour.' : 'The Archiver hasn’t run yet.'));
    top.appendChild(el('span', 'spacer'));
    var check = btn(running ? 'Checking…' : 'Check email now', 'small', function () {
      post('archive').then(function (r) { toast(r.started ? 'Reading new email. Replies show up as they are sorted.' : 'Already checking.'); loadApps(); }, fail);
    });
    check.disabled = Boolean(running);
    top.appendChild(check);
    return top;
  }

  // Horizontal bars: [label, count, class] scaled to the largest.
  function bars(items, total) {
    var box = el('div', 'bars');
    var max = Math.max(1, total || 0, Math.max.apply(null, items.map(function (i) { return i[1]; })));
    items.forEach(function (i) {
      box.appendChild(el('span', 'bar-label', i[0]));
      var track = el('span', 'bar-track'); var fill = el('span', 'bar-fill ' + (i[2] || ''));
      fill.style.width = (i[1] / max * 100) + '%'; track.appendChild(fill); box.appendChild(track);
      box.appendChild(el('span', 'bar-n', String(i[1])));
    });
    return box;
  }

  function renderStats(root) {
    var a = ui.apps;
    if (!a) { root.appendChild(el('p', 'empty', 'Loading…')); return; }
    var s = a.stats, rows = a.rows;
    var head = el('div', 'panel');
    head.appendChild(archiverBar(a));
    var tiles = el('div', 'stats');
    [['Applied', s.applied, ''], ['Waiting', s.awaiting + s.viewed, ''], ['Assessment', s.assessment, 'warn'], ['Interview', s.interview, 'good'], ['Offer', s.offer, 'good'], ['Rejected', s.rejected, 'bad']].forEach(function (t) {
      var b = el('div', 'stat ' + t[2]); b.appendChild(el('strong', null, String(t[1]))); b.appendChild(el('span', null, t[0])); tiles.appendChild(b);
    });
    head.appendChild(tiles);
    // The same applications, by who sent them: this tool, or you (from your email, or marked by you).
    var how = el('div', 'stats three');
    [['All applications', s.applied], ['Sent with this tool', s.viaTool], ['Sent by you', s.manual]].forEach(function (t) {
      var b = el('div', 'stat'); b.appendChild(el('strong', null, String(t[1]))); b.appendChild(el('span', null, t[0])); how.appendChild(b);
    });
    head.appendChild(how);
    var rates = el('div', 'stats');
    [['Response rate', pct(s.responseRate)], ['Reached an interview', pct(s.interviewRate)], ['Average wait for a reply', s.avgDaysToReply === null ? '—' : s.avgDaysToReply.toFixed(1) + ' days'], ['No reply after ' + s.quietDays + '+ days', String(s.quiet)]].forEach(function (t) {
      var b = el('div', 'stat'); b.appendChild(el('strong', null, t[1])); b.appendChild(el('span', null, t[0])); rates.appendChild(b);
    });
    rates.classList.add('four');
    head.appendChild(rates);
    root.appendChild(head);
    if (!rows.length) { root.appendChild(el('p', 'empty', 'No applications sent yet.')); return; }

    var funnel = el('div', 'panel');
    funnel.appendChild(el('h2', null, 'How far applications got'));
    funnel.appendChild(el('p', 'note', 'Counts each application at the furthest stage it reached, including ones rejected later.'));
    funnel.appendChild(bars([
      ['Applied', rows.length, ''],
      ['Got a reply', rows.filter(replied).length, ''],
      ['Assessment or further', rows.filter(function (r) { return reachedAtLeast(r, 'assessment'); }).length, 'warn'],
      ['Interview or further', rows.filter(function (r) { return reachedAtLeast(r, 'interview'); }).length, 'good'],
      ['Offer', rows.filter(function (r) { return r.reached === 'offer'; }).length, 'good']
    ], rows.length));
    root.appendChild(funnel);

    var channels = {};
    rows.forEach(function (r) {
      var k = r.via[0] || 'other'; var c = channels[k] || (channels[k] = { applied: 0, replied: 0, interview: 0 });
      c.applied++; if (replied(r)) c.replied++; if (reachedAtLeast(r, 'interview')) c.interview++;
    });
    var ch = el('div', 'panel');
    ch.appendChild(el('h2', null, 'By how you applied'));
    var table = el('table', 'grid');
    var hr = el('tr'); ['', 'Applied', 'Got a reply', 'Interview'].forEach(function (h) { hr.appendChild(el('th', null, h)); }); table.appendChild(hr);
    Object.keys(channels).sort(function (x, y) { return channels[y].applied - channels[x].applied; }).forEach(function (k) {
      var c = channels[k], tr = el('tr');
      [k.charAt(0).toUpperCase() + k.slice(1), String(c.applied), c.replied + ' (' + pct(c.replied / c.applied) + ')', c.interview + ' (' + pct(c.interview / c.applied) + ')'].forEach(function (v) { tr.appendChild(el('td', null, v)); });
      table.appendChild(tr);
    });
    ch.appendChild(table);
    root.appendChild(ch);

    // Applications sent per week, the last 10 weeks (weeks start on Sunday).
    var weeks = [], start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - start.getDay());
    for (var i = 9; i >= 0; i--) { var w = new Date(start); w.setDate(w.getDate() - 7 * i); weeks.push(w); }
    var perWeek = weeks.map(function (w, i) {
      var end = weeks[i + 1] ? weeks[i + 1].getTime() : Infinity;
      return [day(w.toISOString()), rows.filter(function (r) { var t = Date.parse(r.appliedAt); return t >= w.getTime() && t < end; }).length, ''];
    });
    var wk = el('div', 'panel');
    wk.appendChild(el('h2', null, 'Applications per week'));
    wk.appendChild(bars(perWeek));
    root.appendChild(wk);
  }

  /*
   * Your sent applications. "applied": the ones still in play, on the main page. "archive" (in Settings):
   * rejected, or nothing new for 30 days, plus picked jobs never sent. Which list each is in is worked
   * out by the server every time, so setting a stage moves it straight across.
   */
  function renderApplications(root, which) {
    var a = ui.apps;
    if (!a) { root.appendChild(el('p', 'empty', 'Loading…')); return; }
    var applied = which === 'applied';
    var rows = a.rows.filter(function (r) { return applied ? !r.archived : r.archived; });
    var filterKey = applied ? 'appliedFilter' : 'archiveFilter';
    var current = ui[filterKey] || 'all';
    var head = el('div', 'panel');
    if (applied) head.appendChild(archiverBar(a));
    else head.appendChild(el('p', 'note', 'Applications you sent here, set to Rejected yourself, or applied to over ' + a.archiveAfterDays + ' days ago, and jobs you picked but never sent. Back to Applied returns one to the main page.'));
    var chips = el('div', 'row');
    var filters = [['all', 'All', rows.length]].concat(['awaiting', 'viewed', 'assessment', 'interview', 'offer', 'rejected'].map(function (k) {
      return [k, STAGE[k][0], rows.filter(function (r) { return r.stage === k; }).length];
    }));
    if (!applied) filters.push(['not_sent', 'Not sent', a.notSent.length]);
    filters.forEach(function (f) {
      if (f[0] !== 'all' && !f[2]) return;
      chips.appendChild(btn(f[1] + ' ' + f[2], 'small' + (current === f[0] ? ' primary' : ''), function () { ui[filterKey] = f[0]; render(); }));
    });
    head.appendChild(chips);
    var todo = applied ? rows.filter(function (r) { return r.action && r.stage !== 'rejected'; }) : [];
    if (todo.length) {
      head.appendChild(el('h3', null, 'To do'));
      var tl = el('ul'); todo.forEach(function (r) { tl.appendChild(el('li', null, r.company + ': ' + r.action)); }); head.appendChild(tl);
    }
    root.appendChild(head);
    if (!applied && current === 'not_sent') {
      root.appendChild(el('p', 'note', 'Picked or tailored, never sent, and unchanged for two weeks. Restore one to pick it up where it was.'));
      if (!a.notSent.length) root.appendChild(el('p', 'empty', 'Nothing here.'));
      a.notSent.forEach(function (j) {
        var card = el('div', 'panel app');
        var line = el('div', 'row'); line.style.marginTop = '0'; line.style.alignItems = 'baseline';
        line.appendChild(el('strong', null, j.company + ' — ' + j.title));
        line.appendChild(el('span', 'spacer'));
        line.appendChild(el('span', 'tag', 'Not sent'));
        card.appendChild(line);
        card.appendChild(el('p', 'meta', 'Archived ' + day(j.archivedAt) + (j.score !== null && j.score !== undefined ? ' · score ' + j.score : '')));
        var r = el('div', 'row');
        if (j.docs) docLinks(j.docs.jobId, j.docs).forEach(function (n) { r.appendChild(n); });
        r.appendChild(btn('Restore', 'small', function () { post('restore', { id: j.id }).then(function () { toast('#' + j.id + ' is back where it was.'); loadApps(); }, fail); }));
        card.appendChild(r);
        root.appendChild(card);
      });
      return;
    }
    var shown = rows.filter(function (r) { return current === 'all' || r.stage === current; });
    if (!shown.length) {
      root.appendChild(el('p', 'empty', rows.length ? 'Nothing here.' : applied ? 'No applications in play. Sent ones appear here, and move to the Archive in Settings ' + a.archiveAfterDays + ' days after you applied, when you set them to Rejected, or with Send to archive.' : 'Nothing archived yet.'));
    }
    shown.forEach(function (r) {
      var card = el('div', 'panel app');
      var line = el('div', 'row'); line.style.marginTop = '0'; line.style.alignItems = 'baseline';
      var name = el('strong', null, r.company + (r.title ? ' — ' + r.title : ''));
      if (r.url) { var ln = link(r.url, null, ''); ln.appendChild(name); line.appendChild(ln); } else line.appendChild(name);
      line.appendChild(el('span', 'spacer'));
      var st = STAGE[r.stage];
      line.appendChild(el('span', 'tag ' + st[1], st[0] + (r.stage === 'rejected' && reachedAtLeast(r, 'assessment') ? ' after ' + STAGE[r.reached][0].toLowerCase() : '')));
      card.appendChild(line);
      card.appendChild(el('p', 'meta', 'Applied ' + day(r.appliedAt) + ' via ' + r.via.join(' and ') + (r.lastReplyAt ? ' · last reply ' + day(r.lastReplyAt) : '')));
      if (r.action && r.stage !== 'rejected') card.appendChild(el('p', 'note todo', 'To do: ' + r.action));
      // The site's confirmation, and anything Claude wrote in your name.
      if (r.sent && r.sent.confirmation) card.appendChild(el('p', 'note', 'Sent ' + time(r.sent.at) + ': ' + r.sent.confirmation));
      var tools = el('div', 'row');
      if (r.docs) docLinks(r.docs.jobId, r.docs).forEach(function (n) { tools.appendChild(n); });
      tools.appendChild(el('span', 'spacer'));
      tools.appendChild(btn(applied ? 'Send to archive' : 'Back to Applied', 'small', function () {
        post('archiveApplication', { id: r.jobIds[0], archive: applied }).then(function () {
          toast(applied ? r.company + ' is in the Archive in Settings.' : r.company + ' is back in Applied.'); loadApps();
        }, fail);
      }));
      tools.appendChild(stageSelect(r.jobIds[0], { stage: r.stage, manual: r.manual }));
      card.appendChild(tools);
      if (r.sent && r.sent.modelAnswers.length) {
        var box = keep(el('details'), 'answers-' + r.jobIds[0]);
        box.appendChild(el('summary', 'hint', 'Answers Claude wrote on the form (' + r.sent.modelAnswers.length + ')'));
        var al = el('ul');
        r.sent.modelAnswers.forEach(function (x) { al.appendChild(el('li', null, x.label + ' (' + x.kind + '): ' + x.value)); });
        box.appendChild(al); card.appendChild(box);
      }
      var answers = r.replies.filter(function (x) { return x.kind !== 'confirmation'; });
      if (answers.length) {
        var det = keep(el('details'), 'app' + r.jobIds[0]);
        det.appendChild(el('summary', 'hint', answers.length + (answers.length === 1 ? ' reply' : ' replies')));
        var ul = el('ul');
        answers.forEach(function (x) { ul.appendChild(el('li', null, day(x.receivedAt) + ' · ' + (KIND[x.kind] || x.kind) + ': ' + (x.summary || x.subject))); });
        det.appendChild(ul); card.appendChild(det);
      }
      root.appendChild(card);
    });
    if (applied && a.unmatched.length) {
      var um = keep(el('details', 'panel'), 'unmatched');
      um.appendChild(el('summary', null, a.unmatched.length + ' replies the Archiver couldn’t match to an application'));
      var ul2 = el('ul');
      a.unmatched.forEach(function (x) { ul2.appendChild(el('li', null, day(x.receivedAt) + ' · ' + (KIND[x.kind] || x.kind) + ' · ' + x.from + ': ' + (x.summary || x.subject))); });
      um.appendChild(ul2); root.appendChild(um);
    }
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

  // ------------------------------------------------------------ settings
  var SECTIONS = [['set-shortlist', 'Shortlist'], ['set-sending', 'Sending'], ['set-cv', 'Your CV'], ['set-certs', 'Certificates'], ['set-archive', 'Archive']];
  function sectionTitle(root, id, text) { var h = el('h2', 'settings-h', text); h.id = id; root.appendChild(h); }

  function renderSettings(root, d) {
    var nav = el('nav', 'settings-nav');
    SECTIONS.forEach(function (x) { nav.appendChild(btn(x[1], 'small', function () { var t = $(x[0]); if (t) t.scrollIntoView({ behavior: 'smooth' }); })); });
    root.appendChild(nav);
    sectionTitle(root, 'set-shortlist', 'Shortlist'); renderCutoff(root, d);
    sectionTitle(root, 'set-sending', 'Sending'); renderReviewSwitch(root, d);
    sectionTitle(root, 'set-cv', 'Your CV'); renderCv(root);
    sectionTitle(root, 'set-certs', 'Certificates'); renderCertificates(root);
    sectionTitle(root, 'set-archive', 'Archive'); renderApplications(root, 'archive');
  }

  // Validated here for a quick answer, and again by the server, which has the final say.
  function scoreOk(v) { return /^\d{1,3}$/.test(String(v)) && Number(v) >= 0 && Number(v) <= 100; }

  function renderCutoff(root, d) {
    var saved = d.shortlistCutoff;
    var draft = ui.cutoff || { threshold: String(saved.threshold), partial: saved.partialThreshold === null ? '' : String(saved.partialThreshold) };
    var p = el('div', 'panel');
    p.appendChild(el('p', 'note', 'Scout scores every job from 0 to 100 for how well it fits your CV and preferences: 75 and up is a strong fit, 65 good, 55 a stretch. Jobs at or above the minimum go on your Shortlist; the rest wait under Below cutoff. Jobs you add yourself always stay on it.'));

    var f1 = el('div', 'field');
    var l1 = el('label', null, 'Minimum score'); l1.htmlFor = 'cutRange'; f1.appendChild(l1);
    var row = el('div', 'slider');
    var range = el('input'); range.type = 'range'; range.id = 'cutRange'; range.min = '0'; range.max = '100'; range.step = '1';
    range.value = scoreOk(draft.threshold) ? draft.threshold : String(saved.threshold);
    var num = el('input'); num.type = 'number'; num.min = '0'; num.max = '100'; num.step = '1'; num.value = draft.threshold; num.setAttribute('aria-label', 'Minimum score');
    function edit(threshold, partial) { ui.cutoff = { threshold: threshold, partial: partial }; }
    range.addEventListener('input', function () { num.value = range.value; edit(range.value, draft.partial); draft.threshold = range.value; check(); });
    num.addEventListener('input', function () { if (scoreOk(num.value)) range.value = num.value; edit(num.value, draft.partial); draft.threshold = num.value; check(); });
    row.appendChild(range); row.appendChild(num); f1.appendChild(row);
    p.appendChild(f1);

    var f2 = el('div', 'field');
    var l2 = el('label', null, 'Minimum for job alerts known only by their title'); l2.htmlFor = 'cutPartial'; f2.appendChild(l2);
    var partial = el('input'); partial.type = 'number'; partial.id = 'cutPartial'; partial.min = '0'; partial.max = '100'; partial.step = '1'; partial.placeholder = 'Same as above';
    partial.value = draft.partial;
    partial.addEventListener('input', function () { edit(draft.threshold, partial.value); draft.partial = partial.value; check(); });
    f2.appendChild(partial);
    f2.appendChild(el('span', 'hint', 'Scored on a title alone, these score lower; leave empty to use the minimum above.'));
    p.appendChild(f2);

    var msg = el('p', 'add-error'); msg.hidden = true; p.appendChild(msg);
    var act = el('div', 'row');
    var save = btn('Save', 'primary small', function () {
      var body = { threshold: Number(draft.threshold), partialThreshold: draft.partial === '' ? null : Number(draft.partial) };
      post('shortlistCutoff', body).then(function (r) {
        ui.cutoff = null;
        toast('Saved: minimum score ' + r.threshold + '. ' + (r.up || r.down ? r.up + ' job(s) moved onto your shortlist, ' + r.down + ' off it.' : 'Your shortlist already matches it.'));
      }, function (e) { msg.textContent = e.message; msg.hidden = false; });
    });
    var reset = btn('Undo changes', 'small', function () { ui.cutoff = null; render(); });
    function check() {
      var problem = !scoreOk(draft.threshold) ? 'The minimum score must be a whole number from 0 to 100.'
        : draft.partial !== '' && !scoreOk(draft.partial) ? 'The minimum for job alerts must be a whole number from 0 to 100, or empty.' : '';
      msg.textContent = problem; msg.hidden = !problem;
      var changed = draft.threshold !== String(saved.threshold) || draft.partial !== (saved.partialThreshold === null ? '' : String(saved.partialThreshold));
      save.disabled = Boolean(problem) || !changed; reset.disabled = !changed;
    }
    act.appendChild(save); act.appendChild(reset); p.appendChild(act);
    check();
    root.appendChild(p);
  }

  function renderReviewSwitch(root, d) {
    var p = el('div', 'panel');
    var lab = el('label', 'switch'); lab.title = 'When off, tailored applications go straight to the Submitter';
    var input = el('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = d.requireApproval;
    input.addEventListener('change', function () {
      var on = input.checked;
      // Shown right away, so the redraw while saving doesn't flip the switch back.
      if (ui.data) ui.data.requireApproval = on;
      post('settings', { requireApproval: on }).then(function () {
        toast(on ? 'Review is on: tailored applications wait for you in Ready to send.' : 'Review is off: tailored applications go straight to the Submitter (' + $('mode').value + ' mode). Ones with unverified claims still wait for you.');
      }, fail);
    });
    lab.appendChild(input); lab.appendChild(document.createTextNode(' Review before sending'));
    p.appendChild(lab);
    p.appendChild(el('p', 'note', 'On: tailored applications wait for your approval in Ready to send. Off: they go straight to the Submitter; any with claims the fact-check could not verify still wait for you.'));
    root.appendChild(p);
  }

  var CERT_EXT = /\.(pdf|png|jpe?g)$/i;
  var CERT_MAX = 5 * 1024 * 1024;
  function size(n) { return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB'; }

  function renderCertificates(root) {
    var p = el('div', 'panel');
    p.appendChild(el('p', 'note', 'Certificates you hold. The Tailor may list the ones relevant to a job on your CV, using the title you give here, and the Submitter attaches them only when an application form has a field for certificates. PDF, PNG or JPG, up to 5 MB each.'));
    var certs = ui.cv ? ui.cv.certificates || [] : null;
    var list = el('div');
    if (!certs) list.appendChild(el('p', 'note', 'Loading…'));
    else if (!certs.length) list.appendChild(el('p', 'note', 'No certificates yet.'));
    else certs.forEach(function (c) {
      var row = el('div', 'cert');
      row.appendChild(el('strong', null, c.title));
      var meta = [c.issuer, c.year].filter(Boolean).join(' · ');
      if (meta) row.appendChild(el('span', 'hint', meta));
      row.appendChild(el('span', 'hint', c.type.toUpperCase() + ', ' + size(c.size) + ', added ' + day(c.uploadedAt)));
      row.appendChild(el('span', 'spacer'));
      row.appendChild(link('/certificates/' + encodeURIComponent(c.id), 'tag', 'View ↗'));
      row.appendChild(btn('Remove', 'small danger', function () {
        if (!confirm('Remove "' + c.title + '"? The file is deleted.')) return;
        post('certificateRemove', { id: c.id }).then(function () { toast('Removed.'); loadCv(); }, fail);
      }));
      list.appendChild(row);
    });
    p.appendChild(list);

    p.appendChild(el('h3', null, 'Add a certificate'));
    var c = ui.cert;
    var fileField = el('div', 'field');
    var input = el('input'); input.type = 'file'; input.accept = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'; input.setAttribute('aria-label', 'Certificate file');
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      ui.certError = '';
      if (!f) { c.file = null; return render(); }
      if (!CERT_EXT.test(f.name)) { c.file = null; ui.certError = 'Choose a PDF, PNG or JPG file.'; return render(); }
      if (f.size > CERT_MAX) { c.file = null; ui.certError = 'That file is over 5 MB.'; return render(); }
      var reader = new FileReader();
      reader.onload = function () {
        // Read now: the page redraws every few seconds, which would empty the file picker.
        c.file = { name: f.name, size: f.size, data: String(reader.result).split(',')[1] };
        if (!c.title) c.title = f.name.replace(CERT_EXT, '').replace(/[_-]+/g, ' ').trim();
        render();
      };
      reader.readAsDataURL(f);
    });
    fileField.appendChild(input);
    if (c.file) fileField.appendChild(el('span', 'hint', 'Chosen: ' + c.file.name + ' (' + size(c.file.size) + ')'));
    p.appendChild(fileField);
    [['title', 'Title, as it should read on your CV', 'e.g. AWS Certified Developer – Associate'], ['issuer', 'Issued by (optional)', 'e.g. Amazon Web Services'], ['year', 'Year (optional)', 'e.g. 2024']].forEach(function (x) {
      var f = el('div', 'field');
      var lab = el('label', null, x[1]); lab.htmlFor = 'cert-' + x[0]; f.appendChild(lab);
      var inp = el('input'); inp.type = 'text'; inp.id = 'cert-' + x[0]; inp.placeholder = x[2]; inp.value = c[x[0]];
      inp.maxLength = x[0] === 'year' ? 4 : 200;
      inp.addEventListener('input', function () { c[x[0]] = inp.value; });
      f.appendChild(inp); p.appendChild(f);
    });
    if (ui.certError) p.appendChild(el('p', 'add-error', ui.certError));
    var act = el('div', 'row');
    var add = btn(ui.certBusy ? 'Adding…' : 'Add certificate', 'primary small', function () {
      if (!c.file) { ui.certError = 'Choose the certificate file first.'; return render(); }
      if (!c.title.trim()) { ui.certError = "Give the certificate's title, as it should read on your CV."; return render(); }
      if (c.year.trim() && !/^(19|20)\d{2}$/.test(c.year.trim())) { ui.certError = 'The year should look like 2024.'; return render(); }
      ui.certBusy = true; ui.certError = '';
      post('certificateAdd', { name: c.file.name, data: c.file.data, title: c.title, issuer: c.issuer, year: c.year }).then(function () {
        ui.cert = { title: '', issuer: '', year: '', file: null }; toast('Certificate added.'); loadCv();
      }, function (e) { ui.certError = e.message; }).finally(function () { ui.certBusy = false; render(); });
    });
    add.disabled = ui.certBusy || (certs && certs.length >= 20);
    act.appendChild(add);
    if (certs && certs.length >= 20) act.appendChild(el('span', 'hint', 'You have the maximum of 20: remove one to add another.'));
    p.appendChild(act);
    root.appendChild(p);
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

  // ------------------------------------------------------------ add a job yourself
  var adding = false;
  var WHERE = { shortlisted: 'on your Shortlist', selected: 'in Tailoring', tailor_error: 'in Tailoring', tailored: 'in Ready to send', approved: 'in Sending', needs_manual: 'in Sending', failed: 'in Sending', submitted: 'already sent' };
  function addState() {
    var has = $('addDesc').value.trim().length > 0;
    $('addNote').textContent = has
      ? "Your description is what gets scored and tailored from. The link is only where the Submitter applies: it isn't opened now. A cent or two to read which job it is."
      : "The posting is read off the page at this link (a few cents), then scored onto your shortlist, or sent straight to the Tailor without scoring. Use the job's own page: LinkedIn, Indeed and Glassdoor can't be read, so open the job there, click Apply, and paste the page you land on.";
    var row = $('addButtons'); row.textContent = '';
    if (adding) { row.appendChild(working(has ? 'Reading the description…' : 'Opening the page and reading the posting…')); return; }
    row.appendChild(btn(has ? 'Score it' : 'Add and score', 'primary', function () { submitAdd('score'); }));
    row.appendChild(btn('Send straight to Tailor', '', function () { submitAdd('tailor'); }));
    row.appendChild(btn('Cancel', '', function () { $('addDlg').close(); }));
  }
  // Shown in the dialog: a toast would sit behind its backdrop.
  function addError(msg) { $('addError').textContent = msg || ''; $('addError').hidden = !msg; }
  function submitAdd(next) {
    var url = $('addUrl').value.trim();
    if (!url || !$('addUrl').checkValidity()) { $('addUrl').focus(); return addError("Paste the job's full link, starting with https://"); }
    addError(''); adding = true; $('addUrl').disabled = true; $('addDesc').disabled = true; addState();
    post('addJob', { url: url, description: $('addDesc').value, next: next, mode: $('mode').value }).then(function (r) {
      var cost = r.cost ? ' ($' + r.cost.toFixed(2) + ')' : '';
      if (!r.ok) return addError('Not added: ' + r.reason + (r.existing ? ', ' + (WHERE[r.existing.status] || r.existing.status) : '') + '.' + cost);
      $('addDlg').close(); $('addUrl').value = ''; $('addDesc').value = '';
      var what = '#' + r.id + ' ' + r.company + ' — ' + r.title;
      if (r.next === 'tailor') { ui.tab = 'tailoring'; toast('Added ' + what + ': tailoring it now' + cost + '.'); }
      else if (r.score !== null) { ui.tab = 'shortlist'; toast('Added ' + what + ' to your shortlist, score ' + r.score + cost + '.'); }
      else toast('Added ' + what + ', but scoring failed (' + (r.scoreError || 'unknown error') + '): Scout scores it on its next run' + cost + '.');
    }, function (e) { addError('Failed: ' + e.message); }).finally(function () { adding = false; $('addUrl').disabled = false; $('addDesc').disabled = false; addState(); render(); });
  }
  $('add').addEventListener('click', function () { addError(''); addState(); $('addDlg').showModal(); $('addUrl').focus(); });
  $('addDesc').addEventListener('input', function () { addError(''); addState(); });
  $('addUrl').addEventListener('input', function () { addError(''); });
  // Escape doesn't close it mid-request: the answer would have nowhere to show.
  $('addDlg').addEventListener('cancel', function (e) { if (adding) e.preventDefault(); });

  // Without a CV, clicking the greyed-out button takes you to where you upload one.
  $('runWrap').addEventListener('click', function () {
    if (ui.data && !(ui.data.cv && ui.data.cv.ready)) { ui.tab = 'settings'; loadCv(); loadApps(); render(); toast('Please upload a CV first.'); }
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
