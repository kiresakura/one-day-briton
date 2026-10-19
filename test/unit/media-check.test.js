import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FORMAT, checkMediaFolder, webpSize } from '../../scripts/media-check.mjs';
import { MEDIA } from '../../play/js/ui/screen-model.js';

const MEDIA_DIR = fileURLToPath(new URL('../../play/media/', import.meta.url));

test('play/media has every file of the MEDIA table, within the limits and listed in credits.json', () => {
  const result = checkMediaFolder(MEDIA_DIR, { ffprobe: false });
  assert.deepEqual(result.errors, []);
  assert.equal(result.count, MEDIA.length);
  assert.ok(Object.keys(FORMAT).every((name) => MEDIA.some((item) => item.file === name)));
});

test('the backgrounds are 1920x1080, read from the WebP header', () => {
  for (const name of ['bg-title.webp', 'bg-rules.webp']) assert.deepEqual(webpSize(readFileSync(join(MEDIA_DIR, name))), { width: 1920, height: 1080 });
  assert.equal(webpSize(Buffer.from('not a webp file, just some text')), null);
});

test('the check reports a missing file, a file the projector does not use, and sizes that do not match credits.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-check-'));
  try {
    for (const item of MEDIA) if (item.file !== 'gavel.mp3') copyFileSync(join(MEDIA_DIR, item.file), join(dir, item.file));
    writeFileSync(join(dir, 'extra.webp'), 'x');
    copyFileSync(join(MEDIA_DIR, 'loop-1.mp4'), join(dir, 'loop-2.mp4'));
    const { errors } = checkMediaFolder(dir, { ffprobe: false });
    assert.ok(errors.some((e) => e.startsWith('gavel.mp3（法槌）：檔案不在')));
    assert.ok(errors.some((e) => e.startsWith('credits.json 列了 gavel.mp3')));
    assert.ok(errors.some((e) => e.startsWith('extra.webp：不在 MEDIA 表上')));
    assert.ok(errors.some((e) => e.startsWith('extra.webp：credits.json 沒有列')));
    assert.ok(errors.some((e) => e.startsWith('loop-2.mp4：credits.json 寫')));
    assert.ok(errors.some((e) => e.startsWith('loop-2.mp4：credits.json 的 sha256')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
