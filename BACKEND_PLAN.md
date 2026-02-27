# 练了码 - 后端实现计划与部署计划

> 最后更新：2026-02-25

---

## 一、当前状态总览

### 已完成

| 模块 | 文件 | 状态 |
|------|------|------|
| Hono 入口 | `src/index.ts` | ✅ 路由挂载，CORS 动态配置，Agents 中间件 |
| 类型定义 | `src/types.ts` | ✅ Bindings + Variables |
| 认证中间件 | `src/middleware/auth.ts` | ✅ PBKDF2 加盐哈希 + 恒定时间比较 + 密码修改后 token 失效 |
| 注册/登录/改密 | `src/routes/auth.ts` | ✅ register/login/me/password/account |
| 用户档案 CRUD | `src/routes/profile.ts` | ✅ GET/PUT |
| 理化指标 CRUD | `src/routes/health.ts` | ✅ GET/POST/DELETE |
| 伤病记录 CRUD | `src/routes/conditions.ts` | ✅ GET/POST/PUT/DELETE |
| 训练计划 | `src/routes/training.ts` | ✅ GET/POST/PUT(完成标记) |
| 训练目标 | `src/routes/training-goals.ts` | ✅ GET/POST/PUT/DELETE |
| 营养方案 | `src/routes/nutrition.ts` | ✅ GET/POST + R2 图片上传 |
| 饮食记录 | `src/routes/diet.ts` | ✅ GET/POST |
| 每日日志 | `src/routes/daily-logs.ts` | ✅ GET/POST |
| 图片服务 | `src/routes/images.ts` | ✅ R2 上传/下载 |
| AI 对话 (WS) | `src/agents/supervisor-agent.ts` | ✅ AIChatAgent WebSocket 主链路（聊天 + 单次任务） |
| 单次任务 WS 客户端 | `mobile/services/agent-stream.ts` | ✅ 首页计划 / 饮食分析 / 图片识别已迁移 |
| 档案同步工具 | `src/agents/sync-profile-tool.ts` | ✅ Tool Calling + Human-in-the-loop |
| 广播协议定义 | `src/agents/contracts.ts` | ✅ 类型安全的事件广播 |
| LLM 服务 | `src/services/llm.ts` | ✅ 60s 超时 + 3 次重试 + 指数退避 + 模型 fallback |
| AI Provider | `src/services/ai-provider.ts` | ✅ AI SDK OpenAI-compatible 适配 |
| 智能路由 | `src/services/orchestrator.ts` | ✅ 关键词 + LLM 双路由 + 协作者补充意见 + 自动写回 |
| 上下文组装 | `src/services/context.ts` | ✅ 按角色构建上下文 |
| 输入校验 | `src/utils/validate.ts` | ✅ 通用校验函数 |
| 接口限流 | `src/middleware/rateLimit.ts` | ✅ KV 滑动窗口限流 |
| 4 个角色 Prompt | `src/prompts/*.ts` | ✅ 中文 system prompt |
| 数据库 Schema | `src/db/schema.sql` | ✅ 含迁移脚本 |
| Wrangler 配置 | `wrangler.toml` | ✅ 真实 ID + 自定义域名 + DO 绑定 |
| TypeScript 编译 | `npx tsc --noEmit` | ✅ 零错误 |
| 生产部署 | `api-lite.izlx.de5.net` | ✅ Cloudflare Workers 自定义域名 |

### 未完成

- ⚠️ 精确 tokenizer 计数（当前为估算型 token 预算裁剪）
- ❌ Drizzle ORM 迁移（不在当前范围）
- ❌ 自动化测试

---

## 二、安全加固（已完成 ✅）

### 2.1 密码哈希改造 ✅

已在 `src/middleware/auth.ts` 中实现 PBKDF2-SHA256：
- 16 字节随机盐 + 100,000 轮迭代
- 存储格式 `salt:hash`（十六进制）
- `constantTimeEqual()` 恒定时间比较，防时序攻击
- 密码修改后在 KV 记录时间戳，auth 中间件检查 token 签发时间使旧 token 失效

### 2.2 输入校验 ✅

已创建 `src/utils/validate.ts`，各路由处理器使用校验逻辑。

### 2.3 接口限流 ✅

已在 `src/middleware/rateLimit.ts` 中实现 KV 滑动窗口限流：
- `/api/auth/login`：同一 IP 每分钟最多 10 次
- `/api/auth/register`：同一 IP 每小时最多 5 次
- `HTTP CRUD` 路由：按端点配置用户/来源限流

> 说明：AI 已迁移为 WS 单协议，`/api/ai/*` 已下线；`/agents/*` 的 WS 连接限流属于下一步增强项。

### 2.4 CORS 收紧 ✅

`src/index.ts` 中动态读取 `ALLOWED_ORIGINS` 环境变量配置允许的来源：
```typescript
// 默认允许 http://localhost:8081, http://localhost:19006
// 生产环境通过 wrangler.toml [vars] ALLOWED_ORIGINS 配置
```

---

## 三、功能完善

### 3.1 LLM 服务加固 ✅

**文件**：`src/services/llm.ts`

已实现：
- 60 秒 AbortController 超时
- 最多 3 次重试 + 指数退避
- 仅对 408/429/5xx 和网络错误重试，4xx 不重试
- 模型 fallback 链（LLM → LLM1）

### 3.2 上下文 Token 控制 ✅（估算版）

**文件**：`src/services/context.ts`

**现状**：
- `src/services/context.ts` 已实现 `estimateTokens()` 与 `trimMessages()`。
- `src/agents/supervisor-agent.ts` 已对 WS 主链路与单次任务链路加入 token 预算裁剪（基于 system prompt 预算 + 对话历史预算）。

**待完善（可选优化）**：
```
1. 引入模型级精确 tokenizer（替代当前估算）
2. 根据模型动态预算（不同模型窗口差异）
3. 增加预算命中率与截断比例监控
```

### 3.3 已完成的接口 ✅

#### GET /api/auth/me ✅
返回当前登录用户的 id, email, nickname。

#### PUT /api/auth/password ✅
验证旧密码 → 哈希新密码 → 更新 → KV 记录密码修改时间使旧 token 失效。

#### DELETE /api/auth/account ✅
应用层级联删除：D1 batch 原子删除用户关联的所有数据 + KV 清理。

---

## 四、架构演进：AIChatAgent (Cloudflare Agents SDK)

> 此部分为 2026-02 新增，描述从 SSE 到 WebSocket 的架构迁移。

### 4.1 核心架构

```
移动端 ai.tsx — 纯 WebSocket，无 REST 历史加载
  ↕ WebSocket (wss://api-lite.izlx.de5.net/agents/supervisor-agent/{userId}?token={jwt}&sid={sessionId})
Cloudflare Workers / Hono Gateway
  → /agents/* → hono-agents 中间件
    → SupervisorAgent (Durable Object, 继承 AIChatAgent)
      ├── JWT 认证 (onConnect)
      ├── 智能路由 (decideRoute)
      ├── 流式回答 (streamText + AI SDK)
      ├── 协作者补充意见 (generateCollaboratorSupplements)
      ├── sync_profile 工具 (Tool Calling + Human-in-the-loop)
      └── D1 双写 (saveOrchestrateHistory)

移动端 index.tsx / diet / useImageAnalysis — 单次任务 WS
  → `mobile/services/agent-stream.ts`（preferred_role + single_role + allow_profile_sync=false）
```

### 4.2 Durable Objects

| DO 类 | 状态 | 说明 |
|--------|------|------|
| `SupervisorAgent` | ✅ 生产就绪 | 继承 `AIChatAgent`，WebSocket 主链路 |
| `ProfileManagerAgent` | 🗑️ 已删除 | `v3_remove_profile_manager` 迁移已移除，相关代码与绑定已清理 |
| Specialist Agent DO × 4 | 🗑️ 已删除 | v2_remove_specialists 迁移中移除，角色逻辑内聚到 SupervisorAgent |

### 4.3 WebSocket 事件协议

| 事件类型 | 方向 | 说明 |
|----------|------|------|
| `cf_agent_use_chat_request` | 客户端→服务端 | 发送用户消息 |
| `cf_agent_use_chat_response` | 服务端→客户端 | 流式 AI 回复（UIMessageStream 分块） |
| `cf_agent_chat_messages` | 服务端→客户端 | DO 持久化消息广播（多设备同步） |
| `cf_agent_chat_clear` | 客户端→服务端 | 清空 DO 持久化消息 |
| `cf_agent_tool_approval` | 客户端→服务端 | 用户审批工具调用 |
| `routing` | 服务端→客户端 | 路由信息广播 |
| `supplement` | 服务端→客户端 | 协作者补充意见 |
| `status` | 服务端→客户端 | 处理进度状态 |
| `profile_sync_result` | 服务端→客户端 | 档案同步结果 |

### 4.4 持久化现状

- **Track A (D1)**：`saveOrchestrateHistory()` → `chat_history` 表
  - 跨 session 的审计/BI 数据源，含 metadata（routing, supplements）
  - 仅后端写入与审计用途，不再暴露 orchestrate 历史 REST 端点
- **Track B (DO SQLite)**：AIChatAgent 内置 `cf_ai_chat_agent_messages` 表 → WS `cf_agent_chat_messages` 广播
  - 多设备实时同步，断线恢复
  - `useAgentChat.ts` 已处理该广播，按 ID 去重合并

> **现状**：`ai.tsx` 为纯 WebSocket 客户端，首屏消息完全来自 WS `cf_agent_chat_messages`（DO 重连广播），不再走 REST 历史加载。D1 Track A 仅做后端审计/BI 写入与离线分析，不对移动端暴露历史查询端点。

### 4.5 单协议化结果（WS）

后端 `src/routes/ai.ts` 已删除，`/api/ai/chat` 已下线，移动端不再使用 SSE。

移动端单次任务链路：

| 任务 | 调用入口 | 传输协议 | 状态 |
|------|----------|----------|------|
| 首页训练计划生成 | `app/(tabs)/index.tsx` | WebSocket (`streamSingleRoleAgent`) | ✅ |
| 饮食分析 | `app/diet/record.tsx` | WebSocket (`streamSingleRoleAgent`) | ✅ |
| 图片识别（指标/伤病/目标） | `hooks/useImageAnalysis.ts` | WebSocket (`streamSingleRoleAgent`) | ✅ |

> **清理结论**：AI 能力已收敛为 WebSocket 单协议，SSE 回退链路已完成下线。

---

## 五、本地开发与测试计划

### 5.1 本地开发环境搭建

#### 步骤 1：启动本地 D1

```bash
cd backend

# 创建本地 D1 数据库并执行 schema
npx wrangler d1 execute lianlema-db --local --file=src/db/schema.sql
```

> 说明：`--local` 会在 `.wrangler/state/` 下创建本地 SQLite 文件，不需要真实的 D1 database_id。

#### 步骤 2：配置本地 secrets

文件 `backend/.dev.vars`（不要提交到 git）：
```
JWT_SECRET=local-dev-secret-change-in-prod
LLM_API_KEY=sk-your-actual-api-key
```

#### 步骤 3：启动开发服务器

```bash
npx wrangler dev
# 默认监听 http://localhost:8787
```

> 注意：`wrangler.toml` 中 `LLM_BASE_URL` 已配为 `https://api.izlx.de/v1`，本地开发可直接使用。

### 5.2 接口手动测试

#### 测试 1：注册
```bash
curl -X POST http://localhost:8787/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"12345678","nickname":"测试用户"}'

# 预期：返回 { success: true, data: { token: "...", user: {...} } }
```

#### 测试 2：登录
```bash
curl -X POST http://localhost:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"12345678"}'
```

#### 测试 3：验证 token
```bash
TOKEN="上面获取的token"
curl http://localhost:8787/api/auth/me \
  -H "Authorization: Bearer $TOKEN"

# 预期：返回 { success: true, data: { id, email, nickname } }
```

#### 测试 4：AI 对话 (WebSocket — 主链路)
```
使用 wscat 或前端 WebSocket 客户端连接：
wss://localhost:8787/agents/supervisor-agent/{userId}?token={jwt}&sid=default

发送消息格式：
{
  "type": "cf_agent_use_chat_request",
  "id": "req-xxx",
  "init": {
    "method": "POST",
    "body": "{\"messages\":[{\"id\":\"msg-1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"你好\"}]}]}"
  }
}
```

#### 测试 5：单次任务 WS（训练计划）
```
连接：wss://localhost:8787/agents/supervisor-agent/{userId}:utility?token={jwt}&sid=utility-test

发送：
{
  "type": "cf_agent_use_chat_request",
  "id": "req-utility",
  "init": {
    "method": "POST",
    "body": "{\"messages\":[{\"id\":\"msg-utility\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"帮我安排今天的训练计划\"}]}],\"preferred_role\":\"trainer\",\"single_role\":true,\"allow_profile_sync\":false}"
  }
}

预期：
1. 收到 `cf_agent_use_chat_response` 文本分片
2. 最终 `done=true`
3. 不出现 `tool-approval-request`
```

#### 测试 6：未认证访问
```bash
curl http://localhost:8787/api/profile
# 预期：401 { success: false, error: "未提供认证令牌" }
```

---

## 六、部署（已完成 ✅）

### 6.1 当前生产配置

```toml
# wrangler.toml（实际值）
name = "lianlema-backend"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

routes = [
  { pattern = "api-lite.izlx.de5.net", custom_domain = true }
]

[vars]
LLM_MODEL = "LLM"
LLM_FALLBACK_MODELS = "LLM1"
LLM_BASE_URL = "https://api.izlx.de/v1"
ALLOWED_ORIGINS = "http://localhost:8081"

# Bindings: D1 (DB), KV (KV), R2 (R2)
# Durable Objects: SupervisorAgent
```

### 6.2 Secrets（已配置）

```bash
wrangler secret put JWT_SECRET    # 已配置
wrangler secret put LLM_API_KEY   # 已配置
```

### 6.3 生产验证

```bash
PROD_URL="https://api-lite.izlx.de5.net"

# 1. 健康检查
curl $PROD_URL/

# 2. 注册测试
curl -X POST $PROD_URL/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpassword123"}'

# 3. WebSocket AI 对话（主链路）
# 连接 wss://api-lite.izlx.de5.net/agents/supervisor-agent/{userId}?token={jwt}&sid=default
```

### 6.4 移动端配置

```typescript
// mobile/constants/index.ts
export const API_BASE_URL = 'https://api-lite.izlx.de5.net';
```

---

## 七、生产环境注意事项

### 7.1 监控

```
Cloudflare Dashboard → Workers → lianlema-backend → Metrics

关注指标：
- 请求量 / 分钟
- 错误率（4xx / 5xx）
- CPU 时间（Workers 限制 50ms CPU time / 请求，付费版 30s）
- D1 读写次数（免费版每天 5M 读 + 100K 写）
- Durable Objects 请求数和存储使用量
```

### 7.2 Workers 限制

| 资源 | 免费版限制 | 付费版限制（$5/月） |
|------|-----------|-------------------|
| 请求数 | 100K/天 | 1000 万/月 |
| CPU 时间 | 10ms/请求 | 30s/请求 |
| D1 读取 | 5M/天 | 25B/月 |
| D1 写入 | 100K/天 | 50M/月 |
| D1 存储 | 5GB | 5GB（可扩展） |
| KV 读取 | 100K/天 | 1000 万/月 |
| KV 写入 | 1K/天 | 100 万/月 |
| R2 存储 | 10GB | 10GB（可扩展） |
| R2 操作 | A类 1M/月，B类 10M/月 | 同左 |

**重要**：AI 对话路由 CPU 时间较长（等待 LLM 响应），免费版 10ms CPU 限制可能不够。
但 Workers 的 I/O wait（等待 fetch 响应）不计入 CPU 时间，所以一般不会超限。
Durable Objects 的 WebSocket 长连接不受 Workers CPU 限制影响。

### 7.3 成本估算

```
假设 100 个活跃用户，每人每天 10 次 AI 对话：

Workers 请求：~1000/天（包含 CRUD + AI 对话）→ 免费版足够
D1 读取：每次 AI 对话 ~7 次查询 → ~7000/天 → 免费版足够
D1 写入：每次对话 2 次写入（user msg + assistant msg）→ ~2000/天 → 免费版足够
LLM 费用：取决于 LLM 中转服务定价（这是主要成本）

结论：100 用户规模免费版完全够用，主要成本在 LLM API 调用
```

### 7.4 备份策略

```bash
# 定期导出 D1 数据（手动或 CI）
npx wrangler d1 export lianlema-db --output=backup-$(date +%Y%m%d).sql

# 建议频率：每周一次，重要更新前一次
```

### 7.5 .gitignore

```
backend/node_modules/
backend/.wrangler/
backend/.dev.vars          # ← 本地 secrets，绝对不能提交！
backend/dist/
mobile/node_modules/
mobile/.expo/
```

---

## 八、文件结构汇总

```
backend/src/
├── agents/
│   ├── contracts.ts              # 广播事件类型定义
│   ├── supervisor-agent.ts       # 主 Agent DO (AIChatAgent)
│   └── sync-profile-tool.ts      # 档案同步工具 schema
├── db/
│   ├── migrations/               # D1 迁移脚本
│   └── schema.sql                # 数据库 schema
├── middleware/
│   ├── auth.ts                   # JWT 认证 + PBKDF2 密码
│   └── rateLimit.ts              # KV 滑动窗口限流
├── prompts/
│   ├── doctor.ts                 # 运动医生 system prompt
│   ├── nutritionist.ts           # 营养师 system prompt
│   ├── rehab.ts                  # 康复师 system prompt
│   └── trainer.ts                # 私人教练 system prompt
├── routes/
│   ├── auth.ts                   # 注册/登录/改密/注销
│   ├── conditions.ts             # 伤病记录 CRUD
│   ├── daily-logs.ts             # 每日日志
│   ├── diet.ts                   # 饮食记录
│   ├── health.ts                 # 理化指标 CRUD
│   ├── images.ts                 # R2 图片上传/下载
│   ├── nutrition.ts              # 营养方案 CRUD
│   ├── profile.ts                # 用户档案 CRUD
│   ├── training-goals.ts         # 训练目标 CRUD
│   └── training.ts               # 训练计划 CRUD
├── services/
│   ├── ai-provider.ts            # AI SDK 模型适配
│   ├── context.ts                # 用户上下文组装
│   ├── llm.ts                    # LLM 调用（超时 + 重试）
│   └── orchestrator.ts           # 智能路由 + 编排
├── utils/
│   └── validate.ts               # 输入校验
├── index.ts                      # Hono 入口
└── types.ts                      # 全局类型
```
## Agent治理双轨发布手册（2026-02-27）

### 配置开关

- `AGENT_FLOW_MODE=dual|governed`
- `AGENT_APPROVAL_FALLBACK=auto_approve|reject`
- `AGENT_EXECUTION_PROFILE_DEFAULT=build|plan`

### 分阶段发布

1. 阶段1（双轨并行）：`AGENT_FLOW_MODE=dual`
2. 阶段2（治理接管）：`AGENT_FLOW_MODE=governed`

### 切换门槛

- 连续7天 `npm run eval:agent` 通过率 ≥ 95%
- 写回失败率不高于基线
- 重复写回率为 0

### 回滚策略

1. 立即切回 `AGENT_FLOW_MODE=dual`
2. 保留 `agent_runtime_events` / `ai_writeback_audits` 数据用于复盘
3. 不执行破坏性数据清理

## 移动端 AI 双通道运行手册（2026-02-27）

### 运行原则

1. 默认主链路：Workers AI（后端统一编排）。
2. 移动端自定义代理：仅当客户端配置完整时启用直连。
3. 直连模式仍复用后端业务 API（query/writeback），确保数据幂等与审计不变。

### 新增接口

- `GET /api/agent/runtime-context?role=...&session_id=...`
- 返回：`system_prompt`、`context_text`、`writeback_mode`、`execution_defaults`

### 故障定位

1. 若移动端显示“已回退 Workers AI”，优先检查自定义配置完整性（base_url / worker_model / planner_model / api_key）。
2. 若自定义代理返回 401/403/5xx，客户端会停留在 custom 模式并给出明确错误，不会污染 Outbox。
3. 若出现写回异常，优先检查 `/api/writeback/commit` 与 `ai_writeback_audits`。
