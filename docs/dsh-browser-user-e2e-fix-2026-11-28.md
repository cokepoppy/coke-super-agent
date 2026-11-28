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
