# Network Packet Lab · 网络协议数据包可视化实验室

项目 10：一个用于学习和演示网络协议解析过程的可视化实验室。当前版本聚焦模拟 HTTP / TCP 数据包，提供输入、场景选择、协议层级字段树、十六进制数据、解析时间线，以及可供 React 管理界面调用的 Node.js API。

## 技术栈

- **前端**：React 18、Vite、TypeScript
- **后端**：Node.js、Express、TypeScript
- **工程**：前后端共享 `shared/types.ts` 类型，根目录统一管理脚本

## 目录结构

```text
network-packet-lab/
├── client/
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── styles.css
│       ├── vite-env.d.ts
│       └── components/
│           └── ScenarioBuilder.tsx
├── server/
│   ├── index.ts
│   ├── scenarioBuilder.ts
│   └── templateStore.ts
├── shared/
│   ├── types.ts
│   └── protocol.ts
├── data/                        # 运行时生成，用户模板（已 gitignore）
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
└── .gitignore
```

## 功能

1. **模拟数据选择**：在 HTTP / TCP 协议之间切换，并选择请求、响应或 TCP 握手场景。
2. **数据包输入**：编辑原始 HTTP 文本或 TCP 模拟摘要，点击“解析数据包”重新生成可视化结果。
3. **场景构建器**：分别选择 HTTP 请求/响应或 TCP 握手/数据方向，通过结构化表单填写起始行、Headers、Body、端点和 TCP 控制字段，服务端生成符合模拟格式的 raw 文本并直接返回可解析的数据包；必填/可选字段分区标注，字段冲突（如 Content-Length 与 body 不一致、握手报文携带数据长度）即时列出，场景可保存为带唯一 ID 的模板。
4. **协议字段树**：HTTP 展示起始行、Header、Payload；TCP 展示 Ethernet、IPv4、TCP 和 Payload 层级，并支持折叠。
5. **十六进制视图**：以 offset、hex bytes、ASCII 三列展示当前 payload 的 UTF-8 字节。
6. **传输时间线**：展示抓包、解析、传输层解码和结构化输出等阶段。
7. **解析 API / 模拟数据 API / 构建器 API**：Express 服务提供 `/api/parse`、`/api/simulate`、`/api/packets`、`/api/builder/generate`、`/api/templates` 和 `/api/health`。

## 启动方式

当前只完整落盘项目文件，**没有安装依赖**。准备运行时，在本目录执行：

```bash
npm install
```

然后打开两个终端：

```bash
# 终端 1：启动 API 服务（默认 3001）
npm run dev:server

# 终端 2：启动 Vite 管理界面（默认 5173）
npm run dev:client
```

浏览器访问 `http://localhost:5173`。如需更换 API 地址，可设置 `VITE_API_BASE`，例如：

```bash
VITE_API_BASE=http://localhost:3001 npm run dev:client
```

生产构建：

```bash
npm run build
npm start
```

> `npm start` 会启动编译后的 API 服务；前端静态产物位于 `dist/client`，可交给任意静态服务器托管。

## API 示例

### 获取模拟数据

```bash
curl 'http://localhost:3001/api/simulate?protocol=HTTP&scenario=request'
curl 'http://localhost:3001/api/simulate?protocol=TCP&scenario=handshake'
```

### 解析输入数据包

```bash
curl -X POST 'http://localhost:3001/api/parse' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"HTTP","scenario":"request","raw":"GET /health HTTP/1.1\\r\\nHost: lab.local\\r\\n\\r\\n"}'
```

### 获取某协议的全部示例

```bash
curl 'http://localhost:3001/api/packets?protocol=TCP'
```

### 使用场景构建器生成数据包

结构化输入由服务端生成 raw 文本，并直接返回解析后的包。HTTP 请求的 Host header 由 `endpoint` 自动生成（端口可留空）；响应可只填 `statusCode`，reason phrase 按状态码自动补全。

```bash
# HTTP 响应（Content-Length 由表单维护，不一致会返回 422 冲突）
curl -X POST 'http://localhost:3001/api/builder/generate' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"HTTP","scenario":"response","version":"HTTP/1.1","statusCode":"200","headers":[{"key":"Content-Type","value":"application/json"},{"key":"Content-Length","value":"17"}],"body":"{\"ok\":true}"}'

# TCP 握手（dataLength > 0 会返回 422 冲突）
curl -X POST 'http://localhost:3001/api/builder/generate' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"TCP","scenario":"handshake","source":{"host":"10.0.0.24","port":51842},"destination":{"host":"10.0.0.8","port":443},"flags":["SYN"],"window":64240,"mss":1460,"windowScale":7}'
```

校验结果分两级：`error`（必填缺失或字段冲突，返回 422，不生成包）和 `warning`（非阻断提示，随包一起返回）。

### 场景模板

模板带服务端分配的唯一 ID（`tpl-xxxxxxxxxxxx`），保存在 `data/scenario-templates.json`（可用 `PACKETLAB_TEMPLATE_FILE` 覆盖路径），与代码中的内置样例完全隔离。

```bash
curl 'http://localhost:3001/api/templates?protocol=TCP'                 # 列表（可按协议过滤）
curl -X POST 'http://localhost:3001/api/templates' \
  -H 'Content-Type: application/json' \
  -d '{"name":"课堂演示A","input":{ ...构建器输入... }}'                 # 保存（含冲突会被拒绝）
curl -X PUT 'http://localhost:3001/api/templates/tpl-xxxx' \
  -H 'Content-Type: application/json' -d '{"name":"新名字"}'            # 更新
curl -X DELETE 'http://localhost:3001/api/templates/tpl-xxxx'           # 删除
```

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
