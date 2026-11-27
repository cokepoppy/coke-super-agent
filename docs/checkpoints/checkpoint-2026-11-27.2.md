# Coke Super Agent progress checkpoint

Date: 2026-11-27

## Git identity

- Feature branch: `codex/dsh-remote-sandbox-study`
- Checkpoint tag: `checkpoint-2026-11-27.2` (annotated source checkpoint, not a product release)
- The tag is created after the tested feature branch is fast-forwarded into `main`.
- `origin/main` baseline: `afa706d84db418513c3b8ba753874d7ebbc24a5a`
- Prior checkpoint `checkpoint-2026-11-27.1` remains unchanged and records the earlier Cube-only desktop experiment.

## Implemented architecture

- One TypeScript application and one business MySQL database for users, tasks, events and tenant records.
- Each tenant has one ARM64 Docker container for DeepSeek Harness, XFCE, Chrome and noVNC, plus distinct persistent desktop and DSH runtime volumes.
- Each tenant retains a CubeSandbox microVM for isolated Bash and persistent task workspace. DSH local Bash and file tools are disabled; the remote terminal bridge targets only that tenant's Cube microVM.
- The Docker image default is `csa-super-agent-desktop:20261127.9`. Alpha and Beta have distinct containers and named volumes.
- MySQL tenant leases prevent two API processes from running the same tenant queue concurrently. Durable Docker launch intent and process/state reconciliation prevent task relaunch after an uncertain start. DSH trace events carry the guest sequence and resume from the highest sequence already committed in MySQL.
- The Coke Dots style task history, activity feed, artifacts, computer view and noVNC control continue through the existing VPS reverse tunnel. No VPS Nginx or tunnel configuration was changed.
- Release directories remain script-only; no runtime archives, Docker images or build artifacts were added.

## Automated verification

- TypeScript check and Vite production build passed for public base path `/super-agent/`.
- Twenty-four focused TypeScript tests passed, covering tenant leases, launch intent, DSH startup recovery, trace cursor normalization, browser readiness, session directory selection and noVNC routing.
- Three public-routing tests passed, covering app/API/noVNC paths, SSE/WebSocket proxying and the Mac reverse tunnel.
- The trace-cursor SQL was exercised read-only against the application database and a synthetic JSON query returned the expected maximum sequence. No shared schema or Docker data was cleaned.

## Live acceptance

- Alpha and Beta both run image `.9`; both desktop session, Chrome 158 CDP and noVNC probes report ready. Their `/workspace` and `/var/lib/csa-agent-runtime` named volumes are distinct.
- A real Alpha DSH run used remote Bash to write and read a test artifact in the Cube microVM. The artifact persisted and downloaded byte-for-byte; Beta cannot list Alpha's task or artifact and cannot read Alpha's workspace marker.
- Alpha's public noVNC view displayed the guest desktop. Visible keyboard input opened `https://example.com` in guest Chrome. Restarting the Alpha desktop container preserved its profile volume; after the normal Chrome restore prompt, the page returned.
- Active-run API recovery was exercised with run `7df6920b-2989-4dc2-86da-d9902621f57d`. API SIGINT occurred during Harness `session.run()`. The restarted API attached to the original run PID, recorded one Harness launch, finished the task, and served the exact 36-byte Cube artifact through the authenticated product download route.
- The added launch-intent-without-state recovery window is covered by unit tests; that narrow crash window was not artificially induced in a live container. The trace-cursor fix was made after the live recovery test and is covered by tests and a read-only MySQL query; it was not followed by another billable DSH run.

## Limits and safeguards

- Chrome runs with `--no-sandbox` under Docker's default seccomp and `no-new-privileges`; this weakens Chrome's inner isolation.
- The Cube APFS data volume is unencrypted. The Mac host had about 20 GiB free at the last check; Docker reported large existing images and build cache. No Docker prune, K3D cleanup, MySQL cleanup or backup deletion was performed.
- This remains a development validation node; do not use it for real tenant data or sign-in sessions. A production Linux KVM node and stronger storage/Chrome isolation remain future work.
- No new `releases/<version>` directory or product release was created for this checkpoint.
