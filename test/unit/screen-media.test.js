// 投影端下載素材（play/js/ui/screen-model.js 的 download、readStream；screen.js 的 fetchMedia 照它下載）：假的 fetch 照假時間一段一段給
// 位元組，看連續 30 秒沒有新的位元組時有沒有中止、位元組一直來時會不會被誤判；收到中止時假的回應與讀取丟 AbortError，跟瀏覽器一樣。
import test from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_STALL_MS, download, readStream } from '../../play/js/ui/screen-model.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 回應在 respondAfter 毫秒後到；內容照 gaps 給：第 i 段等 gaps[i] 毫秒，每段 1000 位元組。
function fakeFetch({ respondAfter = 0, gaps = [] } = {}) {
  const calls = [];
  const fetchImpl = (url, { signal } = {}) => {
    const call = { url, signal, reads: 0 };
    calls.push(call);
    const wait = (ms, value) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        const timer = setTimeout(() => resolve(value), ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    let index = 0;
    const reader = {
      read() {
        call.reads += 1;
        return index < gaps.length ? wait(gaps[index++], { done: false, value: new Uint8Array(1000) }) : Promise.resolve({ done: true, value: undefined });
      },
    };
    return wait(respondAfter, { ok: true, status: 200, body: { getReader: () => reader } });
  };
  return { fetchImpl, calls };
}

// 假時間往前走 ms 毫秒，每 step 毫秒讓等著的 promise 接著跑。
async function advance(t, ms, step = 500) {
  for (let passed = 0; passed < ms; passed += step) {
    t.mock.timers.tick(step);
    await flush();
  }
}

function settle(promise) {
  const state = { done: false, value: undefined, error: undefined };
  promise.then(
    (value) => Object.assign(state, { done: true, value }),
    (error) => Object.assign(state, { done: true, error }),
  );
  return state;
}

test('素材下載：每 10 秒來一段，下載超過 30 秒也照樣下完（每一段都重新計時）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fetchImpl, calls } = fakeFetch({ respondAfter: 1_000, gaps: [10_000, 10_000, 10_000, 10_000, 10_000] });
  const got = [];
  const state = settle(download(fetchImpl, 'media/opening.mp4', { onChunk: (chunk) => got.push(chunk.length) }));
  await advance(t, 50_000);
  assert.equal(state.done, false, 'still reading at 50 s');
  assert.equal(calls[0].signal.aborted, false);
  await advance(t, 2_000);
  assert.equal(state.error, undefined);
  assert.equal(state.value.length, 5);
  assert.deepEqual(got, [1000, 1000, 1000, 1000, 1000]);
  assert.equal(calls[0].signal.aborted, false, 'never aborted');
});

test('素材下載：送了一段之後停 35 秒，第 30 秒就中止（丟 AbortError），不等它續送', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(MEDIA_STALL_MS, 30_000);
  const { fetchImpl, calls } = fakeFetch({ respondAfter: 1_000, gaps: [1_000, 35_000, 1_000] });
  const got = [];
  const state = settle(download(fetchImpl, 'media/loop-1.mp4', { onChunk: (chunk) => got.push(chunk.length) }));
  await advance(t, 31_500); // 最後一段在 2 秒到；31.5 秒時離最後一段 29.5 秒
  assert.equal(state.done, false, 'not yet 30 s since the last bytes');
  await advance(t, 1_000);
  assert.equal(state.done, true, 'stopped 30 s after the last bytes');
  assert.equal(state.error?.name, 'AbortError');
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(got, [1000]);
  await advance(t, 10_000);
  assert.deepEqual(got, [1000], 'nothing read after the stop');
});

test('素材下載：伺服器 30 秒都不回應也中止；check 回 false（不存在、格式不對）就不讀內容', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = fakeFetch({ respondAfter: 60_000, gaps: [1_000] });
  const waiting = settle(download(slow.fetchImpl, 'media/bell.mp3'));
  await advance(t, 29_500);
  assert.equal(waiting.done, false);
  await advance(t, 1_000);
  assert.equal(waiting.error?.name, 'AbortError');
  const skipped = fakeFetch({ gaps: [1_000] });
  const responses = [];
  const none = settle(download(skipped.fetchImpl, 'media/bell.mp3', { check: (response) => (responses.push(response), false) }));
  await advance(t, 1_000);
  assert.equal(none.value, null);
  assert.equal(responses.length, 1);
  assert.equal(skipped.calls[0].reads, 0, 'body not read');
  // 不讀內容也不會之後才被中止
  await advance(t, 40_000);
  assert.equal(skipped.calls[0].signal.aborted, false);
});

test('readStream：每一段都告訴卡住的計時（progress），交給 onChunk，讀完回傳全部段落', async () => {
  const parts = [new Uint8Array(3), new Uint8Array(5)];
  const reader = { read: async () => (parts.length ? { done: false, value: parts.shift() } : { done: true, value: undefined }) };
  let progress = 0;
  const seen = [];
  const chunks = await readStream(reader, { progress: () => (progress += 1) }, (chunk) => seen.push(chunk.length));
  assert.equal(progress, 2);
  assert.deepEqual(seen, [3, 5]);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [3, 5],
  );
});

