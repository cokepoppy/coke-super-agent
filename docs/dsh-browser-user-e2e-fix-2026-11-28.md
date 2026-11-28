# DSH step budget and Browser User repair

## Failure evidence

- Tetris run `cbf8e707-126f-4686-bc65-c8c9e07a1f43` produced `tetris.html` and the product preview responded to start, movement, hard drop, rotation, pause/resume, and restart. The DSH run nevertheless failed when its fixed 20-step guard fired, so the task did not reach a normal final response.
- Taobao runs `d8a13ab4-f1fc-4538-9541-63c6f2c862f1` and `92f54ec3-ad81-402c-8faa-5e8e0dc3d189` opened the Taobao homepage and attempted a visible search for `无线鼠标`. They completed without entering the results page. Neither run reported a login or verification challenge. The second run saw homepage navigation/promotions rather than product results.

## Confirmed code defects

- `run-task.mjs` enforced 20 steps regardless of task size. A task that creates an artifact and checks it with Browser/Computer Use could be terminated one step after that limit.
- `computer_browser` returned `inspectPage()` immediately after dispatching click/key input. It did not wait for a navigation, single-page route change, asynchronous results, or a newly opened tab. `activePage()` also retained the prior target even if an action created a results tab.
- Browser inspection omitted whether ordinary text/search fields still contained a value, which hid the difference between a submitted query and a query cleared by the site.

These defects explain why the tool result could be stale or incomplete. They do not prove which Taobao site behavior prevented either historical search from reaching results; the live retest must establish that.

## Changes

- Raise the bounded DSH step ceiling to 40 and retain the 25-minute task deadline.
- After browser click, fill, type, press, and scroll, wait up to five seconds for a ready and stable page. Compare the URL, navigation events, visible text, and CDP page targets; switch to a newly opened results tab when one appears.
- Return `actionState` with whether the page changed, URL changed, navigation occurred, or a new page opened. Include text-field presence and length only; never return entered field contents or password values.
- Log browser action start/completion, page origins, state-change flags, control counts, and elapsed time without logging query text or page contents.
- Include the step-budget source in the runtime cache key so a changed budget cannot reuse a stale SDK bundle.

## Verification status

- DSH runtime unit tests: 4 passed.
- TypeScript/Vite production build: passed.
- DSH runtime bundle build: passed through the local HTTP proxy; 18 archive entries, 143,809,985 bytes, runtime key `3542ddd83c83532c`, checksum `a0e981eeef6d579edba59239862405b6f1cad97918168ddf69e1ef5fff460fe5`. The archive contains `maxSessionRunSteps = 40`; its runtime key matches the API's source hash and it is cached under `~/.cache/csa-cube-node/runtime-cache`.
- Full server test command: 19 tests passed; two integration test files could not start because this checkout has no `MYSQL_USER` / `MYSQL_PASSWORD` environment. No test assertion failed.
- Public product retest with the rebuilt bundle is still required to confirm normal Tetris task completion and Taobao results-page navigation.
