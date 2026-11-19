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

`npm run db:seed` 仅创建演示租户和账号，不会打印密码。若需重置本机演示密码，请在仓库外的环境文件设置 `CSA_TEST_PASSWORD_ALPHA` 与 `CSA_TEST_PASSWORD_BETA` 后重新运行种子命令。

## 当前可用范围

- 登录、登出、任务保存、历史读取和 SSE 事件已连接 MySQL。
- 服务端按会话中的租户 ID 过滤任务。Alice 与 Bob 可用于验证租户边界。
- Agent Runtime 尚未接入，提交的任务会停留在 `queued`；云电脑页面也会说明连接状态，不代表 DSH 或 microVM 已可用。
