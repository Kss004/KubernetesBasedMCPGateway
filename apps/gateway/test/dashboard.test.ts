import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDashFiles } from '../src/dashboard.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));

describe('loadDashFiles', () => {
  it('maps the fixed files and woff2 fonts to exact paths', () => {
    const d = tmp();
    for (const f of ['index.html', 'app.js', 'style.css']) fs.writeFileSync(path.join(d, f), f);
    fs.mkdirSync(path.join(d, 'fonts'));
    fs.writeFileSync(path.join(d, 'fonts', 'Switzer-Variable.woff2'), 'font');
    fs.writeFileSync(path.join(d, 'fonts', 'Switzer-FFL.txt'), 'licence'); // not a font: not served
    fs.writeFileSync(path.join(d, 'fonts', 'bad name.woff2'), 'x'); // outside the name pattern
    fs.mkdirSync(path.join(d, 'fonts', 'nested.woff2')); // a directory with a font-like name

    const files = loadDashFiles(d);
    assert.deepEqual([...files.keys()].sort(), ['/', '/app.js', '/fonts/Switzer-Variable.woff2', '/index.html', '/style.css']);
    const font = files.get('/fonts/Switzer-Variable.woff2')!;
    assert.equal(font.type, 'font/woff2');
    assert.equal(font.buf.toString(), 'font');
    assert.match(font.etag, /^"[0-9a-f]{16}"$/);
  });

  it('works without a fonts dir', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'index.html'), 'x');
    assert.deepEqual([...loadDashFiles(d).keys()].sort(), ['/', '/index.html']);
  });
});
