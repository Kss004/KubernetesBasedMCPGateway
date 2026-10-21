// P5 dashboard files: React build output (apps/dashboard/dist, fixed file names).
// Preloaded once at boot into a URL -> file map; requests are matched by exact path only,
// so a URL is never joined onto the filesystem (no traversal).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type DashFile = { buf: Buffer; type: string; etag: string };

const etagOf = (buf: Buffer) => `"${createHash('sha256').update(buf).digest('hex').slice(0, 16)}"`;
const FONT_NAME = /^[A-Za-z0-9._-]+\.woff2$/;

export function loadDashFiles(dashDir: string): Map<string, DashFile> {
  const files = new Map<string, DashFile>();
  const entries: Array<[string, string, string]> = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'application/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ];
  for (const [url, file, type] of entries) {
    try {
      const buf = fs.readFileSync(path.join(dashDir, file));
      files.set(url, { buf, type, etag: etagOf(buf) });
    } catch {
      // leave unmapped; GET / then 503s instead of serving a partial app
    }
  }
  // Web fonts: fonts/ is listed once here and each .woff2 becomes one exact path. A missing
  // dir is fine: the CSS falls back to system fonts (Switzer is fetched at build time by
  // scripts/fetch-fonts.sh and never committed; its licence forbids redistribution).
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(dashDir, 'fonts'));
  } catch {
    // no fonts dir
  }
  for (const name of names) {
    if (!FONT_NAME.test(name)) continue;
    try {
      const buf = fs.readFileSync(path.join(dashDir, 'fonts', name));
      files.set(`/fonts/${name}`, { buf, type: 'font/woff2', etag: etagOf(buf) });
    } catch {
      // unreadable or a directory; skip it
    }
  }
  return files;
}
