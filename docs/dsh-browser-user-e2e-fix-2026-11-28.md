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

## Follow-up diagnosis and repair pass (2026-11-28)

### Confirmed blockers in the product retest

- Run `5d417122-6ee6-4978-98e0-b6cb2a397064` never reached DSH: the request waited eight minutes for the tenant desktop, then failed while the guest desktop bootstrap was still progressing. The task readiness deadline was shorter than the configured desktop bootstrap budget (30 minutes); XFCE and Chromium later became ready.
- Run `2fa5d84b-8c0e-4f39-8337-318eec023dc0` passed the desktop health probe but failed before `harness.step.start`: guest workspace setup used Cube PTY and hit its 45-second deadline. The existing `tetris.html` visible in the thread was from an older task and is not evidence for either run.
- The HTTP health checks could return 200 while the public web port was served by an orphaned Vite process from `coke-super-agent-dsh-remote-sandbox-study`. The expected public-web LaunchAgent was repeatedly failing to bind port 5174. This is a deployment identity-check defect; it does not indicate a DSH or browser failure.

### Repairs

- Share a 30-minute desktop readiness budget with the desktop bootstrap budget so a progressing Linux desktop is not abandoned at eight minutes.
- Release `.2` switched workspace setup to Cube envd `commands.run` with a 180-second hard deadline. Live run `16f1616c-32e7-4a08-9500-0bab16c116cb` failed after 180.8 seconds with `deadline_exceeded` before any DSH step.
- Read-only inspection confirmed the template's `/workspace/.csa-super-agent`, `/workspace/.csa-super-agent/runs`, and `/workspace/tasks` directories already existed and belonged to the `user` account. An isolated guest PTY probe for only the two per-run `install -d -o 1000 -g 1000` operations completed in seconds; the temporary probe directories were removed. The SDK envd stream deadline, not the requested UI or DSH tool, was the active failure point.
- Release `.3` skips redundant parent creation and `chown`, creates only the run and task directories with UID/GID 1000 through the working guest PTY, and records start/completion milestones. The PTY deadline is two minutes.
- Release `0.1.0-dev.20261128.2` checks the listener PID, working directory, and release build path for API and public-web ports after deployment and rollback. HTTP health alone no longer counts as successful release verification.

### Verification before public UI retest

- TypeScript and Vite production build: passed.
- Server test suite: 25 passed using a temporary isolated MySQL schema; the schema and its temporary grant were removed after the run.
- DSH runtime tests: 4 passed, including route stabilization and the bounded 40-step/25-minute task budget.
- After the `.3` workspace change, TypeScript/Vite build passed, desktop readiness tests passed (5), and DSH runtime tests passed (4).
- Release deploy/rollback shell syntax and `git diff --check`: passed.
- Public UI acceptance for a fresh Tetris artifact and a real Taobao product-results page: still pending.

### `.3` public retest and runtime assembly timeout

- The `.3` deploy script stopped while waiting for `com.coke.super-agent.api` to unload. The API label disappeared after the script's 3-second wait window; both `.3` LaunchAgents were then installed and bootstrapped manually. API, local web, public health, and listener identity checks confirmed both services were running from `.3/source` and `.3/web`. The release script wait window is now 30 seconds for the next deployment.
- Signed-in Chrome submitted a fresh Tetris task through the public UI: `c1160736-3b64-4b3e-9530-f339605a9a94`. The `.3` PTY workspace setup passed in 16.5 seconds and logged `guest.workspace.ready`; this confirms the `.2` envd deadline failure is no longer the blocker.
- The runtime cache was a host-side hit and the 143,809,985-byte Linux ARM64 DSH archive was prepared in 1.2 seconds. The configured base template, `coke-super-agent-desktop-pipe-retry-20261125`, had no matching DSH runtime markers in the guest, so the first task had to cold-transfer the bundle.
- All 35 upload chunks reached the microVM. The guest then concatenated them slowly: `csa_bundle_assembly 8/35` at 04:14:08Z, `16/35` at 04:15:55Z, and `24/35` at 04:19:13Z. `stageRuntimeBundle()` stopped the operation at its 10-minute assembly deadline; the run failed at 04:23:01Z with `等待 microVM 拼接并校验依赖包超过 10 分钟。` No `harness.step.start` was recorded, so this is not evidence of a DSH model or step-budget failure, and no fresh artifact was created.
- Commit `8f30d21` temporarily raised the guest assembly timeout to 20 minutes and added release `.4` scripts. This did not address the architecture failure and `.4` was never deployed. The timeout increase is being removed; `.4` scripts are being withdrawn.

### Architecture correction

- The approved architecture in `docs/dsh-docker-cube-remote-execution-study.md` and the merged `main` checkpoint is one Docker container per tenant for DSH, XFCE, Chrome, noVNC, and Browser/Computer tools, plus that tenant's Cube microVM for remote Bash, code execution, apt, and the persistent workspace.
- The feature branch had diverged before that implementation was merged. Its task dispatcher therefore ran the old guest Harness path and uploaded a 143.8 MB runtime archive into Cube. This contradicted the accepted design; the slow guest assembly was a symptom of that regression.
- The feature branch is being reconciled with the validated Docker DSH implementation. Product execution must fail closed if `CSA_DSH_PLACEMENT` is not `docker`; no task should upload or install DSH in a Cube guest.
- The `.3` run failure remains recorded accurately: 35 chunks transferred, guest assembly reached 24/35 before the 10-minute limit, and no `harness.step.start` occurred. This was not a DeepSeek response or step-budget failure.

### Docker execution restored on the feature branch

- The active feature branch was reconciled with `main` at the Docker DSH architecture checkpoint. Task dispatch now requires `CSA_DSH_PLACEMENT=docker`; application config rejects `cube` placement before the server starts. The old guest archive timeout is back at 10 minutes, and release `.4` was removed because it was never deployed.
- Built `csa-super-agent-desktop:20261128.10` from the existing ARM64 base image. Image ID: `sha256:c8a84987ef4bd669a4c333a0bcec053878ff68f61e747e58edf9d5cfba71cddc`; size: 924,138,603 bytes; DSH runtime key: `993ab6f3b625cc1775cd07ef68b1efa5877fbe11de4c4c941af4f9e8387f85b0`. The 143,811,512-byte runtime bundle is in the image, not copied into the Cube guest.
- Build completed in 160 seconds. The fixed official 99,239,965-byte ARM64 runtime wheel downloaded through `http://127.0.0.1:7890` in 62.6 seconds. `npm ci` initially rejected corrupt cache entries, refetched packages through the proxy, and added 38 packages in 23 seconds. Temporary build context was removed by the builder.
- Verification after reconciliation: TypeScript/Vite build passed; DSH runtime tests passed 4/4; public routing tests passed 3/3; configuration check confirmed `CSA_DSH_PLACEMENT=cube` fails closed; Docker image import smoke printed `dsh_sdk_client_import_smoke_ok`; release `.5` shell syntax and `git diff --check` passed.
- `npm test` ran 42 server tests: 40 passed; `api.test.ts` and `task-store.test.ts` could not import the server because this shell did not have the external MySQL user/password environment. They were not rerun against the shared application schema. Public product E2E for a fresh Tetris generation and Taobao search remains pending.

### `.5` deployment and visible UI status

- Feature commit `c3c36ee` was pushed on `feat/dsh-agent-runtime`; deployment `.5` completed from that commit. Its preflight saw zero active Agent runs. Migration 4, both LaunchAgents, API/web and public health, listener paths, and anonymous API `401` passed.
- The release set `CSA_DSH_PLACEMENT=docker` and `CSA_DOCKER_DESKTOP_IMAGE=csa-super-agent-desktop:20261128.10`. Existing Alice/Bob desktop containers were still on `.9`; the app upgrades each on the next task after checking for active DSH PIDs, preserving their named volumes.
- Visible product acceptance could not start because `mcp__cua_repl` repeatedly timed out before returning any browser state: global `getState()` at 30 seconds, `getState()` again at 15 seconds, and direct `getBrowser()` for the known product URL at 15 seconds. No click or task submission occurred, so there is no new run ID and both Tetris and Taobao UI E2Es remain pending. Stop repeated CUA attempts until the surface recovers; continue through the existing signed-in Chrome profile when available.

### `.5` visible Tetris retry and workspace regression

- Native Chrome access recovered. A fresh Tetris task was submitted in the signed-in public UI; run `bf3de0a9-31e9-44b6-8d0c-fa36b584a0bc`, thread `93ddd592-fe65-443d-ba9b-bced4ce4719a`.
- The task selected DSH, reused the tenant Cube VM, upgraded Alice's desktop container from `.9` to `.10`, and confirmed XFCE, Chrome CDP, and noVNC ready in 14.5 seconds. The visible page still says “preparing the microVM” because the task also uses Cube for its persistent remote-Bash workspace; API logs confirm the runtime engine is DSH and the desktop is Docker.
- The run then failed at `cube.task-workspace.prepare.failed` after 45.729 seconds with Cube envd `deadline_exceeded`; DSH was not started and there was no `harness.step.start`. The active Docker DSH dispatcher used `sandbox.commands.run(... timeoutMs: 45_000)` to create `/workspace/tasks/<threadId>`.
- The same envd command path had previously failed at a 180-second deadline, while the guest PTY workspace setup completed in 16.5 seconds in run `c1160736-3b64-4b3e-9530-f339605a9a94`. The code now routes this small Cube workspace command through the existing `runGuestPty` helper with a 120-second bound and records `transport=cube-pty`. This remains remote Bash in Cube; DSH, desktop, and Chrome stay in Docker.
- The workspace transport fix must be built, deployed, and confirmed in a new visible product run before attributing any result to DSH/model steps. Tetris generation/preview and Taobao results-page acceptance both remain pending.

### `.6` public Tetris run and remote-terminal idle timeout

- Release `.6` (`928dbcc`) fixed task-workspace preparation: the visible run `38986410-d058-4ce9-92e0-4fd3fe697bb9` reused Alice's Cube VM, upgraded/reused the Docker desktop, passed XFCE/Chrome CDP/noVNC readiness, created its task workspace with `cube-pty`, and entered DSH step 1.
- The remaining DSH terminal bridge in `src/server/http.ts` still used Cube envd `sandbox.commands.run`. Calls with a 10-second tool deadline failed with `command timed out after 10000ms of inactivity`; subsequent retries consumed all 40 DSH steps and the UI marked the run failed at `2026-11-28T05:30:26Z`. The run therefore does not prove a model or Tetris defect, and it did not pass artifact/interactive verification.
- Fix on the current feature branch: route `computer_terminal` through the existing Cube PTY stream, cap captured output at 48 KiB, record bridge start/completion/failure with transport and timing metadata, and enforce a 60-second minimum tool deadline in both the Docker plugin and API. The DSH still runs in Docker; PTY Bash remains inside the tenant Cube microVM.
- Verification for this patch so far: TypeScript/Vite build passed; DSH runtime tests passed 5/5 (including the minimum deadline); PTY capture/bounding test passed 1/1; `git diff --check` passed. Built `csa-super-agent-desktop:20261128.11` in 22 seconds from the cached 143,811,512-byte runtime bundle; image ID is `sha256:f7bc7a22b9e4c54d8ad294fff9d2f5501f1d6ec4fb984b7200b5420ec4043b6f`, size 924,138,606 bytes, ARM64, runtime key unchanged. The temporary 310,489,088-byte build context was removed; the new plugin import smoke passed. Release `.7` scripts target this image and contain only deploy/rollback scripts. Deployment, fresh public Tetris artifact/preview, and Taobao results-page E2E remain pending.

### `.7` Tetris pass and Taobao navigation diagnosis

- Public UI run `491694a3-d116-43a4-92ed-5d47220b39d2` completed the fresh Tetris artifact in 10 steps, below the 40-step limit. Artifact: `/workspace/tasks/93ddd592-fe65-443d-ba9b-bced4ce4719a/tetris-e2e-20261128.html` (15,843 bytes); extracted inline JavaScript passed `node --check`. The signed-in public product preview rendered the game, and visible controls verified start, left, rotate, hard drop (score increased), pause, continue, and restart (score reset). This is a functional public UI pass.
- Public UI Taobao run `74d4fa38-0e69-4b63-8daf-4a9b79374fb2` navigated successfully but inspected the page before its dynamic homepage content appeared: title was `淘宝`, while visible text, headings, and controls were all zero. The next fill failed with `Expected exactly one visible target, found 0.` No login or verification challenge appeared. This run did not reach results and is a fail, not an acceptance.
- Confirmed runtime gap: `computer_browser.navigate` returned after document readiness and did not wait for observable rendered content. The fix now waits up to five seconds for stable page text or visible controls, reconnects to a replacement tab when needed, returns the inspected page state to DSH, and logs settlement plus title/text/heading/control counts. If the homepage remains blank after that wait, the next read-only test may use Taobao's official search route for a wireless mouse and inspect the rendered results. Stop on any sign-in or human-verification challenge.
- PTY bridge hardening and navigation-settlement changes passed DSH runtime tests (6/6), PTY bridge tests (3/3), TypeScript/Vite production build, Node syntax checks, and `git diff --check`.
- Built Docker desktop image `csa-super-agent-desktop:20261128.12`, ARM64 image ID `sha256:1268a22789e11b951fcf427f8720e15adfcd2fb87c5a77250f3273e377924f5d`, runtime key `f190b8c4d56dd571d9bf60e876c85dc47e9c66e415913fc92c42d2d4146c5c6d`. Plugin import smoke passed. Release `.8` contains only deploy and rollback scripts; deployment and fresh Taobao public UI verification remain pending.

### `.8` public retest and navigation-handler fix

- Release `.8` deployed successfully from `7e0e230`. Its preflight found zero active runs; migration 4, API, local web, public health, listener identity, and anonymous API `401` passed.
- Public UI follow-up run `b423fd15-aac2-4533-9e50-c0e5cc01d57a` exercised the new navigation wait, but all three navigate attempts failed with `Assignment to constant variable.` The rendered debug trace identifies the handler statement that assigned the settlement result back to its `const page` binding. DSH completed in 5 steps / 4 Browser calls, but Taobao showed only “加载中...” with no product names or prices; this is a fail, not a results-page pass.
- Fixed the handler to inspect the page returned by navigation settlement through `settleAndInspectBrowserPage()`. Added a regression test that verifies the selected result page is the one inspected and returned. DSH runtime tests now pass 7/7; `node --check`, TypeScript/Vite build, and `git diff --check` pass.
- Built desktop image `.13`: ARM64 image ID `sha256:99a2ecfdd29f36a0df47117729ab1e44e7a4af7d13e3d6a25dbe58ede9fb1ae5`, DSH runtime key `21e36af0966558f0ca9f62cd721af43c2d096cb1d96fd668bd58fcb7429164f3`; plugin import smoke passed. Release `.9` contains only deploy and rollback scripts. Deployment and a fresh public Taobao results verification are pending.

### `.9` public retest and shared action-handler fix

- Release `.9` deployed successfully from `3cec395`. Preflight found zero active runs; migration 4, API, local web, public health, listener identity, and anonymous API `401` passed.
- Public UI run `13acfa8f-31ca-4c26-be64-00ac624f3596` confirmed the navigation handler now returns page state: the Taobao homepage exposed a search field, and the official result URL opened with 19 visible controls. The follow-up fill/type actions then hit the same `Assignment to constant variable.` defect in the shared click/fill/type/press handler, which also tried to assign `page = settled.page` to a `const`. The run finished, but no products were visible; the official result view showed “加载中…”. This is not a pass.
- Both navigation and follow-up actions now use the shared `settleAndInspectBrowserPage()` helper, which inspects and returns the page selected by settlement. Navigation allows 15 seconds and does not treat a loading placeholder plus filter controls as finished content. Added regression coverage for the selected-page return path and a result page that renders after a simulated slow load. DSH runtime tests pass 8/8; TypeScript/Vite build, Node syntax, and whitespace checks pass.
- Built desktop image `.14`: ARM64 image ID `sha256:190dfb12b7e4e84f457aac3b9604d939ff29609b50e4a1e787bc2940301fc4d4`, runtime key `1ca330bb250d3cd81944c107b94a0208d31536c953a6f8126e5de4dbc4f80940`. Plugin import smoke passed. Release `.10` contains only deploy and rollback scripts. Deployment and another public Taobao UI retest remain pending.

### `.10` public retest and sign-in handoff

- Release `.10` deployed from `dbe54e9`. Public Browser User run `b6d2da45-d1d1-492b-ad6a-bae8da339d17` navigated to Taobao, filled `无线鼠标`, and tried Enter plus visible search-button clicks. The homepage URL did not change. The official results URL remained at `https://s.taobao.com/search?q=%E6%97%A0%E7%BA%BF%E9%BC%A0%E6%A0%87` with an empty title and a “加载中…” view after a 15-second settle; no product name or price was visible. The run correctly reported failure; do not count the URL alone as acceptance.
- A second public run `2b3eba98-a34e-4820-88f2-d789c93c13c6` repeated the search with additional read-only scroll/inspect waits. On the official results route, body text grew from 141 to 786 characters and visible controls from 19 to 86; the agent then detected a Taobao account sign-in dialog and transitioned to `run.waiting_for_user`. No credential or verification value was entered. The user must take control in the Coke Super Agent “云电脑” view to complete sign-in; resume only after their handoff and verify a visible product card/name and price.
- `.10` logs show Browser User navigation and actions completed without the earlier `Assignment to constant variable` defect. This narrows the current blocker to the live Taobao session gate/results rendering; it does not prove a product-level browser-tool failure or a successful Taobao search. Tetris remains passed (run `491694a3-d116-43a4-92ed-5d47220b39d2`, 10 DSH steps, playable preview controls verified).
- Do not merge `feat/dsh-agent-runtime` into `main` while Taobao acceptance is waiting for the user or otherwise unpassed. Keep the current run intact and continue after the user completes the sign-in handoff.
