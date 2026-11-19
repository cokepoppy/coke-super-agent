#!/usr/bin/env python3
"""Bounded host checks for CubeSandbox v0.8.0; does not install or boot it."""

import argparse
import fcntl
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys


KVM_GET_API_VERSION = 0xAE00
KVM_CREATE_VM = 0xAE01
KVM_API_VERSION = 12
DATA_PATH = "/data/cubelet"
# v0.8.0's installer calls this the 8 GB minimum and reads /proc/meminfo's kB.
MIN_MEM_KIB = 7_500_000
# The documentation specifies 50 GB; use decimal GB and f_bavail.
MIN_DATA_BYTES = 50_000_000_000
MAX_PROC_BYTES = 4 * 1024 * 1024


def check(name, status, detail):
    return {"name": name, "status": status, "detail": detail}


def read_proc(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        content = handle.read(MAX_PROC_BYTES + 1)
    if len(content) > MAX_PROC_BYTES:
        raise ValueError("proc file exceeds the 4 MiB read limit")
    return content


def memory_check():
    try:
        content = read_proc("/proc/meminfo")
        match = re.search(r"^MemTotal:\s+(\d+)\s+kB\s*$", content, re.MULTILINE)
        if not match:
            raise ValueError("MemTotal was not found in /proc/meminfo")
        kib = int(match.group(1))
    except (OSError, ValueError) as exc:
        return check("memory", "UNKNOWN", str(exc))
    return check(
        "memory", "PASS" if kib >= MIN_MEM_KIB else "FAIL",
        "MemTotal {:,} KiB ({:.2f} GiB); v0.8.0 installer minimum {:,} KiB (8 GB)".format(
            kib, kib / 1024 ** 2, MIN_MEM_KIB
        ),
    )


def kvm_checks():
    results = []
    try:
        kvm_fd = os.open("/dev/kvm", os.O_RDWR | getattr(os, "O_CLOEXEC", 0))
    except OSError as exc:
        return [
            check("kvm_open", "FAIL", "cannot open /dev/kvm read/write as this user: {}".format(exc)),
            check("kvm_api", "UNKNOWN", "device open failed"),
            check("kvm_create_vm", "UNKNOWN", "device open failed"),
        ]

    results.append(check("kvm_open", "PASS", "/dev/kvm opened read/write as this user"))
    try:
        try:
            api_version = fcntl.ioctl(kvm_fd, KVM_GET_API_VERSION, 0)
        except OSError as exc:
            results.append(check("kvm_api", "FAIL", "KVM_GET_API_VERSION: {}".format(exc)))
            results.append(check("kvm_create_vm", "UNKNOWN", "KVM API query failed"))
            return results
        if api_version != KVM_API_VERSION:
            results.append(check("kvm_api", "FAIL", "KVM API version {}; expected {}".format(api_version, KVM_API_VERSION)))
            results.append(check("kvm_create_vm", "UNKNOWN", "unexpected KVM API version"))
            return results
        results.append(check("kvm_api", "PASS", "KVM_GET_API_VERSION returned {}".format(api_version)))
        try:
            vm_fd = fcntl.ioctl(kvm_fd, KVM_CREATE_VM, 0)
        except OSError as exc:
            results.append(check("kvm_create_vm", "FAIL", "KVM_CREATE_VM: {}".format(exc)))
        else:
            os.close(vm_fd)
            results.append(check("kvm_create_vm", "PASS", "KVM_CREATE_VM returned a VM fd; closed immediately"))
        return results
    finally:
        os.close(kvm_fd)


def filesystem_check(path):
    tool = shutil.which("findmnt")
    if not tool:
        return check("data_filesystem", "UNKNOWN", "findmnt is unavailable"), None
    try:
        process = subprocess.run(
            [tool, "--json", "--target", path, "--output", "TARGET,FSTYPE,SOURCE", "--first-only"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace",
            timeout=10, env=dict(os.environ, LC_ALL="C"), check=False,
        )
    except subprocess.TimeoutExpired:
        return check("data_filesystem", "UNKNOWN", "findmnt timed out after 10 seconds"), None
    except OSError as exc:
        return check("data_filesystem", "UNKNOWN", "findmnt could not run: {}".format(exc)), None
    if process.returncode:
        detail = " ".join(process.stderr.split())[:300] or "no error text"
        return check("data_filesystem", "UNKNOWN", "findmnt exited {}: {}".format(process.returncode, detail)), None
    try:
        mounts = json.loads(process.stdout)["filesystems"]
        if len(mounts) != 1:
            raise ValueError("expected one filesystem")
        mount = mounts[0]
        filesystem, target, source = mount["fstype"], mount["target"], mount["source"]
        if not all(isinstance(value, str) and value for value in (filesystem, target, source)):
            raise ValueError("missing filesystem details")
    except (KeyError, TypeError, ValueError) as exc:
        return check("data_filesystem", "UNKNOWN", "cannot parse findmnt output: {}".format(exc)), None
    return check(
        "data_filesystem", "PASS" if filesystem == "xfs" else "FAIL",
        "filesystem={} mount={} source={}".format(filesystem, target, source),
    ), filesystem


def reflink_check(path):
    tool = shutil.which("xfs_info") or shutil.which("xfs_info", path="/usr/sbin:/sbin:/usr/bin:/bin")
    if not tool:
        return check("xfs_reflink", "UNKNOWN", "xfs_info is unavailable; install xfsprogs separately before checking")
    try:
        process = subprocess.run(
            [tool, path], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, errors="replace", timeout=10,
            env=dict(os.environ, LC_ALL="C"), check=False,
        )
    except subprocess.TimeoutExpired:
        return check("xfs_reflink", "UNKNOWN", "xfs_info timed out after 10 seconds")
    except OSError as exc:
        return check("xfs_reflink", "UNKNOWN", "xfs_info could not run: {}".format(exc))
    if process.returncode:
        detail = " ".join(process.stderr.split())[:300] or "no error text"
        return check("xfs_reflink", "UNKNOWN", "xfs_info exited {}: {}".format(process.returncode, detail))
    matches = re.findall(r"(?<![\w])reflink\s*=\s*([01])(?=\s|,|$)", process.stdout)
    if len(matches) != 1:
        return check("xfs_reflink", "UNKNOWN", "xfs_info did not report one unambiguous reflink value")
    return check("xfs_reflink", "PASS" if matches[0] == "1" else "FAIL", "xfs_info reports reflink={}".format(matches[0]))


def data_checks(path=DATA_PATH):
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return [
            check("data_path", "FAIL", "{} does not exist".format(path)),
            check("data_filesystem", "UNKNOWN", "data path is absent"),
            check("xfs_reflink", "UNKNOWN", "data path is absent"),
            check("data_available", "UNKNOWN", "data path is absent"),
        ]
    except OSError as exc:
        return [
            check("data_path", "UNKNOWN", "cannot inspect {}: {}".format(path, exc)),
            check("data_filesystem", "UNKNOWN", "data path could not be inspected"),
            check("xfs_reflink", "UNKNOWN", "data path could not be inspected"),
            check("data_available", "UNKNOWN", "data path could not be inspected"),
        ]
    if not stat.S_ISDIR(info.st_mode):
        return [
            check("data_path", "FAIL", "{} is not a directory".format(path)),
            check("data_filesystem", "UNKNOWN", "data path is not a directory"),
            check("xfs_reflink", "UNKNOWN", "data path is not a directory"),
            check("data_available", "UNKNOWN", "data path is not a directory"),
        ]

    results = [check("data_path", "PASS", "{} exists as a directory".format(path))]
    fs_result, filesystem = filesystem_check(path)
    results.append(fs_result)
    if filesystem == "xfs":
        results.append(reflink_check(path))
    else:
        results.append(check("xfs_reflink", "UNKNOWN", "the backing XFS filesystem was not established"))
    try:
        filesystem_stats = os.statvfs(path)
        available = filesystem_stats.f_bavail * filesystem_stats.f_frsize
        readonly = bool(filesystem_stats.f_flag & getattr(os, "ST_RDONLY", 1))
        detail = "{:,} bytes available to this user; minimum {:,} bytes (50 GB)".format(available, MIN_DATA_BYTES)
        if readonly:
            detail += "; filesystem is mounted read-only"
        results.append(check("data_available", "PASS" if available >= MIN_DATA_BYTES and not readonly else "FAIL", detail))
    except OSError as exc:
        results.append(check("data_available", "UNKNOWN", "statvfs failed: {}".format(exc)))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print structured JSON instead of text")
    parser.add_argument("--kvm-only", action="store_true", help="check only platform and KVM, omitting memory and storage")
    args = parser.parse_args()

    system, machine = platform.system(), platform.machine()
    checks = [check(
        "platform", "PASS" if system == "Linux" and machine in ("aarch64", "arm64") else "FAIL",
        "{} {} kernel {} (target: Linux aarch64)".format(system, machine, platform.release()),
    )]
    if system == "Linux":
        checks += kvm_checks() if machine in ("aarch64", "arm64") else [
            check("kvm_open", "UNKNOWN", "KVM probe is scoped to aarch64"),
            check("kvm_api", "UNKNOWN", "KVM probe is scoped to aarch64"),
            check("kvm_create_vm", "UNKNOWN", "KVM probe is scoped to aarch64"),
        ]
        if not args.kvm_only:
            checks.append(memory_check())
            checks += data_checks()
    else:
        names = ("kvm_open", "kvm_api", "kvm_create_vm")
        if not args.kvm_only:
            names += ("memory", "data_path", "data_filesystem", "xfs_reflink", "data_available")
        for name in names:
            checks.append(check(name, "UNKNOWN", "Linux guest required"))

    statuses = {item["status"] for item in checks}
    result = "FAIL" if "FAIL" in statuses else "UNKNOWN" if "UNKNOWN" in statuses else "PASS"
    scope = "CubeSandbox v0.8.0 {}".format("KVM-only probe" if args.kvm_only else "limited host preflight")
    not_tested = "CubeSandbox installation and actual microVM boot were not tested; KVM_CREATE_VM alone does not prove boot."
    if args.kvm_only:
        not_tested = "Host memory and storage were not checked. " + not_tested
    if args.json:
        print(json.dumps({"scope": scope, "result": result, "checks": checks, "not_tested": not_tested}, indent=2))
    else:
        print(scope)
        for item in checks:
            print("[{}] {}: {}".format(item["status"], item["name"], item["detail"]))
        print("[NOT TESTED] {}".format(not_tested))
        print("Result: {}".format(result))
    return {"PASS": 0, "FAIL": 1, "UNKNOWN": 2}[result]


if __name__ == "__main__":
    sys.exit(main())
