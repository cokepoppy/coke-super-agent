# CubeSandbox 桌面模板

## 采用的方案

采用 CubeSandbox 官方 Ubuntu Desktop 示例的**构建时安装、运行时启动**方式：先准备 OCI 桌面镜像，再由 Cube 将镜像转换为可复用模板，最后每个租户启动一台独立 microVM。Docker 只负责构建 OCI 镜像；实际桌面、Chrome 和 Agent Runtime 都运行在 Cube microVM 内。不会额外创建 headless Browser Sandbox，noVNC 与 CDP 必须连接同一个 Chromium profile。

桌面启动脚本参考官方的 dummy Xorg、失败回退 Xvfb、D-Bus 和 `dbus-run-session` 结构；界面复用 Coke Dots 的 XFCE 方案。Chrome、Node.js、Python、桌面依赖、DSH 和 Pi 都在 OCI 镜像构建时预装。租户启动只启动服务并检查就绪，不下载或安装这套基础软件。用户仍可在终端用 `sudo apt` 安装自己需要的额外 Linux 包。是否直接采用 GNOME 官方镜像，需结合当前 Lima 节点容量实测：官方模板示例给出 4 vCPU、8 GiB 内存、16 GiB writable layer，而本项目首轮目标是轻量单租户桌面，不能未经测量照搬该规格。

官方参考：[Ubuntu Desktop Sandbox README](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/examples/ubuntu-desktop/README.md)、[Dockerfile](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/examples/ubuntu-desktop/Dockerfile)、[启动脚本](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/examples/ubuntu-desktop/start-desktop.sh)。Cube 模板不是 OCI 镜像本身：模板创建会启动 MicroVM，等待 HTTP probe 成功后再冻结文件系统和内存状态。这里桌面服务在租户 VM 创建后按需启动，所以模板 probe 检查保留的 `envd :49983/health`；控制面随后独立检查 XFCE、websockify 和 Chrome CDP。详见 [自定义镜像指南](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/tutorials/bring-your-own-image.md)。

## 当前实现状态

源码现在包含预装镜像的 Dockerfile 和 `npm run cube:desktop-image` 构建入口。构建器复用仓库外缓存的 Linux ARM64 DSH/Pi bundles，在 Mac 上构建镜像；Dockerfile 安装 XFCE、Google Chrome、Node.js/npm、Python 和桌面依赖，并把两个 Agent Runtime 解包到 `/opt/csa-agent-runtime`。bundle 和镜像构建日志写到 `~/.local/share/csa-cube-node/build-logs/`，临时 build context 在构建后删除，不放进 Git 或 releases。

镜像加入 `/etc/csa-super-agent/desktop-image.json` 标记。租户桌面 bootstrap 发现该标记后会验证软件和 runtime 文件，并跳过 apt。镜像缺少组件时会打印缺失路径。旧模板仍有兼容安装路径。切换到预装模板时，设置 `CUBE_TEMPLATE_ID` 并清空旧 `CSA_CUBE_DSH_TEMPLATE_SNAPSHOT_ID`。

控制面分别检查 VM、桌面和浏览器。任务执行和文件读取要求租户 VM 可连接。XFCE、X11、VNC 和 WebSocket 转发通过后，noVNC 可以连接。Chrome 控制接口的状态另记到访客机的 `/run/csa-desktop/browser.status` 和 `/tmp/csa-desktop-session.log`。浏览器失去响应时，桌面会话继续工作。前端的「重新连接」会重新检查桌面并连接同一台租户 VM。

2026-11-24 本机 ARM64 镜像已构建并推到 Mac 回环 Registry，大小 776,863,558 bytes，内容摘要为 `sha256:53d2c18f639182ee60487e0a7baa9ef8c4db253d6b11af8b72d37f311ae68179`。本机 Registry 使用不可变标签 `20261124-53d2c18f6391`，仅监听 `127.0.0.1:15001`，持久数据位于 `~/.local/share/csa-cube-node/registry-data`；Lima guest 通过 SSH 反向隧道从 `127.0.0.1:15002` 读取。Cube 模板 `tpl-827a52ee603c40f3992e40dd`（`coke-super-agent-desktop-local-60s-20261124`）已 READY。

2026-11-26 修正 Ubuntu ARM64 apt 镜像映射后，新的桥接版镜像摘要为 `sha256:5646bb9396d51ae3d5834734d6d89e783d99a49bbef5503c912878c7b2556082`，Cube 模板 `tpl-f8982970681d4131becaa111` 已 READY。该模板的 disposable clone 确认 Chrome、Node、桌面组件和 pipe bridge 都已预装，启动阶段 `apt_at_tenant_boot=disabled`。产品启动路径下 pipe HTTP bridge 的 `Browser.getVersion` 曾 330 秒超时；标准 `--remote-debugging-port` 对照也在 180 秒内没有可连接的 9222 端口。随后绕过产品启动和 bridge 的最小 GUI pipe 探针，在同一模板上于 211 秒取得 Chrome 版本、339 秒完成页面创建、附加与 evaluate，但 `Page.captureScreenshot` 在 360 秒上限内没有返回。完全相同的候选 OCI 镜像、2 CPU/2 GiB 限额与 GUI pipe 探针，在临时 Docker 容器中于 6.5 秒完成 Chrome 版本、页面脚本和 5,878-byte 截图。Cube 内 30 秒短样本显示 Chrome browser leader 持续处于 runnable（`R`），内存约 110–133 MiB、OOM/PSI 为 0、CPU throttling 很低，但没有及时答复 CDP。对比已把问题收窄到 Cube microVM guest 执行路径；尚未证实更具体的 KVM/虚拟 CPU原因。应用的 `CUBE_TEMPLATE_ID` 仍指向旧值，未切换到这个候选模板。

Pi runtime 已在同一个候选模板的 disposable microVM 内单独完成真实模型任务：Pi `0.73.1` 与 Browser/Computer 自定义工具导入 smoke 通过；`deepseek-flash` 文本请求在 47 秒内完成，run 状态为 `done`，返回预期结果且保留 20 条 trace。Pi 包和 Node `v24.22.3` 都已预装，任务无需 Chrome/noVNC；临时 microVM 已清理。这证明镜像内 Pi/模型调用路径工作，不代表 UI、桌面工具调用或接管已验收。日志：`~/.local/share/csa-cube-node/build-logs/pi-template-2026-11-26T03-54-14-264Z-e9556a55-1a84-4d1f-bd28-829b65c4ab9e.jsonl`。

Pi 与 DSH 的电脑操作规则现已一致：常规 Browser Use、Computer Use、终端和包安装不逐步申请批准；仅真实登录或验证码由用户接管。Pi 在提交任务时附带同一规则，工具层在接管标记产生后拒绝后续电脑操作。常规页面内容仍作为不可信输入处理。Pi 提示词改动已做语法检查，尚未随新 runtime key 在 microVM 中重新执行。

DSH `0.2.2-rc.2` 也已在该候选模板的 disposable microVM 完成真实 `deepseek-flash` 文本任务，176.6 秒后退出码为 0，state=`done`、trace 69 条，`agent-response.md` 中保存了预期结果。诊断脚本按产品控制面流程先注入共享 Computer 插件，再启动预装 Harness bundle；首个脚本版本漏掉这个注入步骤并在 DSH 运行前退出，已修正，不是产品模板故障。临时 VM 删除成功，两个原租户 VM 仍在原状态。该验收不调用桌面工具或 Chrome，因此 Browser/Computer、noVNC 和产品页面任务仍未通过。

镜像内 Chrome `158.0.8127.88`、Node `v24.22.3`、npm `11.19.1`、Python `3.10.12`、XFCE/noVNC 组件和 DSH/Pi runtime 都已预装。禁网 Docker 临时容器的完整 bootstrap 在 5 秒内通过；这只验证了 Docker 中的镜像运行。真实 Cube microVM 的桌面 bootstrap 能启动 Xvfb、VNC、websockify 和 XFCE，但 Chrome 没有对 CDP `9222` 返回响应。独立 headless 对照也观察到 Chrome 主进程持续高 CPU、CDP 端口不开放。该模板不能视为桌面验收通过，具体原因仍未确认。

noVNC 首帧、键鼠和终端可单独验收。Browser Use 的验收还要求在同一台 VM 中读到页面内容、执行实际操作并截图。构建期间还确认 Ubuntu ARM64 必须使用 `/ubuntu-ports` 软件源：腾讯 `/ubuntu` 路径对 `binary-arm64` 索引返回 404。无 apt guest 生命周期退出和 CubeShim 10 秒 agent-ready deadline 的证据见[模板构建事故记录](template-build-incident-2026-11-21.md)。

Cube 官方 Quick Start 标注 ARM64 部署需要 native KVM；当前 Mac 节点通过 Lima VZ 的 nested virtualization 暴露 `/dev/kvm`，节点 KVM-only 预检通过，但这并不等同于 bare-metal KVM。Cube 上游关于 nested PVM 下 VNC/图形 Chromium 延迟的 [issue #1505](https://github.com/TencentCloud/CubeSandbox/issues/1505) 与当前表现相符，但只构成参考线索；Cube 原生 Apple Virtualization 后端提案 [#975](https://github.com/TencentCloud/CubeSandbox/issues/975) 已关闭为 not planned，目前没有可直接使用的 Cube 原生 macOS backend。实验 Lima 节点已按批准扩容，两台已有租户 sandbox 保持不动。预装桌面镜像不会改变这些虚拟化限制，也不会替代对 guest 启动时间和 Chrome CDP 的验收。

noVNC 静态资源由 TypeScript 应用同源提供；noVNC WebSocket 经应用校验登录会话、从 MySQL 按租户解析 sandbox ID 后转发到 CubeProxy 的 `6080-{sandboxId}.cube.app`。浏览器不接触 Cube 管理凭据或其他租户的 VM 地址。每租户仍只有一台自己的 VM。
