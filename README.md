# Coke Super Agent

Coke Super Agent 是一个个人 Agent 项目。首版方案沿用 Coke Dots 的任务和云电脑交互，使用 DeepSeek Harness 执行任务，并为每个个人租户配置一台持久的 CubeSandbox Linux microVM。

[阅读技术方案](docs/technical-plan.md)

[运行 Mac KVM 与 CubeSandbox 主机预检](docs/cube-preflight.md)

本地节点配置与真实 microVM 验证记录见 [CubeSandbox 实测](docs/cube-preflight.md#2026-11-19-m5-本地单节点实测)。

当前代码已包含 TypeScript API、Dots 风格任务工作区、MySQL 登录与租户隔离的任务记录，并通过官方 CubeSandbox SDK 实现每租户一台持久 microVM 的启动与恢复入口。任务会保存为 `queued`；DeepSeek Harness 和图形桌面/Chrome 模板仍在后续阶段接入，页面会明确显示尚未连接。

本地依赖、测试账号和启动方式见[开发说明](docs/local-development.md)。
