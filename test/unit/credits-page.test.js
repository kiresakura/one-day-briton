import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PLAY = fileURLToPath(new URL('../../play/', import.meta.url));
const page = readFileSync(`${PLAY}credits.html`, 'utf8');
const images = JSON.parse(readFileSync(`${PLAY}assets/credits.json`, 'utf8'));
const media = JSON.parse(readFileSync(`${PLAY}media/credits.json`, 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const entry = (id) => {
  const start = page.indexOf(`<li class="credit" id="${id}">`);
  return start < 0 ? '' : page.slice(start, page.indexOf('</li>', start));
};

test('the credits page lists every film, music, sound and background of play/media/credits.json', () => {
  assert.match(page, new RegExp(`<h2 id="g-media">影音<span class="credit-count">${media.length}</span></h2>`));
  for (const item of media) {
    const html = entry(item.slot);
    assert.ok(html, `${item.slot} is on the page`);
    for (const text of [item.label, item.title, item.creator, ...item.modifications]) assert.ok(html.includes(esc(text)), `${item.slot}: ${text}`);
    assert.ok(html.includes(`href="${esc(item.license_url)}" rel="license"`), `${item.slot}: licence link`);
    assert.ok(html.includes(`href="${esc(item.source_page)}"`), `${item.slot}: source page`);
  }
});

test('the credits page shows only pictures that exist, none of the dropped B versions, and loads nothing from media/', () => {
  const sources = [...page.matchAll(/src="\.\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sources.length >= images.length);
  for (const src of sources) assert.ok(existsSync(`${PLAY}${src}`), src);
  assert.doesNotMatch(page, /-b\.webp|version B|B lighter/);
  assert.doesNotMatch(page, /["(]\.?\/?media\//);
});

test('every picture listed in assets/credits.json is there with the listed size', () => {
  for (const item of images) {
    for (const file of item.files) {
      assert.doesNotMatch(file.path, /-b\.webp$/);
      assert.equal(statSync(`${PLAY}assets/${file.path}`).size, file.bytes, file.path);
    }
  }
});
