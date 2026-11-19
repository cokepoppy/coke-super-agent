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

## 单节点启动脚本

实测节点使用仓库内的 [Lima 配置](../infra/lima/cube-node.yaml) 和 `scripts/cube/` 下的脚本。先把一个专用、容量受限的卷挂载到 `CSA_CUBE_LAB_HOME`；仓库不保存 Lima 二进制、Cube 发布包、容器镜像或 VM 磁盘。实测使用 24 GiB sparsebundle，且没有启用静态加密。启动脚本要求该卷独立于 HOME 文件系统，并在启动前至少空余 12 GiB。

```sh
export CSA_CUBE_LAB_HOME="$HOME/.local/share/csa-cube-node"
export LIMA_HOME="$CSA_CUBE_LAB_HOME/lima"
export LIMACTL="$HOME/Library/Application Support/Coke Super Agent/lab/lima-2.3.0/bin/limactl"
bash scripts/cube/start-local-node.sh

# 只检查已准备好的数据盘，不写入磁盘。
"$LIMACTL" shell cube-node -- sudo -n bash -s < scripts/cube/prepare-cube-data-disk.sh

# 检查/补齐 Ubuntu 24.04 提供的 Compose v2 兼容命令。
"$LIMACTL" shell cube-node -- sudo -n bash -s < scripts/cube/ensure-compose-v2.sh
```

数据盘脚本默认只检查。只有确认目标是预期的全新空盘后，才给它传递显式 `--apply` 参数来格式化；不要对已有节点使用该参数。脚本启动前会验证 Lima 版本、独立卷与剩余空间；创建 `cube-xfs` 时只创建空白 raw 盘。CubeSandbox 安装器要求 XFS reflink 和至少 50 GB 数据空间。

## 主机要求

- 内存读取 `/proc/meminfo` 的 `MemTotal`，按 v0.8.0 安装器默认硬门槛 `7,500,000 KiB` 判断。 [CubeSandbox 安装器](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/deploy/one-click/install.sh)
- 用 `findmnt --target` 查询 `/data/cubelet` 所在文件系统，再用 `xfs_info` 确认 XFS `reflink=1`。两条命令分别设 10 秒超时。
- 用 `statvfs` 验证 `/data/cubelet` 所在文件系统可写，当前执行身份的可用空间达到 `50,000,000,000` 字节。部署时另查 macOS 物理盘空间，以便发现稀疏虚拟盘后端容量不足。 [v0.8.0 部署要求](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/bare-metal-deploy.md) · [数据盘要求](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/quickstart.md)

## KVM 探针单元测试

2026-11-19 的 12 项 Python 单元测试通过。运行方式：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/cube -p 'test_*.py'
```

## 2026-11-19 M5 本地单节点实测

- MacBook Air M5（Mac17,3）、macOS 26.5.1、16 GiB 内存；Lima 2.3.0 启动 Ubuntu 24.04 minimal ARM64，Linux 内核 6.8.0-147-generic。root 身份打开 /dev/kvm，KVM API 为 12，KVM_CREATE_VM 成功。
- 新建 64 GiB raw Lima 数据盘，在访客机检查其大小、分区、签名和挂载状态后才格式化。磁盘在客体显示为 /dev/vdb，XFS reflink=1，挂载在 /data/cubelet，可用空间约 63 GiB。
- TencentCloud CubeSandbox v0.8.0 ARM64 发布包 SHA-256：a7dcf6faa80416aab323050aac275e3385a3f49778a46256715608a26a4cb4f4。Cubelet、CubeMaster、CubeAPI、CubeShim 和 Cube runtime 均验证为 ARM64 ELF。官方安装器 quickcheck 的 Cubelet 网络运行时、Master、TemplateCenter、CubeAPI、CubeOps 检查全部通过。
- Ubuntu 24.04 上旧版 `docker-compose` 因系统不再提供 Python `distutils`，无法启动 Cube 安装包依赖的 MySQL/Redis 配套容器。安装系统自带的 `docker-compose-v2`，并把兼容命令指向该插件后，单节点安装通过 quickcheck。租户 microVM 的执行仍由 containerd Shim、CubeShim 和 KVM 负责。
- Lima 使用 192.168.5.0/24，和 CubeSandbox 默认 192.168.0.0/18 重叠。Cube 沙箱网段改成 10.240.0.0/18 后，未关闭上游冲突检查，安装顺利通过。
- 使用 ARM64 镜像摘要 cube-sandbox-cn.tencentcloudcr.com/cube-sandbox/sandbox-code@sha256:e1cb43e12ba70b8453b45f0c063306faab8a6974aa3fd76982dc4d019d07c60d 创建模板 tpl-f5da46972c5c4c34ace9b867，CubeMaster 状态为 READY。CubeAPI 创建了一台 1 vCPU、1 GiB、无 idle timeout 的真实 microVM；envd 版本 0.5.24 经 CubeProxy 的健康检查返回 HTTP 204。
- Mac 通过只绑定 127.0.0.1 的 SSH 转发，使用官方 @cubesandbox/sdk 0.8.0 连接 microVM，执行 uname 和 id，通过文件 API 写入并读取文件，然后暂停并自动恢复。恢复后的文件内容与暂停前一致，访客架构为 aarch64，命令退出码为 0。测试时 Cubelet 的 KVM worker 同时出现。
- Cube 单机参数关闭内置 MinIO、独立 Web UI、可观测性和 PVM，保留 CubeProxy 与 DNS；本机默认沙箱网段会与 Lima 网段重叠，因此使用 `10.240.0.0/18`。上游网络冲突检查保持开启。测试期间没有改动 Mac 上既有的 Docker、K3D 或业务 MySQL。
- CubeAPI 的本机健康端点返回 `status=ok`，CubeProxy 转发到运行中 microVM 的 `/health` 返回 HTTP 204。单机安装包和 SDK 客户端均放在仓库外的限容实验卷中。
- 结束时 Mac 内盘可用约 51 GiB，24 GiB 实验卷占用约 7.5 GiB、剩余约 16 GiB；宿主内存压力报告空闲比例 34%，swap 使用约 4.6 GiB。访客报告约 5.6 GiB 可用内存。启动完整桌面和浏览器前需重新检查宿主资源。

### 当前范围

这次实证只确认 M5 上的 ARM64 Lima 节点能够运行 CubeSandbox 和一台真实 microVM，并验证了 SDK 命令、文件及暂停恢复。XFCE、Chrome、DeepSeek Harness、两个租户、登录态持久化以及整台宿主机重启恢复仍待实现与验收。

本轮实验由 24 GiB sparsebundle 限容，测试期间 macOS FileVault 关闭，因此磁盘没有静态加密。里面只保存了合成测试数据、CubeSandbox 程序和随机生成的测试凭证，不用于保存真实浏览器登录态或个人桌面。产品租户数据接入前需改用加密存储；本轮目前不启用个人租户。
