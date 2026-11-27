# DSH 和云桌面用 Docker，租户命令在 Cube microVM 执行

2026-11-27 · Coke Super Agent 架构调研

## 建议

**建议先采用每租户一个 Docker 容器加一台 Cube microVM。** 容器里放 DSH、XFCE、可见 Chrome、noVNC、Browser/Computer Worker；Cube VM 负责 Bash、任务代码、Python、Node、apt 和持久工作区。TypeScript 应用统一管理任务、租户鉴权、Docker 容器和 Cube 生命周期。Docker 容器及两个命名卷按租户创建，不使用 K3D、不另设共享 DSH Runner，也不另开常驻 Bash HTTP 服务。

DSH 的默认本地 Bash、PowerShell、文件和工作目录工具关闭，模型需要执行命令时通过 `computer_terminal` 调用应用桥，再由 Cube SDK 在该租户 VM 执行。Container 内 DSH 用 UID 1001 和私有 0700 状态目录，桌面用 UID 1000；移除桌面免密 sudo、设置 `no-new-privileges`，不挂载宿主目录或 Docker Socket。这样保留单容器的简单拓扑，同时降低桌面终端直接读 DSH 状态的风险。桌面容器仍要按可能执行租户网页代码来隔离；UID 分离和 Docker 本身都不等于绝对安全，尤其当前 Chrome 使用 `--no-sandbox` 以兼容 Docker 默认 seccomp。

将 DSH 与桌面拆成两个容器能增加凭据和浏览器的隔离，但也需要更多服务、内部鉴权和重启协调。首版先保持每租户一个 Docker 容器，只有出现明确的安全或资源需求再拆分。

这个选择有本机对照。11 月 25 日，在同一台 Lima 节点用相同 ARM64 镜像、Chrome 158、2 vCPU 和 2 GiB 内存测试离线页面，Docker 约 1 秒输出预期 HTML，Cube guest 在 35 秒截止时仍无 HTML。11 月 27 日构建的 `.8` 镜像已通过真实 DSH Browser/Computer Use 与远端 Cube Bash 任务；页面内按钮被点击后，DOM 状态变成 `CLICKED_OK`。这验证了分层设计的关键数据路径，但尚未通过产品网页里的人工 noVNC 点击、应用重启恢复或公网页面验收。 [同机对照及原始日志索引](template-build-incident-2026-11-21.md#2026-11-25-same-lima-docker-control-and-profile-scoped-chrome-process-sample) · [公网任务检查点](checkpoints/checkpoint-2026-11-27.1.md)

## DeepSeek 有没有原生远程 Bash

有。当前项目固定 DSH `0.2.2-rc.2`，对应官方源码 `ddac967`。需分别看**供工具使用的执行接口**、**远程后端**和**本项目的默认 profile**。 [当前锁定版本](../scripts/cube/dsh-runtime/package.json) · [上游能力接口](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/docs/capability-seams.md)

| 接法 | 已核实的行为 | 本项目取舍 |
| --- | --- | --- |
| SSH 后端 | 上游有 `ssh`、`subprocess-ssh`、`fs-ssh` 和 `sandbox-ssh`。命令、文件和沙箱策略可落到同一个远程 SSH 环境，后端使用已认证的 SSH 连接及其远端 helper。 | 有现成且受控的租户 SSH 环境时可以用。当前 Cube 已提供 envd，首版走 SDK 可以省去为每台 VM 建 SSH 服务、配发密钥和做连接维护。 |
| 自定义 `ctx.shell` 执行器 | 普通单次 `tool-bash` 依赖 `ctx.shell`。可实现自己的执行器接远端，保留原来的工具名和结果交互。需实现请求解析、输出、取消、作业等执行器语义。`ctx.sandbox` 的包装接口属于另一层，单换它不会把本地进程传送到远端。 | 等默认 Bash 工具或长期作业兼容成为需求后再评估。当前 `sdk-minimal` 的持久 Bash 走 `terminal-bash`、`ctx.terminals` 和本地子进程，单换 `ctx.shell` 覆盖不到这条路径。 |
| 自定义 DSH 工具加 Cube SDK | Cordis 插件可以通过 `ctx.tools.register()` 注册工具，TypeScript SDK 可用 `patches` 在启动时载入可信配置。工具回调只提交结构化请求和接收结果。 | **首选。** 关闭本地 Bash 和其他本地工具，注册 `computer_terminal`。现有应用调用 `sandbox.commands.run()`，保持 Cube 凭据和租户选择由应用持有。 |
| 旧 E2B 后端 | DSH 上游曾有 E2B 远程执行包，提交 `c49db8b` 已将其移除。项目固定的 rc.2 源码不包含该后端。 | Cube 提供 E2B 兼容 API，当前版本仍需接一层。无需回退 DSH，使用项目已依赖的 `@cubesandbox/sdk@0.8.0`。 |

[SSH 远程执行包](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/ssh/README.md) · [Shell 执行接口](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/shell/shell/README.md) · [工具注册手册](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/docs/cookbook/adding-a-tool.md) · [SDK 配置类型](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/sdk/client/src/types.ts#L25-L48) · [E2B 后端移除记录](https://github.com/deepseek-ai/deepseek-harness/commit/c49db8bc8c2924e115308692d34af7539288e7bb)

### 如何让 DSH 只做大脑

`sdk-minimal` 自带 `bash`、`read_image` 和 `working_directory`。在固定版本的 Cordis 配置里，本地 Bash 的工具行 ID 是 **`persistent-bash`**，包名才是 `dsh-tool-bash-persistent`。首版应明确禁用 `persistent-bash`、`terminal-bash`、`tool-fs` 和 `tool-working-directory` 等模型可触达的本地路径，关闭 PowerShell 对应项，保持 SDK 服务、模型、会话存储和可信图片附件组件。通过实际启动后的工具清单验证生效，不能只检查 YAML 拼写。换装更完整的 profile 时仍要检查 hooks、插件安装、可执行 MCP、代码执行和子 Agent 等入口。 [固定版本 profile](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/bundle/sdk-minimal/cordis.patch.yml) · [官方工具注册与限制](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/core/tools/README.md#restrict-tools-per-agent)

DSH 只加载镜像内由项目维护的插件和配置。模型看到的是约定的远程工具。返回的文件、网页和终端内容进入模型时仍是任务数据，不能改变工具、目标或权限。插件配置和授权信号来自服务端。SDK 仍会启动可信的 DSH 进程并读写自己的会话，所以安全目标是**模型没有容器本地执行入口**，无需依赖容器镜像里恰好缺少 `/bin/bash`。`danger-full-access` 是执行权限模式，关闭本地工具要靠实际插件配置和运行验证。 [现有 runtime 启动路径](../scripts/cube/dsh-runtime/run-task.mjs) · [上游执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/docs/tool-execution-pipeline.md)

## 最小部署

```mermaid
flowchart LR
    U[用户浏览器] --> V[VPS Nginx 与反向隧道] --> A[Mac 上的 TypeScript 应用]
    A --> DB[(MySQL)]
    subgraph DockerSide["Mac 上的 Docker Engine"]
        D["每租户一个容器 · DSH UID 1001"]
        W["同容器桌面 · XFCE / Chrome / noVNC / Worker · UID 1000"]
        D --- W
        D --> P[(租户 DSH 状态卷)]
        W --> Q[(租户桌面与工作区卷)]
    end
    A <-->|任务 / 事件 / noVNC 代理| D
    D --> L[DeepSeek 模型 API]
    subgraph CubeNode["Lima 上的 CubeSandbox"]
        C["控制面 · CubeAPI / CubeMaster"] --> N["节点 · Cubelet / CubeShim / VMM"]
        N -->|启动与恢复| E["每租户 microVM · envd / Bash / Python / Node / apt"]
        X[CubeProxy] --> E
        E --> F[(租户工作区)]
    end
    A -->|VM 生命周期| C
    A <-->|SDK 终端与文件| X
```

- **Mac 应用和公网入口。** VPS Nginx 经现有反向隧道转发到同一个产品入口。Mac 上的 TypeScript 应用查 MySQL 得到任务归属，再按租户路由至其 Docker 容器和 Cube VM。Docker 桌面端口只绑定 Mac 回环地址，页面的 HTTP/WebSocket 请求由经鉴权的 `desktopTarget()` 转发。VPS 继续只做 Nginx 转发和 SSH 反向隧道。 [桌面代理](../src/server/desktop-proxy.ts) · [租户 VM 对接](../src/server/computer.ts)
- **Docker 中的租户 DSH 与桌面。** 应用按租户 ID 确定性创建一个 Docker 容器和两个命名卷。构建时预装 DSH、XFCE、Chrome、noVNC 和 Worker。DSH UID 1001 的状态卷与桌面 UID 1000 的工作区/Chrome profile 分开；容器不挂宿主路径或 Docker Socket。模型凭据只注入 DSH 进程，Cube 管理凭据不进入容器。本地 shell/文件工具不注册给模型，`computer_terminal` 只能由应用桥接至 Cube。Browser Use 控制同一容器内可见的 Chrome，Computer Use 操作同一 X11 显示，用户通过 noVNC 看见并接管。每租户单容器网络和端口只对本机应用可见。 [DSH 启动代码](../scripts/cube/dsh-runtime/run-task.mjs) · [Docker Engine 安全边界](https://docs.docker.com/engine/security/)
- **Cube 控制面和租户 VM。** 应用通过 CubeAPI 请求创建、暂停或恢复，CubeMaster 调度，Lima 节点的 Cubelet、CubeShim 和 VMM 管理 VM。实际终端与文件请求由应用经 SDK、CubeProxy 到对应 VM 的 envd。VM 模板预装 Bash、Python、Node 和 apt，持久化该租户的 `/workspace`。第一个 PoC 可以复用受控测试 VM 的 envd，只启动执行所需组件，省去一次桌面模板构建。这个设计沿用 Cube 现有接口，无需单独的 Bash HTTP 服务或 SSH 端口。 [Cube 架构](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/architecture/overview.md) · [SDK 命令](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/sdk/node/src/commands.ts) · [工作区初始化](../src/server/tenant-workspace.ts)

### 远程工具如何运行

1. **调度。** 现有实现会先启动租户 VM，再经 guest PTY 启动 DSH。迁移后，应用把登录租户、`threadId`、`runId` 绑定到任务，直接派发给 Docker Runner，再按工具调用查找目标。模型只提供命令、页面动作或任务文件引用，服务端决定目标和执行账号。纯终端任务只探测 envd，纯浏览器任务只探测桌面和浏览器。桌面就绪应验证可见的 X11、noVNC 和实际 CDP 请求，启动标记只作诊断线索。 [现有任务入口](../src/server/agent-runtime.ts#L171-L189) · [guest PTY 启动](../src/server/agent-runtime.ts#L317-L339)
2. **终端。** `computer_terminal` 经应用调用 `sandbox.commands.run(command, { user, cwd, timeoutMs, envs })`，记录 guest 的 stdout、stderr 和退出码。SDK 默认使用 root，日常命令显式使用模板中的普通任务账号，工作目录从 `/workspace/tasks/<threadId>` 开始。一次调用一个新 shell，后续命令可读回工作区的文件。产品里的交互式「终端」用应用鉴权的 Cube PTY 连接到同一 VM，`cd`、长进程及交互输入可在该 PTY 中继续。工具设定时限和有界输出，断线先核对执行状态再决定是否重试，避免重复执行已经产生副作用的命令。 [SDK 命令](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/sdk/node/src/commands.ts) · [SDK 交互终端](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/sdk/node/README.md#pty-interactive-terminal)
3. **浏览器和桌面。** 保留 `computer_browser`、`computer_desktop` 的工具契约。DSH 插件将动作交给应用，租户桌面的 Worker 访问本容器内的 CDP、截图和 X11。现有插件直接连接 `127.0.0.1:9222` 和本地显示，必须把工具注册与这些操作拆开。每个桌面同一时刻只有一个输入方。常规操作按任务直接执行，遇到真实登录或验证码，用户在原页面接管同一桌面。接管期间 Worker 暂停 Agent 的输入、读取页面和截图，归还后重新检查当前标签页再继续。 [现有电脑插件](../scripts/cube/dsh-runtime/computer-plugin.mjs) · [Grok Bot 接管与动作分发](https://github.com/cokepoppy/coke-grok-bot/blob/35a134370e95667b1afc78509bf2ff582716bff7/deploy/desktop/dsh-computer-plugin.mjs#L125-L158)
4. **调试。** 从页面发起、DSH 启动、首个模型事件到工具调用和回写，共用 `runId`、`toolCallId`。终端事件附 VM ID、generation、envd 耗时和退出码。桌面事件附桌面实例、CDP 或 X11 动作、耗时和结果。文件传递记录方向、大小和校验结果。前端调试模式突出第一个失败阶段和错误，区分「Chrome 渲染超时」「桌面未就绪」「Cube 命令失败」和「模型响应超时」。接管输入、会话 cookie、模型与 Cube 密钥都不记入日志。

### 两个文件系统如何协作

任务文件以 VM 中的 `/workspace/tasks/<threadId>` 为准。产品页面可继续使用现有的鉴权产物接口预览、下载 VM 中的 HTML。用户打开俄罗斯方块预览时，网页直接读取任务产物，这一步无需启动租户的云桌面。桌面 Chrome 的登录态保存在自己的卷，重启 Runner 或暂停 VM 均无需复制 profile。 [现有产物路由](../src/server/http.ts#L301-L370) · [产物路径校验](../src/server/artifacts.ts)

只有需要**用租户的 Chrome 打开或上传某个任务文件**时，应用才按租户和任务把选中的文件复制到该桌面的临时目录。反向操作同理，浏览器下载完成后，Worker 把选中的下载经应用导入同一任务的 VM 工作区。双向传递是新增能力。应用使用服务端生成的文件标识，校验归属、大小、普通文件类型及路径边界，拒绝越界或符号链接替换。传完校验内容再提交，重试按同一传输 ID 去重，临时副本按配额清理。Runner 和桌面均不挂载 VM 的整个工作区，VM 也不挂载浏览器卷。

## 安全评估

| 用户关心的问题 | 结论与边界 |
| --- | --- |
| DSH 的命令可以到哪里 | 支持的任意 Bash、Python、Node 与构建操作都由应用路由到租户 VM，Cube 暂不可用时返回工具错误。Runner 只运行可信的 DSH 与插件进程。验证时既要检查实际工具清单，也要确认命令运行的 UID、工作目录和写入的文件来自目标 guest。 |
| VM 与宿主、浏览器之间是什么边界 | VM 有独立 Linux 内核，工作区是节点上该租户的可写挂载。隔离还依赖 VMM、挂载、网络及凭据配置。Chrome profile 是独立的 Docker 卷，guest 命令无法经本机文件路径读取它。Cube 管理面、envd、CDP、VNC 与 Worker 都保持私有，产品入口代理只向已鉴权的所属租户提供桌面。 |
| 桌面键鼠能否变成本地执行 | 完整 XFCE 交互可能启动桌面容器内的程序。只关闭 DSH 的 Bash 工具无法覆盖这条路径。把桌面作为可被租户控制的环境，使用非 root 桌面账号、Chrome 自身沙箱、独立卷与网络，隔开模型密钥、管理端口、宿主目录和 Docker Socket。产品终端连接 Cube PTY，桌面会话中移除本地终端和命令启动入口。保留完整键鼠时，仍应按桌面容器内可能发生代码执行来设计，并实测它访问不到 Runner、宿主和其他租户。 |
| 如何保留 apt 和无打扰操作 | Bash、浏览和键鼠按当前任务执行，只有网站登录或验证码交回给用户。常用运行环境在镜像构建时预装。需要额外系统包时，在该租户 VM 内用 guest 管理权限运行 apt，软件包安装脚本也拥有该 VM 的管理权限。桌面容器使用预装镜像，模型凭据仅在 Runner 中。 |

旧桌面镜像给桌面账号配置了 `NOPASSWD:ALL`，旧启动脚本默认传 `--no-sandbox`。移植可复用软件安装层，Docker 桌面的启动方式需单独验证非 root 和 Chrome 沙箱有效。两个 Docker 桌面和 guest 都需要正常网页出站，验证时还要分别检查宿主服务、管理网和其他租户端点的可达性。Cube 的 `allowPublicTraffic: false` 约束 guest 入站，Docker 的网络和公网代理另行验证。 [Docker Engine 安全](https://docs.docker.com/engine/security/) · [Cube 网络策略](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/network-policy.md) · [旧镜像用户设置](../images/coke-super-agent-desktop/Dockerfile#L75-L87) · [旧 Chrome 启动参数](../scripts/cube/csa-desktop-session.sh#L730-L755)

## Coke Grok Bot 能复用什么

已检查本机 Grok Bot 提交 `35a134370e95667b1afc78509bf2ff582716bff7`。`splitDesktopResources()` 确实生成独立的 `desktop` 与 `agent` Deployment 和 Service，以及各自的 NetworkPolicy。DSH 插件通过内部 HTTPS Bridge 调用 Browser、Computer 工具，并检查运行授权和用户是否接管。已有 Cordis patch 禁用多类默认工具，也有持久截图、字段规约和日志脱敏可复用。 [拆分部署](https://github.com/cokepoppy/coke-grok-bot/blob/35a134370e95667b1afc78509bf2ff582716bff7/src/server/desktop-resources.ts#L80-L110) · [电脑桥接](https://github.com/cokepoppy/coke-grok-bot/blob/35a134370e95667b1afc78509bf2ff582716bff7/deploy/desktop/dsh-computer-plugin.mjs#L125-L158) · [DSH patch](https://github.com/cokepoppy/coke-grok-bot/blob/35a134370e95667b1afc78509bf2ff582716bff7/deploy/desktop/cloud-kernel-adapter.mjs#L997-L1009)

Grok Bot 的 `computer_terminal` 调用 `runTaskTerminal()`，后者在 Agent 进程所在环境直接 spawn Bash，并使用 Agent 与 Desktop 共享的 PVC。可以复用工具契约、输出限制、接管检查和故障分类。Coke Super Agent 的实际 Bash 改由应用调用 Cube，同样的插件名不能代替执行位置的验证。Grok Bot 的 patch ID 也需要按本项目的 DSH 版本重新核对。DeepSeek 的 Super Agent 原型适合参考 Router 和 Worker 职责划分，它的 Worker 仍以部署者的 OS 用户执行命令。 [Grok Bot 终端工具](https://github.com/cokepoppy/coke-grok-bot/blob/35a134370e95667b1afc78509bf2ff582716bff7/deploy/desktop/dsh-computer-plugin.mjs#L87-L103) · [本地 Bash 实现](https://github.com/cokepoppy/coke-grok-bot/blob/35a134370e95667b1afc78509bf2ff582716bff7/deploy/desktop/computer-tools.mjs#L39-L71) · [DeepSeek 原型执行设计](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)

## PoC 与通过标准

| 阶段 | 验收时要取得的证据 |
| --- | --- |
| 1. 先验证 Docker 桌面 | 在目标 Mac Docker 环境启动一个预装桌面，打开本地测试页。记录 X11、noVNC、CDP 首次成功及可见页面呈现的耗时。由公网产品页看到同一 Chrome，Browser Use 点击改变页面状态，Computer Use 确认可见变化，用户接管并归还后 Agent 读到原标签的状态。此项可在 Cube guest 的图形组件全部停用时独立通过。 |
| 2. 验证 DSH 调用 Cube Bash | 让 Docker 中的真实 DSH 通过 `computer_terminal` 在 VM 写入唯一标记，另一次调用读回，核对 UID、目录、输出和退出码。核对启动后的工具清单，确认本地 Bash 无法调用。桌面停用时同一终端任务仍能成功，Cube 不可用时应返回明确的 Cube 工具错误。记录首个模型事件与 envd 往返耗时。 |
| 3. 打通文件与整条任务 | Alice 从公网网页发起新任务，生成单文件 HTML 俄罗斯方块。以任务实际 `done`、从 VM 预览成功，以及点击移动、旋转、硬降、暂停、重开产生可见变化为通过条件。另让桌面 Chrome 通过文件传递打开这份 HTML，验证一次向测试页面上传和一次将浏览器下载导入 VM，核对两端的文件校验值及任务归属。 |
| 4. 两个租户与重启 | Alice 和 Bob 各用自己的 VM、桌面和 Chrome profile。用合成标记验证无法跨租户访问终端、产物、下载、桌面 HTTP/WebSocket、登录态或管理服务。分别重启 Runner、桌面容器、VM 和应用，验证 Chrome 配置、VM 文件、任务和会话按各自的持久化位置恢复。用同一任务的前端时间线核对失败阶段以及未重复执行的副作用，记录 Mac 内存和磁盘余量。 |

PoC 先用新任务、空的桌面测试卷和仅含合成数据的 guest 工作区。旧版将桌面 home 放在 `/workspace/.desktop-home`，直接沿用原工作区会让 guest 命令仍可能读到旧登录态。迁移已有数据时，保留原卷作回退，给新执行环境只导入所需任务文件。旧 Chrome profile 用同版本副本在租户桌面验证，旧 DSH JSONL、附件及目录映射在 Runner 验证。桌面镜像放本地 registry，两个租户复用镜像层，分别计量卷、容器可写层和日志占用。 [旧工作区与 home 配置](../src/server/agent-runtime.ts#L326-L339)

本文从 `checkpoint-2026-11-27.1`（`077e4a1`）出发。当前代码落实每租户一个 Docker DSH/桌面容器、两个命名卷和一台 Cube microVM。Agent Bash 由应用通过带短期 HMAC 令牌的桥接工具调用 Cube SDK。模型凭据与桌面账号通过不同 UID 和目录权限隔开；这减少服务数量，但 Docker 容器内仍有共享内核，Chrome 关闭内部 sandbox 也是已知隔离弱点。若之后安全评估要求浏览器和模型运行环境有容器级边界，再拆成两个容器。

## 实施进度（2026-11-27）

当前功能分支加入 `CSA_DSH_PLACEMENT=docker`：每租户一个 Docker 桌面/DSH 容器、两个命名卷；app 内 HMAC bridge 将 `computer_terminal` 绑定到同租户、同一运行中的 Cube microVM。DSH 工具注册禁用本地 Bash、PowerShell、文件系统和工作目录工具；Docker DSH 状态、launch intent、session JSONL 与 stdout tail 用于故障诊断及避免重复执行。`.4` 通过了 Chrome/CDP、noVNC WebSocket、DSH import smoke、Cube Bash 写读和跨 VM 工作区检查；`.5` 又通过真实 Browser Use 导航、语义标题结果和受控 `h1` fixture。

`.8` 已成功启动 Beta 容器，桌面、Chrome `158.0.8127.88` CDP 和 noVNC WebSocket readiness 均通过。真实 DSH run `e77837a8-01f0-4a5c-8a5d-ffa2009690ae` 用 `computer_terminal` 在 Cube microVM 写入并由 DSH 后续调用读回唯一标记，随后从 Cube Files API 按准确路径独立读回并清理；Browser Use 检查本地 HTML，Computer Use 截图并点击按钮，之后页面状态为 `CLICKED_OK`。任务共 7 个 DSH step、6 次工具调用，约 24.8 秒完成。桌面 UID 1000 不能免密 sudo，也不能读 UID 1001 的私有 DSH 状态目录；DSH 运行状态确实使用 UID 1001。这里验证的是 DSH Computer Use 的自动点击，不是用户通过 noVNC 的可见接管。

`.8` 保留默认 seccomp、`no-new-privileges` 和无宿主挂载/socket；root entrypoint 先启动 system D-Bus。Chrome 以非 root 用户运行且关闭内部 sandbox，以绕过默认 seccomp 对 user namespace 的限制。第一次独立 Files API 查询把 UUID 中的 `e8a9` 误写成 `8e9a`，所以正确返回了“不存在”；按任务 trace 中的准确路径重试后，Files API 独立读回 marker 成功并删除了精确的临时 proof 文件。这是诊断命令的路径抄录错误，不是 Cube Files API 不一致。HTML fixture 也已从 Docker 命名卷清理。noVNC 人工点击、应用/桌面容器重启恢复、Alpha/Beta `.8` 隔离与公网网页端到端验收仍未完成。功能分支默认 `CSA_DSH_PLACEMENT` 已设为 `docker`；`cube` 保留为旧模式；功能完成前不合并或发布。
