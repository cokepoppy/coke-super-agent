# Tenant microVM to host escape validation

## Goal

Determine whether arbitrary shell commands running in one tenant's Cube microVM can access or modify the Cube node host (the Lima Linux VM) or the outer macOS host. Record concrete evidence and limitations; do not assume a microVM is impossible to escape.

## Current architecture to verify before testing

- DSH, XFCE, Chrome, noVNC, and Browser/Computer tools run in one per-tenant Docker container. DSH's local Bash, PowerShell, filesystem, and working-directory tools are disabled. DSH is expected to reach Bash only through the application's tenant-bound `computer_terminal` bridge.
- The bridge executes commands through the matching tenant's Cube microVM PTY. That guest is the intended arbitrary-code boundary. A Cube guest escape could first expose the Lima Linux node; Lima is itself a VM on macOS, so that is a separate outer boundary.
- Verify the live placement, image/template, Cube node, tenant sandbox ID, mounts, devices, and container security settings before interpreting any probe.

## Safe test sequence

1. Read-only baseline: capture guest kernel/architecture, identity, namespaces, mounts, cgroups, devices, capabilities, process 1, network routes, and available Unix sockets. Do not dump environment variables, credentials, full process command lines, or file contents outside a dedicated canary.
2. Check for direct host exposure: inspect known bind-mount locations and Docker/container runtime sockets; test only path metadata and socket presence. Probe `/proc`, `/sys`, device nodes, and namespace boundaries without writing to them.
3. Use a disposable, non-secret host canary in a temporary directory to test whether the guest can read or alter a known host-only file. If used, restore the exact original content and remove only that canary after both sides are checked.
4. Inspect the tenant DSH container configuration separately: user IDs, capabilities, security options, mounts, devices, and Docker socket presence. Confirm DSH's local shell and host-file tools are unavailable, while the authorized bridge targets only that tenant's Cube sandbox.
5. If a probe unexpectedly crosses a boundary, stop further commands, preserve logs, record the exact path and effect, and contain only the disposable canary. Do not attempt persistence, credential theft, destructive writes, or scanning unrelated hosts.

## Pass criteria and limits

- No host filesystem bind mount or host runtime socket is visible from the guest; the host-only canary cannot be read or changed; and container inspection shows DSH has no host mounts or Docker socket.
- Record any reachable host service separately rather than treating network reachability as a filesystem escape.
- A pass means these tested routes were blocked on the recorded configuration. It does not prove resistance to every kernel or hypervisor vulnerability. Any exploit-based test must be tied to the exact Cube/host versions, performed against a disposable snapshot, and independently reviewed for safety.

## Status

- Requested by the user on 2026-11-28 as a separate security goal.
- First non-destructive pass completed on 2026-11-28 against local Alpha tenant `9581d312-52bc-4821-bfb9-8019b78f4b79`, Cube sandbox `74ef6039d5554c15afdb2555b055e5d3`. Preflight confirmed it was running and had zero queued/working tasks.
- The Lima node is Ubuntu 24.04.5 ARM64 (`6.8.0-151-generic`), reports `/dev/kvm`, and its checked-in config uses VZ nested virtualization with `mounts: []`, `portForwards: []`, and `hostLoopback: false`. The Cube install record says PVM is disabled and a Cubelet KVM worker appeared during a real microVM launch. The current guest's `systemd-detect-virt` probe returned `unknown`, so the precise VMM used for this specific sandbox was not independently identified by that probe.
- A random, non-secret canary was created in Lima `/tmp` with mode `0666`. The tenant guest could not see or read it, no write was attempted, and host verification confirmed it was unchanged before the exact file was removed. The guest had no `/Users`, `/host`, `/mnt/host`, or `/home/lima` paths, no Docker/containerd sockets, no `virtiofs`/`9p`/host-fuse mounts, and no `/dev/kvm`. `/dev/mem` existed as a guest device, but a one-byte read failed with `OSError`.
- The guest command ran as UID/GID 0 with all reported capability bits effective/bounded, `NoNewPrivs=0`, and `Seccomp=0`; `/dev/fuse` was readable/writable. This is root inside the guest and means the Cube microVM/VMM boundary is doing the isolation work. It is not evidence of host root access.
- Twenty-four TCP connect-only probes to 12 known service ports on the Lima node (`192.168.5.15`) and its gateway (`192.168.5.2`) all failed to connect. This confirms those tested routes were filtered at that time; it is not a port scan of other hosts.
- The live Alpha Docker desktop container is not privileged, has no added capabilities, uses `no-new-privileges`, has bridge networking, and has only two named-volume mounts (`/workspace` and `/var/lib/csa-agent-runtime`); no bind mount or Docker socket was present. Source disables DSH's local Bash/PowerShell/filesystem/working-directory tools and registers `computer_terminal` for the tenant Cube guest.
- Diagnostic log: `~/.local/share/csa-cube-node/build-logs/microvm-host-isolation-2026-11-28T09-01-17-417Z-3fe792b3-9275-4914-89e2-23ca974650c8.jsonl`. The earlier preflight log is `~/.local/share/csa-cube-node/build-logs/microvm-host-isolation-2026-11-28T08-59-31-441Z-0aa4774f-c8fc-488b-bd86-ea1b1ebfacb7.jsonl`.
- Result: no host escape was observed through the tested file, socket, device, or network paths. This does not prove resistance to unknown CubeShim, VMM, KVM, or guest-kernel vulnerabilities. No kernel/hypervisor exploit was run; that would need a disposable Cube node/snapshot and a separately planned impact boundary. A further check should identify the exact runtime VMM for the live sandbox and check the errno behind the `/dev/mem` read failure.
