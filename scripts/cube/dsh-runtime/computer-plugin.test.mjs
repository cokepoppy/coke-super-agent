import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleAndInspectBrowserPage, waitForBrowserActionSettle } from './computer-plugin.mjs';

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async durationMs => { value += durationMs; },
  };
}

test('waits for a same-tab route change and stable document before returning', async () => {
  const clock = fakeClock();
  let reads = 0;
  const states = [
    { url: 'https://www.taobao.com/', title: '淘宝', readyState: 'complete', text: '首页', navigationSerial: 0 },
    { url: 'https://s.taobao.com/search?q=mouse', title: '搜索结果', readyState: 'interactive', text: '搜索中', navigationSerial: 1 },
    { url: 'https://s.taobao.com/search?q=mouse', title: '搜索结果', readyState: 'complete', text: '商品列表', navigationSerial: 1 },
    { url: 'https://s.taobao.com/search?q=mouse', title: '搜索结果', readyState: 'complete', text: '商品列表', navigationSerial: 1 },
  ];
  const result = await waitForBrowserActionSettle({
    page: { targetId: 'home' },
    previousTargetIds: new Set(['home']),
    initialUrl: 'https://www.taobao.com/',
    initialText: '首页',
    readTargets: async () => [{ id: 'home', type: 'page', url: 'https://www.taobao.com/' }],
    readPage: async () => states[Math.min(reads++, states.length - 1)],
    connectTarget: async target => ({ targetId: target.id }),
    timeoutMs: 2_000,
    minWaitMs: 400,
    pollIntervalMs: 200,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.settled, true);
  assert.equal(result.pageChanged, true);
  assert.equal(result.urlChanged, true);
  assert.equal(result.navigationObserved, true);
  assert.equal(result.observedUrl, 'https://s.taobao.com/search?q=mouse');
  assert.ok(reads >= 4);
});

test('switches to a new page opened by a browser action', async () => {
  const clock = fakeClock();
  const home = { targetId: 'home' };
  let readCount = 0;
  const result = await waitForBrowserActionSettle({
    page: home,
    previousTargetIds: new Set(['home']),
    initialUrl: 'https://www.taobao.com/',
    initialText: '首页',
    readTargets: async () => clock.now() >= 200
      ? [
          { id: 'home', type: 'page', url: 'https://www.taobao.com/' },
          { id: 'results', type: 'page', url: 'https://s.taobao.com/search?q=mouse' },
        ]
      : [{ id: 'home', type: 'page', url: 'https://www.taobao.com/' }],
    readPage: async page => {
      readCount += 1;
      if (page.targetId === 'results') {
        return { url: 'https://s.taobao.com/search?q=mouse', title: '搜索结果', readyState: 'complete', text: '商品列表', navigationSerial: 0 };
      }
      return { url: 'https://www.taobao.com/', title: '淘宝', readyState: 'complete', text: '首页', navigationSerial: 0 };
    },
    connectTarget: async target => ({ targetId: target.id }),
    timeoutMs: 2_000,
    minWaitMs: 400,
    pollIntervalMs: 200,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.settled, true);
  assert.equal(result.targetChanged, true);
  assert.equal(result.pageChanged, true);
  assert.equal(result.page.targetId, 'results');
  assert.equal(result.observedUrl, 'https://s.taobao.com/search?q=mouse');
  assert.ok(readCount >= 3);
});

test('returns an unsettled state after a bounded wait when the page keeps changing', async () => {
  const clock = fakeClock();
  const result = await waitForBrowserActionSettle({
    page: { targetId: 'page' },
    previousTargetIds: new Set(['page']),
    initialUrl: 'https://example.com/',
    initialText: '',
    readTargets: async () => [{ id: 'page', type: 'page', url: 'https://example.com/' }],
    readPage: async () => ({ url: 'https://example.com/', title: 'Example', readyState: 'complete', text: String(clock.now()), navigationSerial: 0 }),
    connectTarget: async target => ({ targetId: target.id }),
    timeoutMs: 1_000,
    minWaitMs: 500,
    pollIntervalMs: 200,
    now: clock.now,
    sleep: async durationMs => { clock.now(); await clock.sleep(durationMs); },
  });

  assert.equal(result.settled, false);
  assert.equal(result.pageChanged, true);
  assert.equal(result.observedUrl, 'https://example.com/');
  assert.equal(result.elapsedMs, 1_000);
});

test('waits for rendered page text or controls after navigation before reporting settled', async () => {
  const clock = fakeClock();
  let reads = 0;
  const result = await waitForBrowserActionSettle({
    page: { targetId: 'taobao' },
    previousTargetIds: new Set(['taobao']),
    initialUrl: 'about:blank',
    initialText: '',
    requireObservableContent: true,
    readTargets: async () => [{ id: 'taobao', type: 'page', url: 'https://www.taobao.com/' }],
    readPage: async () => {
      reads += 1;
      const readyState = 'complete';
      if (clock.now() < 400) return { url: 'https://www.taobao.com/', title: '淘宝', readyState, text: '', visibleControlCount: 0, navigationSerial: 1 };
      return { url: 'https://www.taobao.com/', title: '淘宝', readyState, text: '搜索商品', visibleControlCount: 1, navigationSerial: 1 };
    },
    connectTarget: async target => ({ targetId: target.id }),
    timeoutMs: 1_000,
    minWaitMs: 200,
    pollIntervalMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.settled, true);
  assert.equal(result.pageChanged, true);
  assert.equal(result.contentChanged, true);
  assert.equal(result.observedUrl, 'https://www.taobao.com/');
  assert.ok(reads >= 5);
});

test('inspects and returns the page selected by navigation settlement', async () => {
  const clock = fakeClock();
  const homePage = { targetId: 'home' };
  const resultPage = { targetId: 'results' };
  let inspectedPage;
  const result = await settleAndInspectBrowserPage({
    page: homePage,
    previousTargetIds: new Set(['home']),
    initialUrl: 'https://www.taobao.com/',
    initialText: '首页',
    readTargets: async () => [
      { id: 'home', type: 'page', url: 'https://www.taobao.com/' },
      { id: 'results', type: 'page', url: 'https://s.taobao.com/search?q=mouse' },
    ],
    readPage: async page => ({
      url: page.targetId === 'results' ? 'https://s.taobao.com/search?q=mouse' : 'https://www.taobao.com/',
      title: page.targetId === 'results' ? '搜索结果' : '淘宝',
      readyState: 'complete',
      text: page.targetId === 'results' ? '商品列表' : '首页',
      navigationSerial: 1,
    }),
    connectTarget: async target => resultPage,
    inspectPage: async page => {
      inspectedPage = page;
      return { title: '搜索结果', url: 'https://s.taobao.com/search?q=mouse', text: '商品列表' };
    },
    timeoutMs: 1_000,
    minWaitMs: 200,
    pollIntervalMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.page, resultPage);
  assert.equal(inspectedPage, resultPage);
  assert.equal(result.result.title, '搜索结果');
  assert.equal(result.settled, true);
});
