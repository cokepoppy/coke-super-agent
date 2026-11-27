# 本地开发

## 安装依赖

在项目根目录运行：

```sh
npm install
```

如果 npm 访问 registry 停顿，可仅为本次命令设置 HTTP 代理，再运行安装：

```sh
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm install
```

这不会修改 npm 全局配置。代理地址按当前 Mac 上实际运行的 HTTP 代理调整。

## 配置数据库

应用只连接专用的 `coke_super_agent` schema。可以复制 `.env.example` 为 `.env` 并填入本地凭据；不要提交 `.env`。当前开发机使用 Cube Linux 节点内的独立 MySQL 测试库，并把凭据保存在仓库外：

```sh
export DOTENV_CONFIG_PATH="$HOME/.local/share/csa-cube-node/coke-super-agent.env"
```

启动应用前，MySQL 必须能通过配置的 host 和 port 访问。不要将其他应用的数据库用户或数据卷用于本项目。

## 初始化并运行

```sh
npm run db:migrate
npm run db:seed
npm run dev
```

本地 API 默认监听 `127.0.0.1:8080`，Vite 页面监听 `127.0.0.1:5173`。本地种子账号为 `alice` 和 `bob`，密码从本机环境变量读取，不放在仓库中；两者属于不同租户。

## 查看 Agent 链路日志

模板构建中的短命 bootstrap 和检查命令使用 Cube PTY 或 `commands.run`；需要持续运行的桌面会话由持久 Cube PTY 前台托管。SDK 的 `PtyHandle.disconnect()` 只断开日志流，不终止 guest 进程；模板 snapshot 创建后构建器才断开 PTY 并释放 VM。模板构建会把桌面 session 的启动事件同时流到 PTY 和 guest 日志文件，并在每次构建前清空旧 session 日志。构建日志记录 PTY PID、输出行、退出状态、桌面服务诊断，以及 guest websockify 与 Chrome CDP 的分步健康结果；noVNC 静态资源由 TypeScript 应用同源提供。一次健康检查限时 30 秒，避免对失效 VM 无限等待。克隆验收直接检查 snapshot 中的活动桌面进程、guest 6080 WebSocket listener 与 guest-local CDP endpoint，不会在验收后另行启动桌面来掩盖 snapshot 内容缺失。

任务事件保存在该租户的 MySQL `run_events` 中，登录产品后打开任务并启用“调试模式”即可查看完整时间线和失败阶段。Agent 异常会显示脱敏后的错误消息、堆栈和 cause 摘要，终止错误用红色突出显示；可恢复的目录回退和重试使用黄色警告。API 进程同时将同一事件以 JSON 行写到启动它的终端标准输出，使用 `logger=coke-super-agent.run` 和 `runId` 过滤；不会在仓库或 VM 里另外生成日志文件。云电脑操作另写带 `tenantId`、任务触发时的 `runId`、generation、sandbox ID 与阶段名的 `logger=coke-super-agent.computer` 事件；手动启动的云电脑也会输出结构化阶段日志。HTTP 错误带 `requestId`，任务入队日志会同时记录 request ID 与 run ID，便于从前端请求追到 Agent 任务。服务启动/迁移/退出及队列扫描分别使用 `logger=coke-super-agent.lifecycle` 和 `logger=coke-super-agent.agent-runtime`。部署环境应由现有服务管理器收集 stdout/stderr。

运行 `npm run cube:prepare-dsh-template` 时，完整模板构建过程以 JSON Lines 保存到仓库外的 `~/.local/share/csa-cube-node/build-logs/template-build-*.jsonl`；其中 Linux ARM64 runtime 打包子进程另写 `dsh-runtime-build-*.log`。两类日志默认权限为 `0600`。每条模板日志包含构建 `runId`、递增序号、总耗时、当前阶段与阶段耗时；阶段切换会分别记录开始和完成，构建结束或失败后输出完整阶段耗时摘要。慢阶段、Cube 命令、runtime wheel 下载、分片传输和 microVM 拼接每 15–30 秒写心跳或进度，命令日志保留脱敏命令、哈希、退出码、输出量和尾部输出。模板日志会记录 Cube API 的脱敏地址、请求超时、仓库/日志/runtime 缓存卷可用空间，以及构建前和 snapshot 克隆前的 running/paused VM 数量与 vCPU/内存分配；任何 `Sandbox.create` 失败都会记录 HTTP 状态、错误码、request ID、cause、堆栈、失败后的 VM/磁盘快照，并列出 CubeMaster、Cubelet、CubeShim、VMM 的日志与只读压力检查路径。日志不保存认证头或原始响应正文。runtime 打包日志还会在 wheel 下载、npm 安装和归档前后记录缓存卷空间。DSH guest 安装器通过 PTY 把 stdout/stderr 逐行写入同一构建日志，同时保存在 guest `install.log`；解包期间每 30 秒记录归档读取量、guest 写入量、Node 文件大小、RSS 和可用磁盘空间，方便判断大文件 I/O 是否仍在前进。桌面启动记录准备条件、PTY 创建和命令发送，实时收集 PTY 输出；服务未就绪时记录 PTY 状态、websockify/CDP 健康、进程、监听端口及 XFCE/VNC/Chrome 相关日志尾部。Chrome 桌面启动的 CDP 等待上限为 360 秒，以覆盖已观测到超过 218 秒的启动过程；失败清理不会删除 root-owned 的桌面安装标记。snapshot 克隆校验在 DSH 初始化前分段打印 runtime、桌面包、活动会话、websockify listener、Chrome CDP 和用户权限验收点；CDP 最多重试 360 秒，每次记录 HTTP 状态、耗时、响应字节数与监听状态，并校验 `/json/version` 的 JSON 字段。克隆 smoke 的 PTY 上限为 20 分钟，以容纳桌面恢复和 DSH 初始化；失败时保留最后成功检查和完整错误上下文。可通过 `CSA_BUILD_LOG_DIR` 改日志目录，并用 `tail -F ~/.local/share/csa-cube-node/build-logs/template-build-*.jsonl` 或 `tail -F ~/.local/share/csa-cube-node/build-logs/dsh-runtime-build-*.log` 查看。写日志前会过滤配置凭据。

多轮模板构建失败的阶段、已确认原因、上游 CubeSandbox 对照、未确认问题、builder 清理状态和安全重试规程记录在 [模板构建排障记录](./template-build-incident-2026-11-21.md)。阅读失败日志时，区分原始错误与人工中止后的派生错误；guest 健康端口探测和 guest-agent TTRPC 超时目前是两个独立现象，尚无证据指向宿主资源不足。

镜像模板租户启动会记录预装 manifest、软件/runtime 校验、机器 ID、服务启动和 websockify/CDP readiness；镜像标记存在时不会在 guest 调用 apt，缺少软件时会直接失败并指出路径。旧模板兼容安装路径会继续记录 apt update/install 心跳。guest 日志在 `/var/lib/csa-desktop/bootstrap.log`、`/var/lib/csa-desktop/apt.log` 和 `/tmp/csa-desktop-session.log`；主机每 30 秒把可用日志尾部写入任务调试时间线，安装失败时收集更长的日志尾部。日志不包含任务 prompt 或 API key。

CubeSandbox 的业务请求日志在 Lima 节点的 `/data/log/` 下，而 `journalctl` 主要用于服务启动和退出问题。构建 `runId` 会作为 `csa_template_build_run` 写入创建请求的 metadata；`sandbox.create.failure.diagnosis` 事件会给出按此 run ID 搜索 CubeMaster、再按 sandbox/container ID 搜索 Cubelet、CubeShim 与 VMM 的命令，CubeMaster 命中项中的 `RequestId` 可以继续串联 Cubelet 请求。日志轮转后按通配路径同时搜索当前文件和 `.1` 文件。若错误包含 `agent reconnect`、`reset guest time` 或 `ttrpc`，重点检查 CubeShim vsock/guest-agent 记录，并用 `vmstat 1 5` 和 `/proc/pressure/{cpu,memory,io}` 区分 host 调度压力与 guest 启动问题。CubeMaster 配置位于 `/usr/local/services/cubetoolbox/CubeMaster/conf.yaml`。不要只看 systemd journal 来判断 Sandbox.create 的业务失败原因。

设置仓库外环境文件中的 `CSA_TOKEN_ENCRYPTION_KEY` 为稳定的 32 字节随机 base64url 密钥。CubeSandbox 返回的私有数据面令牌以 AES-256-GCM 加密后保存在专用 MySQL 库中；更换密钥前需先迁移现有密文。

使用本机 CubeSandbox 时，先启动本地 Cube 节点，再建立只监听 Mac 回环地址的管理 API 隧道：

```sh
export CSA_CUBE_LAB_HOME="$HOME/.local/share/csa-cube-node"
export LIMA_HOME="$CSA_CUBE_LAB_HOME/lima"
export LIMACTL="$HOME/Library/Application Support/Coke Super Agent/lab/lima-2.3.0/bin/limactl"
bash scripts/cube/start-local-node.sh
bash scripts/cube/ensure-local-api-tunnel.sh
```

镜像分发使用 Mac 上的本地 Registry，不需要 GHCR 写权限，也不会把个人镜像推到公网。Registry 容器 `csa-local-registry` 只绑定 `127.0.0.1:15001`，数据保存在 `~/.local/share/csa-cube-node/registry-data`；`scripts/cube/ensure-local-api-tunnel.sh` 会确保容器运行，并通过 Lima SSH 将 guest 的 `127.0.0.1:15002` 反向转发到该 Registry。它不重启 Cube 服务。Registry 没有单独的用户名/密码认证，当前通过 Mac 回环监听限制访问；不要把端口改绑到公网地址。请保留这块专用卷的可用空间，Registry 中的镜像层会持续占用磁盘。

在外部环境文件中设置 `CUBE_API_URL=http://127.0.0.1:13000`、`CUBE_PROXY_NODE_IP=127.0.0.1`、`CUBE_PROXY_PORT_HTTP=28080`、`CSA_DESKTOP_IMAGE=coke-super-agent-desktop:dev` 和 `CSA_NPM_HTTP_PROXY`。API 地址走本机 13000 隧道，SDK 的文件、命令和 PTY 数据面通过 28080 隧道访问 CubeProxy；仅设置 API 地址会让 SDK 尝试解析 `49983-<sandbox>.cube.app`，本机没有该 DNS 时数据面会报 `fetch failed`。先运行 `bash scripts/cube/ensure-local-api-tunnel.sh`，再以 `CSA_DESKTOP_IMAGE_PUSH=1 npm run cube:desktop-image` 构建并推送到该回环 Registry。构建日志会输出不可变 image digest 和可直接用于 Cube 的 `CUBE_DESKTOP_BASE_IMAGE` 地址。把这个地址写入外部环境文件后运行 `npm run cube:desktop-template`，再把输出的模板 ID 写到 `CUBE_TEMPLATE_ID` 并清空旧 `CSA_CUBE_DSH_TEMPLATE_SNAPSHOT_ID`。应用优先采用 `CUBE_TEMPLATE_ID`；只有它为空时才回退到旧 snapshot 配置。租户启动时从这个模板创建一台 VM，软件和 DSH/Pi runtime 已在镜像中，控制面只启动桌面会话并检查 CDP。`cube:prepare-dsh-template` 是旧的 microVM 内安装/快照流程，不再是标准镜像构建路径。只有登录用户可启动或恢复自己租户的 microVM；Cube 管理 API 不进入浏览器。

公网 UI 使用 `/super-agent/` 子路径。构建时设置 `CSA_PUBLIC_BASE_PATH=/super-agent/`，然后运行 `npm run build`；生产静态页面由 `npm run start:web` 提供，API 由 `npm run start` 提供，Vite Preview 会把此前缀下的 `/api`、`/novnc` 与 `/health` 转给本机 API。`deploy/vps/super-agent.locations.conf` 只代理到 VPS `127.0.0.1:14331`，`scripts/vps/super-agent-reverse-tunnel.sh` 只建立 VPS loopback `14331` 到 Mac web 端口 `5173` 的 SSH 反向转发；通过 `CSA_VPS_SSH_IDENTITY_FILE` 可指定现有 VPS SSH 身份文件，脚本不读取或复制私钥内容。当前 Mac 侧前缀、资源、API 和匿名认证边界已用 Vite Preview 验证；VPS 配置和隧道还未启用。

`CSA_AGENT_RUNTIME` 可设为 `dsh` 或 `pi`，默认是 `dsh`。`CSA_DSH_PLACEMENT` 默认 `docker`：每租户一个 Docker 容器同时运行 DSH、XFCE、可见 Chrome、noVNC 和 Browser/Computer 插件，`computer_terminal` 通过应用内短期 HMAC 令牌桥接到对应的 Cube microVM。设为 `cube` 可沿用 DSH 在 microVM 内运行的旧路径；Docker placement 目前仅支持 DSH。Docker 模式会禁用 DSH 的本地 Bash、PowerShell、文件系统和工作目录工具；DSH 使用独立 UID 1001，桌面使用 UID 1000，基础镜像的桌面免密 sudo 会在启动时移除，降低 GUI 终端读取 Agent 凭据或提权的风险。Cube API 管理密钥不会进入 Agent 容器。运行镜像由 `npm run docker:desktop-image` 构建：基础镜像 `csa-super-agent-desktop:20261127.1`，当前候选输出 `csa-super-agent-desktop:20261127.8`；构建器只把锁定的 DSH ARM64 runtime、当前工具插件和启动脚本放入临时 context，不包含 `.env` 或仓库其他文件，缓存、构建日志均在仓库外。Docker 容器和命名卷由应用按租户 ID 确定性创建，不挂载宿主路径或 Docker Socket；noVNC 端口只绑定宿主 loopback。`.8` 已通过真实 DSH 远端 Cube Bash 写读、Browser 页面检查和 Computer Use 点击受控 HTML 按钮，页面状态变为 `CLICKED_OK`；桌面 UID 1000 无法读取 UID 1001 的私有 DSH 状态。Chrome 关闭了容器内 sandbox；noVNC 人工接管、应用/容器重启恢复、当前构建的双租户隔离和公网页面点击验收仍待完成。

Pi 试验先沿用 Coke Dots/Grok Bot 已用过的 `@mariozechner/pi-coding-agent@0.73.1` SDK 和 `AuthStorage` / `ModelRegistry` 接口；该 npm 包已标记为弃用，后续需在 microVM 内的启动耗时和功能验收后再决定是否迁移维护中的 `@earendil-works/pi-coding-agent`。Pi 使用 Coke Dots/Grok Bot 已验证的 `openai-completions` provider；`CSA_PI_DEEPSEEK_BASE_URL` 可单独指定 Pi endpoint，未设置时从 `DEEPSEEK_BASE_URL` 移除 `/anthropic` 后缀，默认结果为官方 OpenAI-compatible `https://api.deepseek.com`。DSH 仍使用 Anthropic-compatible endpoint。API key 只通过 guest 进程环境注入，再由 Pi SDK 放在内存 credential store 中，启动 bash 工具前会从环境变量移除。Pi ARM64 包由模板构建器通过 Mac HTTP 代理构建并缓存到仓库外，然后预装进 OCI 镜像；租户启动任务时按 runtime key 校验和复用镜像包，旧模板或 key 不匹配时才在该租户 microVM 内补装。会话按 tenant VM 和 conversation thread 分开保存在 guest workspace。Pi 通过 TypeBox custom tools 复用同一份 DSH Chromium/CDP 与 X11 Computer Use 插件，启用图片输入，并把登录/验证码 handoff 写成 `waiting_for_user` 任务状态；权限保持开放，不加逐步审批。2026-11-22 Beta 曾在旧模板 microVM 内完成真实 Pi/DeepSeek 终端任务，Pi 收到首 token、调用一次 bash、写入并读回文件；当时还通过了三项 Browser/Computer custom tool 注册与 session import smoke。这不证明当前候选模板通过。当前模板内 Browser/Computer 操作、截图图像回传、handoff、持久化和 UI 验收仍待完成。打包器使用公共读取权限生成 node_modules，避免在 guest 对整个依赖目录递归 chmod。

`npm run db:seed` 仅创建演示租户和账号，不会打印密码。若需重置本机演示密码，请在仓库外的环境文件设置 `CSA_TEST_PASSWORD_ALPHA` 与 `CSA_TEST_PASSWORD_BETA` 后重新运行种子命令。

## 当前可用范围

- 登录、登出、任务保存、历史读取和 SSE 事件已连接 MySQL。
- 服务端按会话中的租户 ID 过滤任务。Alice 与 Bob 可用于验证租户边界。
- CubeSandbox SDK 提供每租户一台 microVM 的启动和恢复入口。标准路径先在 ARM64 OCI 镜像构建阶段预装 XFCE、Google Chrome、Node.js、Python、apt 和 DSH/Pi runtime，再由 Cube 创建模板；租户启动只校验镜像清单并启动桌面会话，不在 microVM 启动时安装这些基础软件。apt 仍可供用户在桌面里安装额外 Linux 包。
- 租户 microVM 开启公网 IPv4 出站（`allowInternetAccess: true`），允许 Browser Use、Computer Use 和终端直接工作；登录与验证码由用户接管。创建请求不使用 `allowOut: 0.0.0.0/0`，以保留 Cube 对宿主及租户内网的默认保护。Cube 按允许规则优先于拒绝规则的顺序处理网络策略，具体隔离效果需要在数据面实测。 [CubeSandbox 网络策略](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/network-policy.md)
- `CSA_DESKTOP_RESOLUTION` 同时设置虚拟显示器和 Computer Use 坐标边界，默认 `1280x800`。
- Coke Super Agent 服务为每个租户串行调度任务；`CSA_AGENT_RUNTIME=dsh|pi` 选择 Harness，`CSA_DSH_PLACEMENT=cube|docker` 选择 DSH 与桌面位置，默认采用 Docker 模式。每租户一个 DSH/图形桌面容器和两个宿主命名卷，DSH 通过应用桥接工具访问单独的 Cube microVM；状态文件、启动意图、Docker 进程身份和 session JSONL 用于应用重启后的任务对账。`.8` 已完成一次真实模型、远端终端、Browser/Computer 点击任务；noVNC 人工接管、恢复、当前镜像双租户隔离和公网产品页验收仍待完成。
- 任务文件保存在 `/workspace/tasks/<threadId>`；任务页按租户读取 Dots 风格的文件卡片，提供同源流式下载和 sandbox iframe 预览。首版不复制文件到 MySQL 或新增文件服务。
- Linux ARM64 DSH 运行包由 Mac 宿主通过 `CSA_NPM_HTTP_PROXY` 指向的 HTTP 代理准备，并按 npm 锁文件与运行时清单的组合哈希缓存在仓库外的 `~/.cache/csa-cube-node/runtime-cache`（可用 `CSA_AGENT_RUNTIME_CACHE_DIR` 覆盖）。它包含 Node 24 下运行的 TypeScript SDK 客户端，以及版本匹配、SHA-256 校验的 DeepSeek 官方 Linux ARM64 Runtime wheel；宿主先下载和拼好，再分块传给对应 microVM。guest 不访问 npm 或 PyPI；不修改 npm 全局代理，也不向 guest 暴露 Mac 回环代理。
- 运行日志统一使用 JSON Lines 输出到 Coke Super Agent 服务的 stdout/stderr（本机 `npm run dev:server` 终端或部署容器日志）。每条都有 `tenantId`、`runId` 和 `sequence`；trace 同时持久化到 MySQL `run_events`。任务页和“活动”页的“调试模式”显示同一顺序、时间、组件、阶段、耗时与结构化详情；失败阶段使用红色提示。DeepSeek Harness launcher、JSON-RPC 帧、进程采样及 Computer Use 内部阶段会持续转发到整个任务结束，覆盖模型请求、截图子进程、图片附件保存、Chrome target discovery、WebSocket 建连和 CDP 命令。错误通知与 `assistant/attempt` 事件会单独保留；重复的高频普通通知会合并计数。模型请求结束事件包含 `finishReason`、协议事件类型统计和通知数量；空响应会把这些摘要放进醒目的失败信息。日志只记录事件结构与安全诊断字段，不记录消息正文、最终回复、页面正文、表单值或认证头；写入前还会过滤凭据和敏感字段。
- 旧模板上先后完成过真实 DSH/Browser inspect 与 Beta Pi/DeepSeek 终端任务；这些历史运行不代表当前镜像。2026-11-26 的本机配置选择 Pi 与 `deepseek-flash`；官方 DeepSeek API 的一次小请求返回 HTTP 200，但这只确认当前 key、模型名和 endpoint，不代表 Pi 已在当前候选模板里运行。
- 产品 UI 的任务页、调试时间线和云电脑页曾通过 Computer Use 登录 Alice 实际查看；当前红色失败提示的最新样式尚未在本轮视觉复核。2026-11-26 公网 `/super-agent/` 的 UI/静态资源、health、匿名拒绝、Alice 登录/登出和 Secure Cookie 已通过 HTTP 验收；登录后视觉、noVNC 首帧/键鼠、当前模板内 Browser/Computer Use、终端交付、接管后续跑、应用/Mac 重启恢复和第二租户真实隔离仍待验收；完整产品验收通过前不合并或发布。
- 任务等待登录或验证码时，Agent 通过 `computer_request_user_control` 暂停操作；用户在云电脑中完成验证后，在同一对话发送继续指令，DSH 使用同一持久 Session 继续。

## Mac 公网开发服务

运行 `CSA_PUBLIC_BASE_PATH=/super-agent/ npm run build` 后，`npm run macos:install-public-services` 会安装并启动三个当前用户 LaunchAgent：`com.coke.super-agent.api` 在 `127.0.0.1:8080` 运行生产模式 TypeScript API；`com.coke.super-agent.public-web` 在 `127.0.0.1:5174` 提供 Vite production preview；`com.coke.super-agent.public-tunnel` 由 `/usr/bin/ssh` 建立 `127.0.0.1:14331 → Mac 127.0.0.1:5174` 的反向转发。公网入口为 `https://codex.cokeagent.com/super-agent/`。VPS 上只运行 Nginx 转发规则和 SSH 回环监听，不部署应用、Cube 或租户数据。

API 与 Preview 的 stdout/stderr 分别写入 `~/Library/Logs/coke-super-agent-api.{out,err}.log` 与 `~/Library/Logs/coke-super-agent-public-web.{out,err}.log`；SSH 隧道日志写入 `~/Library/Logs/coke-super-agent-public-tunnel.{out,err}.log`。可用 `launchctl print gui/$(id -u)/com.coke.super-agent.api` 检查服务，用 `tail -F` 查看日志。API 在该 LaunchAgent 下以 `NODE_ENV=production` 和 `CSA_COOKIE_SECURE=true` 启动；VPS HTTPS location 还会为 `csa_session` 设定 Secure、HttpOnly、SameSite=Lax。Nginx 将 `$request_id` 记入 `/var/log/nginx/coke-super-agent.access.log`，只记录 `$uri` 而不记录 query 参数，并通过 `X-Csa-Edge-Request-Id` 传给 API；API 对 32 位十六进制 ID 做格式校验后，将它作为同一个 `requestId` 写入错误/任务日志并通过 `X-Csa-Request-Id` 返回。2026-11-26 的匿名 401 复测已在 Nginx 和 API 日志中看到完全相同的 ID。Nginx 的活动配置是 `/etc/nginx/sites-enabled/coke-openrouter`；修改时需备份该实际加载文件并先运行 `nginx -t`。
