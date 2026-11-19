# CubeSandbox KVM 与主机预检

这一步直接检查 Lima ARM64 Linux 客体的 KVM，以及 CubeSandbox **v0.8.0** 的主机内存与存储条件。实际启动验证使用配套 ARM64 发布包、CubeShim 和客体内核。

## 在 Mac 上运行

从仓库根目录运行。使用支持 VZ 嵌套虚拟化的 Apple Silicon/macOS、**Lima 2.3.0** 和独立的 `LIMA_HOME`。若已使用该目录，通过 `limactl list` 和 `_config/` 核对已有实例与模板覆盖配置。

```sh
export LIMA_HOME="$HOME/.local/share/coke-super-agent-lima"
limactl --version
limactl list
limactl start --name=cube-kvm --tty=false infra/lima/cube-kvm-probe.yaml
```

[模板](../infra/lima/cube-kvm-probe.yaml) 固定 Ubuntu 24.04 minimal ARM64 镜像版本 `20261105` 和 SHA-256，分配 2 vCPU、2 GiB 内存和 8 GiB 稀疏启动盘。启动前检查宿主可用空间，记实际占用时以 `du` 为准。

模板使用 plain 模式。主机目录、应用端口转发和客体容器运行时均关闭。`limactl shell` 用 Lima 独立的 SSH 密钥，优先尝试 vsock。如果客体的 SSH 服务尚未监听 vsock，Lima 可回退到宿主 `127.0.0.1` 的临时 SSH 端口。`hostLoopback: false` 关闭经 `host.lima.internal` 访问宿主回环服务的路径。宿主 LAN 地址的可达性由实际网络与服务绑定决定。 [Lima 2.3.0 配置](https://github.com/lima-vm/lima/blob/v2.3.0/templates/default.yaml) · [plain 模式](https://lima-vm.io/docs/config/plain/)

脚本经标准输入进入客体。

```sh
limactl shell cube-kvm -- sudo -n python3 - --kvm-only < scripts/cube/preflight.py
```

脚本以客体 root 打开 `/dev/kvm`，读取 KVM API 版本 12，执行 `KVM_CREATE_VM`，随后关闭两个临时 fd。`sudo -n` 使用 Lima 为这个实例设置的免密 sudo。探针身份的设备权限可能与运行 CubeShim 的身份不同。

去掉 `--kvm-only` 即可检查内存与存储。

```sh
limactl shell cube-kvm -- sudo -n python3 - < scripts/cube/preflight.py
```

两个命令均可追加 `--json`。退出码 `0` 表示所选检查通过，`1` 表示存在失败项，`2` 表示有未知项且其余项通过。2 GiB 探针客体的完整预检会报告内存和 `/data/cubelet` 两项不足。验证结束后执行 `limactl stop cube-kvm`。

## 主机要求

- 内存读取 `/proc/meminfo` 的 `MemTotal`，按 v0.8.0 安装器默认硬门槛 `7,500,000 KiB` 判断。 [CubeSandbox 安装器](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/deploy/one-click/install.sh)
- 用 `findmnt --target` 查询 `/data/cubelet` 所在文件系统，再用 `xfs_info` 确认 XFS `reflink=1`。两条命令分别设 10 秒超时。
- 用 `statvfs` 验证 `/data/cubelet` 所在文件系统可写，当前执行身份的可用空间达到 `50,000,000,000` 字节。部署时另查 macOS 物理盘空间，以便发现稀疏虚拟盘后端容量不足。 [v0.8.0 部署要求](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/bare-metal-deploy.md) · [数据盘要求](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/quickstart.md)

## 实测记录

2026-11-19 在 MacBook Air M5 上，用 Lima 2.3.0 启动 `6.8.0-147-generic` ARM64 Linux。客体 root 的 KVM API 为 12，`KVM_CREATE_VM` 成功。下一步由 CubeShim 启动实际沙箱，在客体内运行命令验证。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/cube -p 'test_*.py'
```
