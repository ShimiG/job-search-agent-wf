import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * A daily Scout run through launchd, macOS's own scheduler: no server has to be running. If the Mac
 * is asleep at that time, launchd runs it on wake. The run opens the review page when jobs reach
 * your shortlist.
 *
 *   npm run schedule -- on 08:00 [--days sun-thu]   install or change it (default: every day)
 *   npm run schedule -- status       when it runs, and the end of its log
 *   npm run schedule -- off          remove it
 */

const LABEL = 'com.job-agents.scout';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const ROOT = process.cwd();
const LOG = path.join(ROOT, 'data', 'logs', 'scout-schedule.log');
const DOMAIN = `gui/${process.getuid?.() ?? 501}`;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "sun-thu", "mon,wed,fri", "sun-tue,thu": launchd weekdays, 0 = Sunday. */
export function parseDays(spec: string): number[] {
  const days = new Set<number>();
  for (const part of spec.toLowerCase().split(',').map((p) => p.trim()).filter(Boolean)) {
    const [from, to = from] = part.split('-').map((d) => DAY_NAMES.indexOf(d.slice(0, 3)));
    if (from! < 0 || to! < 0) throw new Error(`Unknown day in "${spec}": use sun, mon, tue, wed, thu, fri, sat`);
    for (let d = from!; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return [...days].sort();
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(hour: number, minute: number, days: number[]): string {
  const at = (extra: string) => `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer>${extra}</dict>`;
  const when = days.length === 7 ? at('') : `<array>\n${days.map((d) => `    ${at(`<key>Weekday</key><integer>${d}</integer>`)}`).join('\n')}\n  </array>`;
  // The absolute node path: launchd doesn't load your shell, so nvm's node isn't on its PATH.
  const args = [process.execPath, '--import', 'tsx', path.join(ROOT, 'src', 'cli.ts'), 'run', '--open-review'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>StartCalendarInterval</key>
  ${when}
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path.dirname(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

const launchctl = (...args: string[]) => execFileSync('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const unload = () => {
  try {
    launchctl('bootout', `${DOMAIN}/${LABEL}`);
  } catch {
    // Not loaded: nothing to remove.
  }
};

const describeDays = (days: number[]) => (days.length === 7 ? 'every day' : days.map((d) => DAY_NAMES[d]).join(', '));

function on(time = '08:00', daySpec = 'sun-sat') {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(`Use a 24-hour time like 08:00, not "${time}"`);
  const [hour, minute] = [Number(m[1]), Number(m[2])];
  const days = parseDays(daySpec);
  mkdirSync(path.dirname(PLIST), { recursive: true });
  mkdirSync(path.dirname(LOG), { recursive: true });
  writeFileSync(PLIST, plist(hour, minute, days));
  unload();
  launchctl('bootstrap', DOMAIN, PLIST);
  console.log(`Scout will run ${describeDays(days)} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}.`);
  console.log(`Log: ${LOG}`);
  console.log(`Node: ${process.execPath} (run "npm run schedule -- on ${time} --days ${daySpec}" again if you switch Node versions)`);
}

function off() {
  unload();
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log('Daily Scout run removed.');
}

function status() {
  if (!existsSync(PLIST)) return console.log('No daily Scout run. Set one with: npm run schedule -- on 08:00');
  const p = readFileSync(PLIST, 'utf8');
  const hour = /<key>Hour<\/key><integer>(\d+)/.exec(p)?.[1] ?? '?';
  const weekdays = [...p.matchAll(/<key>Weekday<\/key><integer>(\d)/g)].map((x) => Number(x[1]));
  const minute = /<key>Minute<\/key><integer>(\d+)/.exec(p)?.[1] ?? '?';
  let loaded = true;
  try {
    launchctl('print', `${DOMAIN}/${LABEL}`);
  } catch {
    loaded = false;
  }
  console.log(`${weekdays.length ? describeDays(weekdays) : 'Every day'} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} · ${loaded ? 'active' : 'installed but not loaded (run "on" again)'}`);
  if (existsSync(LOG)) console.log(`\nEnd of ${LOG}:\n` + readFileSync(LOG, 'utf8').trim().split('\n').slice(-12).join('\n'));
}

const argv = process.argv.slice(2);
const daysAt = argv.indexOf('--days');
const daySpec = daysAt >= 0 ? argv.splice(daysAt, 2)[1] : undefined;
const [command, arg] = argv;
try {
  if (process.platform !== 'darwin') throw new Error('Scheduling uses launchd, which is macOS only. Elsewhere use "npm run scout -- watch".');
  if (command === 'on') on(arg, daySpec);
  else if (command === 'off') off();
  else if (command === 'status') status();
  else console.log('Usage: npm run schedule -- on [HH:MM] [--days sun-thu] | off | status');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
