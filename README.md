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
│       ├── BuilderPanel.tsx   # 场景构建器 UI
│       ├── builderApi.ts      # 构建器 / 模板 API 客户端
│       ├── main.tsx
│       └── styles.css
├── server/
│   ├── index.ts               # Express 路由
│   ├── packets.ts             # raw 解析与内置样例（不被模板污染）
│   ├── builder.ts             # 结构化输入 → raw 生成 + 冲突校验
│   └── scenario-store.ts      # 用户模板持久化（data/ 目录）
├── shared/
│   └── types.ts
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
└── .gitignore
```

## 功能

1. **模拟数据选择**：在 HTTP / TCP 协议之间切换，并选择请求、响应或 TCP 握手场景。
2. **数据包输入**：编辑原始 HTTP 文本或 TCP 模拟摘要，点击“解析数据包”重新生成可视化结果。
3. **场景构建器**：通过结构化表单选择 HTTP 请求/响应或 TCP 握手/数据方向，分别填写起始行、Header、Body、端点和 TCP 控制字段；服务端实时生成符合当前模拟格式的 raw 文本与可直接解析的完整包，区分必填/可选字段，并对字段冲突（如响应 Content-Length 与 body 不一致、握手报文却带数据长度、端点与 Host 不一致等）给出错误/警告。生成的场景可保存为带唯一标识的模板，与内置样例完全隔离。
4. **协议字段树**：HTTP 展示起始行、Header、Payload；TCP 展示 Ethernet、IPv4、TCP 和 Payload 层级，并支持折叠。
5. **十六进制视图**：以 offset、hex bytes、ASCII 三列展示当前 payload 的 UTF-8 字节。
6. **传输时间线**：展示抓包、解析、传输层解码和结构化输出等阶段。
7. **解析 API / 模拟数据 API / 构建器 API**：Express 服务提供 `/api/parse`、`/api/simulate`、`/api/packets`、`/api/builder/*` 和 `/api/health`。

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

### 场景构建器：结构化生成 raw（含冲突校验）

```bash
curl -X POST 'http://localhost:3001/api/builder/build' \
  -H 'Content-Type: application/json' \
  -d '{
    "input": {
      "kind": "http",
      "scenario": "response",
      "response": { "status": "200" },
      "headers": [{ "key": "Content-Length", "value": "999" }],
      "body": "hi"
    },
    "syncContentLength": false
  }'
# 返回 raw + 完整 packet + conflicts（此处会报 Content-Length 与 body 不一致）
# 省略 syncContentLength 或置为 true 时，Content-Length 会按 body 自动修正，冲突降级为 warning
```

TCP 握手/数据方向（`scenario=handshake|request|response` + `direction`，端点、Seq/Ack/Flags/Win/MSS/WS/Len 等字段按需填写，握手报文带 `Len>0` 会报错误）：

```bash
curl -X POST 'http://localhost:3001/api/builder/build' \
  -H 'Content-Type: application/json' \
  -d '{"input":{"kind":"tcp","scenario":"handshake","direction":"request","flags":"SYN","mss":1460,"windowScale":7}}'
```

### 场景模板：保存 / 列表 / 更新 / 删除

```bash
# 保存（自动生成 tpl-<uuid> 唯一标识）
curl -X POST 'http://localhost:3001/api/builder/templates' \
  -H 'Content-Type: application/json' \
  -d '{"name":"第3课-SYN","input":{"kind":"tcp","scenario":"handshake","direction":"request","flags":"SYN"}}'

curl 'http://localhost:3001/api/builder/templates'                 # 列表（?protocol=TCP 过滤）
curl 'http://localhost:3001/api/builder/templates/tpl-xxxx'        # 单个详情
curl -X PUT  'http://localhost:3001/api/builder/templates/tpl-xxxx' -H 'Content-Type: application/json' -d '{"name":"新名字","input":{...}}'
curl -X DELETE 'http://localhost:3001/api/builder/templates/tpl-xxxx'
```

> 用户模板持久化在服务端 `data/scenario-templates.json`（可用环境变量 `PACKET_LAB_DATA_FILE` 自定义路径），与代码中的内置样例常量完全分离；对模板的任何增删改都不会影响 `/api/simulate`、`/api/packets` 返回的内置样例。

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
