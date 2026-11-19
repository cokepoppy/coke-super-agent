"""Contract tests for the host preflight without privileged host changes."""

import contextlib
import io
import json
import os
import stat
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

import preflight


class KvmChecksTest(unittest.TestCase):
    def test_real_ioctl_sequence_closes_both_descriptors(self):
        with mock.patch.object(preflight.os, "open", return_value=3), \
             mock.patch.object(preflight.fcntl, "ioctl", side_effect=[12, 42]) as ioctl, \
             mock.patch.object(preflight.os, "close") as close:
            result = preflight.kvm_checks()
        self.assertEqual([item["status"] for item in result], ["PASS", "PASS", "PASS"])
        self.assertEqual(ioctl.call_args_list, [
            mock.call(3, preflight.KVM_GET_API_VERSION, 0),
            mock.call(3, preflight.KVM_CREATE_VM, 0),
        ])
        self.assertEqual(close.call_args_list, [mock.call(42), mock.call(3)])

    def test_wrong_api_does_not_create_vm_and_closes_device(self):
        with mock.patch.object(preflight.os, "open", return_value=3), \
             mock.patch.object(preflight.fcntl, "ioctl", return_value=11) as ioctl, \
             mock.patch.object(preflight.os, "close") as close:
            result = preflight.kvm_checks()
        self.assertEqual([item["status"] for item in result], ["PASS", "FAIL", "UNKNOWN"])
        ioctl.assert_called_once_with(3, preflight.KVM_GET_API_VERSION, 0)
        close.assert_called_once_with(3)

    def test_unopenable_device_is_failure_not_success(self):
        with mock.patch.object(preflight.os, "open", side_effect=PermissionError("denied")), \
             mock.patch.object(preflight.fcntl, "ioctl") as ioctl:
            result = preflight.kvm_checks()
        self.assertEqual([item["status"] for item in result], ["FAIL", "UNKNOWN", "UNKNOWN"])
        ioctl.assert_not_called()

    def test_create_vm_denied_is_failure_and_device_is_closed(self):
        with mock.patch.object(preflight.os, "open", return_value=3), \
             mock.patch.object(preflight.fcntl, "ioctl", side_effect=[12, PermissionError("denied")]), \
             mock.patch.object(preflight.os, "close") as close:
            result = preflight.kvm_checks()
        self.assertEqual([item["status"] for item in result], ["PASS", "PASS", "FAIL"])
        close.assert_called_once_with(3)


class MemoryCheckTest(unittest.TestCase):
    def test_installer_threshold_is_inclusive(self):
        for kib, expected in [(7_499_999, "FAIL"), (7_500_000, "PASS")]:
            with self.subTest(kib=kib), mock.patch.object(preflight, "read_proc", return_value="MemTotal: {} kB\n".format(kib)):
                self.assertEqual(preflight.memory_check()["status"], expected)

    def test_missing_memtotal_is_unknown(self):
        with mock.patch.object(preflight, "read_proc", return_value="MemFree: 1 kB\n"):
            self.assertEqual(preflight.memory_check()["status"], "UNKNOWN")


class MountAndStorageChecksTest(unittest.TestCase):
    def test_findmnt_distinguishes_xfs_and_other_filesystems(self):
        for filesystem, expected in [("xfs", "PASS"), ("ext4", "FAIL")]:
            output = json.dumps({"filesystems": [{"target": "/data/cubelet", "fstype": filesystem, "source": "/dev/data"}]})
            process = SimpleNamespace(returncode=0, stdout=output, stderr="")
            with self.subTest(filesystem=filesystem), \
                 mock.patch.object(preflight.shutil, "which", return_value="/usr/bin/findmnt"), \
                 mock.patch.object(preflight.subprocess, "run", return_value=process) as run:
                result, actual_filesystem = preflight.filesystem_check("/data/cubelet")
            self.assertEqual(result["status"], expected)
            self.assertEqual(actual_filesystem, filesystem)
            self.assertIn("--target", run.call_args.args[0])

    def test_invalid_findmnt_output_is_unknown(self):
        process = SimpleNamespace(returncode=0, stdout="{}", stderr="")
        with mock.patch.object(preflight.shutil, "which", return_value="/usr/bin/findmnt"), \
             mock.patch.object(preflight.subprocess, "run", return_value=process):
            result, filesystem = preflight.filesystem_check("/data/cubelet")
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertIsNone(filesystem)

    def test_missing_data_directory_does_not_run_filesystem_tools(self):
        with mock.patch.object(preflight.os, "stat", side_effect=FileNotFoundError), \
             mock.patch.object(preflight, "reflink_check") as reflink:
            result = preflight.data_checks()
        self.assertEqual([item["status"] for item in result], ["FAIL", "UNKNOWN", "UNKNOWN", "UNKNOWN"])
        reflink.assert_not_called()

    def test_space_threshold_and_read_only_mount(self):
        info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755)
        for available, readonly, expected in [
            (preflight.MIN_DATA_BYTES - 1, False, "FAIL"),
            (preflight.MIN_DATA_BYTES, False, "PASS"),
            (preflight.MIN_DATA_BYTES, True, "FAIL"),
        ]:
            filesystem_stats = SimpleNamespace(f_bavail=available, f_frsize=1, f_flag=getattr(os, "ST_RDONLY", 1) if readonly else 0)
            with self.subTest(available=available, readonly=readonly), \
                 mock.patch.object(preflight.os, "stat", return_value=info), \
                 mock.patch.object(preflight, "filesystem_check", return_value=(preflight.check("data_filesystem", "PASS", "xfs"), "xfs")), \
                 mock.patch.object(preflight, "reflink_check", return_value=preflight.check("xfs_reflink", "PASS", "reflink=1")), \
                 mock.patch.object(preflight.os, "statvfs", return_value=filesystem_stats):
                result = preflight.data_checks()
            self.assertEqual([item["status"] for item in result], ["PASS", "PASS", "PASS", expected])

    def test_reflink_values_and_unavailable_tool(self):
        for value, expected in [(0, "FAIL"), (1, "PASS")]:
            process = SimpleNamespace(returncode=0, stdout="meta-data=... reflink={} bigtime=1\n".format(value), stderr="")
            with self.subTest(reflink=value), \
                 mock.patch.object(preflight.shutil, "which", return_value="/usr/sbin/xfs_info"), \
                 mock.patch.object(preflight.subprocess, "run", return_value=process):
                self.assertEqual(preflight.reflink_check("/data/cubelet")["status"], expected)
        with mock.patch.object(preflight.shutil, "which", return_value=None):
            self.assertEqual(preflight.reflink_check("/data/cubelet")["status"], "UNKNOWN")


class ScopeTest(unittest.TestCase):
    def test_kvm_only_pass_skips_capacity_and_marks_unchecked_scope(self):
        kvm = [preflight.check(name, "PASS", "verified") for name in ("kvm_open", "kvm_api", "kvm_create_vm")]
        output = io.StringIO()
        with mock.patch.object(sys, "argv", ["preflight.py", "--kvm-only", "--json"]), \
             mock.patch.object(preflight.platform, "system", return_value="Linux"), \
             mock.patch.object(preflight.platform, "machine", return_value="aarch64"), \
             mock.patch.object(preflight, "kvm_checks", return_value=kvm), \
             mock.patch.object(preflight, "memory_check") as memory, \
             mock.patch.object(preflight, "data_checks") as data, \
             contextlib.redirect_stdout(output):
            code = preflight.main()
        result = json.loads(output.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(result["result"], "PASS")
        self.assertIn("KVM-only", result["scope"])
        self.assertIn("memory and storage were not checked", result["not_tested"])
        self.assertIn("actual microVM boot were not tested", result["not_tested"])
        memory.assert_not_called()
        data.assert_not_called()


if __name__ == "__main__":
    unittest.main()
