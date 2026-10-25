import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Logger } from '../util/logger.ts';

export const reviewUrl = () => `http://127.0.0.1:${process.env.REVIEW_PORT ?? 4100}`;

function openInBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  // No browser opener (a headless server): the URL is still logged.
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

/**
 * Shows you the review page once Scout has something for you: opens it if it's running, otherwise
 * starts it in the background (it opens itself when ready). REVIEW_AUTO_OPEN=false turns this off.
 */
export async function openReviewPage(logger: Logger): Promise<string> {
  const url = reviewUrl();
  if (process.env.REVIEW_AUTO_OPEN === 'false') return url;
  const running = await fetch(`${url}/`, { signal: AbortSignal.timeout(1000) }).then(
    (r) => r.ok,
    () => false,
  );
  if (running) {
    openInBrowser(url);
  } else {
    // Detached, so the page keeps running after this run (or the LangGraph server) ends.
    spawn(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'src', 'review', 'server.ts')], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, REVIEW_NO_OPEN: '' },
    })
      .on('error', (err) => logger.warn(`could not start the review page: ${err.message}`))
      .unref();
  }
  logger.info(`Your shortlist is ready to review: ${url}`);
  return url;
}
