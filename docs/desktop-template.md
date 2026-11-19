# CubeSandbox 桌面模板

## 设计

桌面以 Coke Dots `4213e76` 的 XFCE、Xvfb、x11vnc、noVNC 和 websockify 组合为参考。它的 Node Agent runtime 与 Pod 启停逻辑不迁入；Agent Runtime 将在租户 microVM 内独立接入。桌面运行在租户 VM 内，端口经 CubeProxy 提供给 Coke API 代理，不直接把 VNC 端口公开。

CubeSandbox v0.8.0 的 SDK `/templates` 接受已有容器镜像，不能把 Dockerfile 直接传给模板 API。因此这一阶段先从已验证的 ARM64 `sandbox-code` 镜像派生一个模板，声明 envd 健康检查端口和 noVNC 端口。XFCE、Chrome、Node 与 Python 的桌面初始化会在后续 VM bootstrap 中完成；这避免在 Mac 上改 Docker，也不要求新增长期运行的注册表服务。模板构建配置参考 [CubeSandbox SDK](https://github.com/TencentCloud/CubeSandbox/tree/v0.8.0/sdk/node)；桌面启动组合参考 [Coke Dots 固定版本](https://github.com/cokepoppy/coke-dots/tree/4213e769e49da7a479ab2ad186584c77b721fa69/deploy/linux-desktop)。

模板只包含通用的 ARM64 `sandbox-code` 基础镜像。租户显式启动 microVM 后，API 使用 Cube SDK `commands.run` 在该 VM 内安装 XFCE/Xvfb/noVNC、Chromium、终端、Node.js 与 Python；完成标记保存在 MySQL，安装失败可重试，应用重启后会重试未完成的安装。`scripts/cube/bootstrap-linux-desktop.sh` 可重复执行。桌面服务在 UID 1000 用户下运行，允许该隔离 VM 用户无密码使用 sudo，以便直接安装 Linux 软件包。

浏览器中的 noVNC 静态资源和 WebSocket 都经现有 TypeScript API 转发到 CubeProxy 的 `6080-{sandboxId}.cube.app` 虚拟主机。API 先校验登录会话并从 MySQL 按租户解析 sandbox ID；浏览器不接触 Cube 管理凭据或其他租户的 VM 地址。VNC 只监听 guest loopback，应用端口不直接向公网开放。

模板采用 2000 millicores（2 vCPU）、2 GiB 内存和 8 GiB 可写层作为首轮轻量值，允许 VM 直接访问公网。Cube API 的 `cpu` 单位是 millicores；脚本按这个单位传 `cpuCount: 2000`。每个租户仍只创建一台自己的 VM。

## 创建本地模板

先准备 CubeAPI 回环隧道，并在仓库外的环境文件中设置：

```sh
CUBE_API_URL=http://127.0.0.1:13000
CUBE_DESKTOP_BASE_IMAGE=cube-sandbox-cn.tencentcloudcr.com/cube-sandbox/sandbox-code@sha256:e1cb43e12ba70b8453b45f0c063306faab8a6974aa3fd76982dc4d019d07c60d
```

然后运行：

```sh
DOTENV_CONFIG_PATH="$HOME/.local/share/csa-cube-node/coke-super-agent.env" npm run cube:desktop-template
```

脚本创建 `coke-super-agent-desktop-base-v2`，暴露 CubeProxy 使用的 `6080` 与 envd 的 `49983`，等待模板状态为 `READY` 后只打印模板 ID。模板镜像、microVM 与浏览器数据都留在外部实验卷；仓库只保存脚本。首次 Linux 桌面安装需要 guest apt 网络访问，预计占用每 VM 8 GiB 可写层中的一部分；安装与运行状态可从云电脑页面查看。
