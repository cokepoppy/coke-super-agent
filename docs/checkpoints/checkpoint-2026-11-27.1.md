# Coke Super Agent progress checkpoint

Date: 2026-11-27

## Git identity

- Branch: `feat/dsh-agent-runtime`
- Checkpoint tag: `checkpoint-2026-11-27.1`
- Tag type: annotated source checkpoint; this is not a release tag.
- Code parent at checkpoint: `514320f2eaa96ba591a0912534365a0c58f6fb78`
- `origin/main` at checkpoint: `afa706d84db418513c3b8ba753874d7ebbc24a5a`
- The feature branch was in sync with `origin/feat/dsh-agent-runtime` before this document was added. It had 13 commits on top of `origin/main`; the checkpoint document is the next commit. The work is not merged to `main`.

## Implemented

- A single TypeScript control-plane application with MySQL-backed users, isolated Alice/Bob tenant records, tasks, ordered debug events and persistent task artifacts.
- CubeSandbox control-plane calls create or recover one persistent microVM per tenant. The tenant workspace is mounted under `/workspace`; the Cube management API stays server-side.
- The standard ARM64 OCI image build preinstalls XFCE, Google Chrome, Node.js, Python, `apt`, DSH and Pi runtimes before Cube snapshots the image as a template. Tenant startup is intended to start the desktop session without installing the base packages at VM boot.
- DSH and Pi runtimes are selectable. Browser and Computer Use tools, task handoff state, task artifact preview/download, and the task/activity debug timeline are present in the application.
- Public access uses the VPS Nginx reverse proxy and SSH reverse tunnel to the Mac-hosted application; application and tenant data remain on the Mac/Cube node.
- Release directories contain deploy/rollback scripts only; image and runtime build artifacts are kept outside the repository.

## Verification evidence

- Earlier active-run recovery acceptance: a real DSH Bash task survived an API process restart, reconnected to its existing guest PTY without launching a second Harness, completed, and returned the same persisted file. Bob received 404 when requesting Alice's artifact. Detailed evidence is in `docs/template-build-incident-2026-11-21.md`, section “2026-11-27 release 0.1.0-dev.20261127.3 active DSH recovery”.
- Public UI click acceptance: Chrome was visibly signed in as Alice at `/super-agent/`. The generated `tetris.html` preview rendered a 10×20 board; clicking restart, left, rotate, hard-drop, pause and resume changed the visible game state and the score reached 36.
- The Tetris artifact is 31,681 bytes and self-contained. The corresponding DSH run did **not** complete: the UI shows a 25-minute Harness timeout. Its trace recorded `ECONNREFUSED 127.0.0.1:9222` for Browser Use and `scrot: Can't open X display [:1]` for Computer Use; Bash calls succeeded. The preview working does not turn that task into a successful DSH acceptance.
- The verified Mac M5/Lima path previously exposed ARM64 `/dev/kvm` and successfully executed KVM API operations. The investigation did not prove that nested virtualization caused the Chrome failure. See `docs/template-build-incident-2026-11-21.md` and `docs/cube-preflight.md`.

## Current live state and confirmed gaps

- There were no queued or working tasks at the latest read-only check.
- Alice's MySQL row says `running/ready`, last updated `2026-11-27T05:30:01.532Z`, while the guest had no listeners on 5900 or 6080, a stale desktop-session marker, and only a headless Chrome listener on 9222. The guest's PID 1 is Python and the image has neither `tini` nor `dumb-init`. This confirms that the stored desktop-ready state can disagree with the live guest.
- Bob's VM is `running`, but its desktop state is `failed` and Browser state is `unavailable`.
- The source currently lets a task-purpose VM start reuse a running VM without probing a `ready` desktop. The Agent Runtime proceeds once the VM is running and does not wait for desktop readiness. This can start DSH without X11/VNC or a usable browser.
- Repeated desktop-session cleanup currently signals the entire process group at once. The guest PID 1 is Python, not a reaper; zombie accumulation was observed during the recent diagnostics. Any child subreaper must remain alive while session children shut down. The DSH timeout's provider/runtime cause remains unconfirmed and should not be attributed solely to this desktop-state bug.
- The Lima node root filesystem is 82% used with about 2.8 GiB free; `/data/cubelet` is 75% used with about 26 GiB free. Do not begin another image/template build until node system-disk scheduling headroom is restored and measured.
- Full acceptance is incomplete: the current desktop state must be repaired; Browser/Computer Use must work inside the tenant microVM; a new image/template must be built and verified; then real DSH, browser and desktop takeover, file/browser persistence, app/node restart recovery, and tenant isolation must be retested together.

## Next implementation step

On this existing feature branch, make task startup probe and repair stale desktop readiness and wait for a healthy desktop before starting the guest Agent Runtime. Add a child subreaper to the prebuilt desktop image and keep it alive while session children shut down so it can reap them. After code checks pass, restore safe Cube-node disk headroom, build a new image/template, then repeat the public Alice/Bob acceptance without treating preview-only behavior as runtime proof.
