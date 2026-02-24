# 练了码 - 后端实现计划与部署计划

> 最后更新：2026-02-23

---

## 一、当前状态总览

### 已完成

| 模块 | 文件 | 状态 |
|------|------|------|
| Hono 入口 | `src/index.ts` | ✅ 路由挂载，CORS 配置 |
| 类型定义 | `src/types.ts` | ✅ Bindings + Variables |
| 认证中间件 | `src/middleware/auth.ts` | ⚠️ 可用，但有安全问题 |
| 注册/登录 | `src/routes/auth.ts` | ⚠️ 可用，但密码哈希需加固 |
| 用户档案 CRUD | `src/routes/profile.ts` | ✅ GET/PUT |
| 理化指标 CRUD | `src/routes/health.ts` | ✅ GET/POST/DELETE |
| 伤病记录 CRUD | `src/routes/conditions.ts` | ✅ GET/POST/PUT/DELETE |
| 训练计划 | `src/routes/training.ts` | ✅ GET/POST/PUT(完成标记) |
| 营养方案 | `src/routes/nutrition.ts` | ✅ GET/POST + R2 图片上传 |
| AI 对话 | `src/routes/ai.ts` | ✅ SSE 流式 + 历史记录 |
| LLM 服务 | `src/services/llm.ts` | ⚠️ 可用，缺超时和重试 |
| 上下文组装 | `src/services/context.ts` | ⚠️ 可用，缺 token 控制 |
| 4 个角色 Prompt | `src/prompts/*.ts` | ✅ 中文 system prompt |
| 数据库 Schema | `src/db/schema.sql` | ⚠️ 可用，缺级联删除 |
| Wrangler 配置 | `wrangler.toml` | ❌ placeholder 未替换 |
| TypeScript 编译 | `npx tsc --noEmit` | ✅ 零错误 |
| Wrangler 打包 | `wrangler deploy --dry-run` | ✅ 134KB / 30KB gzip |

### 未完成

- ❌ 密码安全加固（加盐哈希）
- ❌ 输入校验
- ❌ 接口限流
- ❌ LLM 调用超时/重试
- ❌ 上下文 token 计数与截断
- ❌ 修改密码接口
- ❌ 数据库级联删除
- ❌ 本地开发测试
- ❌ Cloudflare 资源创建
- ❌ 部署

---

## 二、安全加固（优先级：P0）

### 2.1 密码哈希改造

**当前问题**：使用裸 SHA-256，无盐值，易被彩虹表攻破。

**改造方案**：使用 PBKDF2（Workers 原生支持 Web Crypto API）。

```
文件：src/middleware/auth.ts

改造点：
1. hashPassword(password) → 生成随机 16 字节盐 + PBKDF2-SHA256 100000 轮
2. 存储格式改为 "salt:hash"（两部分用冒号分隔）
3. verifyPassword(password, storedHash) → 拆出盐值后重新派生对比
4. 使用 crypto.subtle.timingSafeEqual() 做恒定时间比较，防时序攻击
```

**实现步骤**：
1. 修改 `hashPassword()`：
   - `const salt = crypto.getRandomValues(new Uint8Array(16))`
   - `const key = await crypto.subtle.importKey('raw', encodedPassword, 'PBKDF2', false, ['deriveBits'])`
   - `const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256)`
   - 返回 `${toHex(salt)}:${toHex(hash)}`
2. 修改 `verifyPassword()`：
   - 拆分 `storedHash.split(':')`，取出盐
   - 用相同盐重新派生，`timingSafeEqual` 比较
3. 注意：此改动与旧数据不兼容，需在首次部署前完成

**影响范围**：
- `src/middleware/auth.ts` — hashPassword / verifyPassword
- `src/routes/auth.ts` — 无需改动（调用接口不变）

### 2.2 输入校验

**当前问题**：所有路由直接 `await c.req.json()` 无校验，可注入非法数据。

**改造方案**：使用 Hono 内置的 `validator` + 手写校验（不引入额外依赖）。

```
需要校验的字段：

POST /api/auth/register
  - email: 合法邮箱格式
  - password: 最少 8 位
  - nickname: 可选，最长 50 字符

POST /api/auth/login
  - email: 非空
  - password: 非空

PUT /api/profile
  - height: 50-300 cm
  - weight: 20-500 kg
  - age: 1-150
  - gender: "male" | "female"
  - experience_level: "beginner" | "intermediate" | "advanced"
  - training_goal: 最长 200 字符

POST /api/health
  - metric_type: 枚举值校验
  - value: 非空字符串
  - recorded_at: ISO 日期格式（可选）

POST /api/conditions
  - name: 非空，最长 100 字符
  - severity: "mild" | "moderate" | "severe"（可选）

POST /api/ai/chat
  - role: "doctor" | "rehab" | "nutritionist" | "trainer"
  - message: 非空，最长 5000 字符
```

**实现步骤**：
1. 创建 `src/utils/validate.ts` — 通用校验函数（isEmail, isInRange, isEnum 等）
2. 在每个路由处理器开头添加校验逻辑
3. 校验失败返回 400 + 具体错误信息

### 2.3 接口限流

**方案**：使用 Cloudflare KV 实现简易滑动窗口限流。

```
文件：src/middleware/rateLimit.ts

策略：
- /api/auth/login：同一 IP 每分钟最多 10 次
- /api/auth/register：同一 IP 每小时最多 5 次
- /api/ai/chat：同一用户每分钟最多 20 次

实现逻辑：
1. key = `rate:{ip或userId}:{endpoint}`
2. 从 KV 读取当前计数和时间窗口
3. 超限返回 429 Too Many Requests
4. 未超限则递增计数，写回 KV（设 TTL = 窗口时间）
```

**实现步骤**：
1. 创建 `src/middleware/rateLimit.ts`
2. 在 `src/index.ts` 中对 auth 路由和 ai 路由分别应用
3. KV 的 key 用 `expirationTtl` 自动过期

### 2.4 CORS 收紧

**当前问题**：`cors()` 无参数 = 允许所有来源。

```
改造：
app.use('*', cors({
  origin: ['http://localhost:8081', 'https://your-production-domain.com'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));
```

---

## 三、功能完善（优先级：P1）

### 3.1 LLM 服务加固

**文件**：`src/services/llm.ts`

**改造内容**：

#### 3.1.1 请求超时
```
- 使用 AbortController 设置 60 秒超时
- 超时后抛出明确的超时错误
- 在 ai.ts 中 catch 超时错误，返回友好提示
```

#### 3.1.2 重试机制
```
- 仅对 5xx 和网络错误重试
- 最多重试 2 次，间隔 1s、3s（指数退避）
- 4xx 错误不重试（用户输入问题）
- 流式请求不重试（已开始发送无法回滚）
```

#### 3.1.3 流式响应错误处理改进
```
文件：src/routes/ai.ts

当前问题：后台 save 任务出错时无人知道。
改造：
1. 在 finally 块中加 try-catch，save 失败时写日志到 KV
2. 流中间如果 LLM 返回错误，发送 SSE error event
3. 客户端可监听 event: error 做提示
```

### 3.2 上下文 Token 控制

**文件**：`src/services/context.ts`

**问题**：用户数据量大时，system prompt + 历史消息可能超出 LLM 上下文窗口。

**方案**：
```
1. 新增 estimateTokens(text) 函数
   - 简易估算：中文 1 字 ≈ 2 tokens，英文 1 词 ≈ 1.3 tokens
   - 或按字符数 / 2 粗估

2. 设定 TOKEN_BUDGET（如 gpt-4o 为 128k，预留 4k 给回复）：
   - system prompt + 用户上下文：最多 8000 tokens
   - 历史消息：最多 4000 tokens
   - 当前用户消息：不限

3. 上下文超长时截断策略：
   - 优先保留最近的 health_metrics（最多 10 条）
   - training_plans 只保留最近 3 条
   - chat_history 从最早的开始删除
   - 上下文文本超长时截断尾部

4. 在 ai.ts 中组装 messages 后，调用 trimMessages() 确保总量不超限
```

### 3.3 新增接口

#### 3.3.1 修改密码
```
PUT /api/auth/password

Body: { old_password, new_password }

逻辑：
1. 验证旧密码
2. 校验新密码强度（>= 8 位）
3. 哈希新密码并更新
4. （可选）使旧 token 失效 — 在 KV 记录密码修改时间，auth 中间件检查 token 签发时间
```

#### 3.3.2 获取用户信息
```
GET /api/auth/me

返回当前登录用户的 id, email, nickname
（移动端启动时用此接口验证 token 有效性并获取用户信息）
```

### 3.4 数据库改进

**文件**：`src/db/schema.sql`

```sql
-- 添加级联删除（重新建表或通过迁移）
-- 注意：D1 不支持 ALTER TABLE 添加外键，需重建表

-- 方案：在应用层处理级联删除
-- 新增路由 DELETE /api/auth/account：
--   1. 删除 chat_history WHERE user_id = ?
--   2. 删除 nutrition_plans WHERE user_id = ?
--   3. 删除 training_plans WHERE user_id = ?
--   4. 删除 conditions WHERE user_id = ?
--   5. 删除 health_metrics WHERE user_id = ?
--   6. 删除 user_profiles WHERE user_id = ?
--   7. 删除 users WHERE id = ?
--   8. 上述操作用 D1 batch() 保证原子性
```

---

## 四、本地开发与测试计划（优先级：P0）

### 4.1 本地开发环境搭建

#### 步骤 1：启动本地 D1

```bash
cd backend

# 创建本地 D1 数据库并执行 schema
npx wrangler d1 execute lianlema-db --local --file=src/db/schema.sql
```

> 说明：`--local` 会在 `.wrangler/state/` 下创建本地 SQLite 文件，不需要真实的 D1 database_id。

#### 步骤 2：配置本地 secrets

```bash
# 创建 .dev.vars 文件（不要提交到 git）
```

文件 `backend/.dev.vars`：
```
JWT_SECRET=local-dev-secret-change-in-prod
LLM_API_KEY=sk-your-actual-api-key
```

#### 步骤 3：修改 wrangler.toml（本地开发用）

```toml
# 临时修改 LLM_BASE_URL 为你的实际中转地址
[vars]
LLM_MODEL = "gpt-4o"
LLM_BASE_URL = "https://你的实际中转地址/v1"
```

#### 步骤 4：启动开发服务器

```bash
npx wrangler dev
# 默认监听 http://localhost:8787
```

### 4.2 接口手动测试

按以下顺序逐一测试，确保链路完整：

#### 测试 1：注册
```bash
curl -X POST http://localhost:8787/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"12345678","nickname":"测试用户"}'

# 预期：返回 { success: true, data: { token: "...", user: {...} } }
# 保存返回的 token 用于后续请求
```

#### 测试 2：登录
```bash
curl -X POST http://localhost:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"12345678"}'

# 预期：返回 token
```

#### 测试 3：更新用户档案
```bash
TOKEN="上面获取的token"

curl -X PUT http://localhost:8787/api/profile \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"height":178,"weight":75,"age":28,"gender":"male","training_goal":"增肌","experience_level":"intermediate"}'

# 预期：返回更新后的 profile
```

#### 测试 4：添加理化指标
```bash
curl -X POST http://localhost:8787/api/health \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"metric_type":"testosterone","value":"550","unit":"ng/dL","recorded_at":"2024-01-15"}'

# 预期：返回创建的 metric
```

#### 测试 5：添加伤病记录
```bash
curl -X POST http://localhost:8787/api/conditions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"腰间盘突出","description":"L4-L5 轻度膨出","severity":"mild"}'

# 预期：返回创建的 condition
```

#### 测试 6：AI 对话（关键测试）
```bash
curl -X POST http://localhost:8787/api/ai/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role":"trainer","message":"帮我安排今天的训练计划"}' \
  --no-buffer

# 预期：SSE 流式返回 AI 回复
# 格式：data: {"choices":[{"delta":{"content":"..."}}]}
```

#### 测试 7：查看对话历史
```bash
curl http://localhost:8787/api/ai/history?role=trainer \
  -H "Authorization: Bearer $TOKEN"

# 预期：返回刚才的对话记录（用户消息 + AI 回复）
```

#### 测试 8：未认证访问
```bash
curl http://localhost:8787/api/profile

# 预期：401 { success: false, error: "未提供认证令牌" }
```

### 4.3 测试检查清单

```
[ ] 注册 — 正常注册
[ ] 注册 — 重复邮箱返回 409
[ ] 注册 — 空邮箱/密码返回 400
[ ] 登录 — 正常登录
[ ] 登录 — 错误密码返回 401
[ ] 登录 — 不存在的邮箱返回 401
[ ] 中间件 — 无 token 返回 401
[ ] 中间件 — 过期 token 返回 401
[ ] 中间件 — 无效 token 返回 401
[ ] Profile GET — 返回用户档案
[ ] Profile PUT — 部分更新（只传 height）
[ ] Profile PUT — 空 body 返回 400
[ ] Health GET — 返回所有指标
[ ] Health GET — 按 metric_type 筛选
[ ] Health POST — 创建指标
[ ] Health POST — 缺少必填字段返回 400
[ ] Health DELETE — 删除自己的指标
[ ] Health DELETE — 删除别人的指标返回 404
[ ] Conditions GET — 返回所有记录
[ ] Conditions GET — 按 status 筛选
[ ] Conditions POST — 创建记录
[ ] Conditions PUT — 更新 status 为 recovered
[ ] Conditions DELETE — 删除记录
[ ] Training GET — 返回训练计划列表
[ ] Training POST — 创建训练计划
[ ] Training PUT complete — 标记完成
[ ] Nutrition GET — 返回营养方案列表
[ ] Nutrition POST — 创建营养方案
[ ] Nutrition POST photo — 上传图片到 R2
[ ] AI chat — doctor 角色正常对话
[ ] AI chat — rehab 角色正常对话
[ ] AI chat — nutritionist 角色正常对话
[ ] AI chat — trainer 角色正常对话
[ ] AI chat — 无效角色返回 400
[ ] AI chat — 空消息返回 400
[ ] AI chat — 流式响应正确到达客户端
[ ] AI chat — 对话历史正确保存
[ ] AI history — 按角色返回历史
[ ] AI history DELETE — 清空历史
```

---

## 五、部署计划（优先级：P0）

### 5.0 前置条件

```
[ ] 拥有 Cloudflare 账号
[ ] 已安装 wrangler CLI 并登录：npx wrangler login
[ ] LLM 中转服务地址和密钥已准备好
[ ] 所有安全加固已完成（至少 2.1 密码哈希必须完成）
[ ] 本地测试全部通过
```

### 5.1 创建 Cloudflare 资源

按顺序执行以下命令：

#### 5.1.1 创建 D1 数据库

```bash
npx wrangler d1 create lianlema-db

# 输出示例：
# ✅ Successfully created DB 'lianlema-db'
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
#
# 记录这个 database_id！
```

#### 5.1.2 创建 KV 命名空间

```bash
npx wrangler kv namespace create "SESSIONS"

# 输出示例：
# ✅ Successfully created KV namespace "SESSIONS"
# id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
#
# 记录这个 id！
```

#### 5.1.3 创建 R2 存储桶

```bash
npx wrangler r2 bucket create lianlema-images

# 输出示例：
# ✅ Created bucket 'lianlema-images'
```

### 5.2 更新 wrangler.toml

将所有 placeholder 替换为真实值：

```toml
name = "lianlema-backend"
main = "src/index.ts"
compatibility_date = "2024-11-01"

[vars]
LLM_MODEL = "gpt-4o"                            # ← 改为你使用的模型
LLM_BASE_URL = "https://你的实际中转地址/v1"       # ← 改为真实地址

[[d1_databases]]
binding = "DB"
database_name = "lianlema-db"
database_id = "从 5.1.1 获取的 ID"                 # ← 替换

[[kv_namespaces]]
binding = "KV"
id = "从 5.1.2 获取的 ID"                          # ← 替换

[[r2_buckets]]
binding = "R2"
bucket_name = "lianlema-images"
```

### 5.3 执行远程数据库迁移

```bash
# 注意：不带 --local，操作的是远程 D1
npx wrangler d1 execute lianlema-db --file=src/db/schema.sql

# 验证表是否创建成功
npx wrangler d1 execute lianlema-db --command="SELECT name FROM sqlite_master WHERE type='table'"
```

预期输出应包含 7 个表：
```
users, user_profiles, health_metrics, conditions,
training_plans, nutrition_plans, chat_history
```

### 5.4 配置 Secrets

```bash
# JWT 密钥 — 使用强随机字符串
npx wrangler secret put JWT_SECRET
# 粘贴一个 64 位以上的随机字符串，例如：
# openssl rand -hex 32 生成

# LLM API 密钥
npx wrangler secret put LLM_API_KEY
# 粘贴你的 LLM API Key
```

### 5.5 部署

```bash
npx wrangler deploy

# 输出示例：
# ✅ Uploaded lianlema-backend
# ✅ Published lianlema-backend
#    https://lianlema-backend.你的子域名.workers.dev
#
# 记录这个 URL！
```

### 5.6 部署后验证

```bash
PROD_URL="https://lianlema-backend.你的子域名.workers.dev"

# 1. 健康检查
curl $PROD_URL/
# 预期：{ "message": "练了码 API v1" }

# 2. 注册测试
curl -X POST $PROD_URL/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"prod-test@example.com","password":"testpassword123"}'
# 预期：返回 token

# 3. AI 对话测试（使用上一步的 token）
curl -X POST $PROD_URL/api/ai/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 上一步的token" \
  -d '{"role":"trainer","message":"你好"}' \
  --no-buffer
# 预期：SSE 流式返回

# 4. 清理测试数据
# （可选）通过 D1 控制台删除测试用户
```

### 5.7 更新移动端配置

```
文件：mobile/constants/index.ts

将 API_BASE_URL 的生产地址改为 5.5 获取的 Worker URL：
  'https://lianlema-backend.你的子域名.workers.dev'
```

---

## 六、生产环境注意事项

### 6.1 监控

```
Cloudflare Dashboard → Workers → lianlema-backend → Metrics

关注指标：
- 请求量 / 分钟
- 错误率（4xx / 5xx）
- CPU 时间（Workers 限制 50ms CPU time / 请求，付费版 30s）
- D1 读写次数（免费版每天 5M 读 + 100K 写）
```

### 6.2 Workers 限制

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
流式响应的处理时间需要关注。

### 6.3 成本估算

```
假设 100 个活跃用户，每人每天 10 次 AI 对话：

Workers 请求：~1000/天（包含 CRUD + AI 对话）→ 免费版足够
D1 读取：每次 AI 对话 ~7 次查询 → ~7000/天 → 免费版足够
D1 写入：每次对话 2 次写入（user msg + assistant msg）→ ~2000/天 → 免费版足够
LLM 费用：取决于你的中转服务定价（这是主要成本）

结论：100 用户规模免费版完全够用，主要成本在 LLM API 调用
```

### 6.4 备份策略

```bash
# 定期导出 D1 数据（手动或 CI）
npx wrangler d1 export lianlema-db --output=backup-$(date +%Y%m%d).sql

# 建议频率：每周一次，重要更新前一次
```

### 6.5 .gitignore

```
# 在项目根目录创建 .gitignore
backend/node_modules/
backend/.wrangler/
backend/.dev.vars          # ← 本地 secrets，绝对不能提交！
backend/dist/
mobile/node_modules/
mobile/.expo/
```

---

## 七、实施顺序（推荐）

```
Phase 1 — 本地可用（1-2 天）
├── Step 1: 密码哈希加固（P0 安全）
├── Step 2: 创建 .dev.vars，配置 LLM 地址和密钥
├── Step 3: wrangler d1 execute --local 初始化本地数据库
├── Step 4: wrangler dev 启动本地服务
├── Step 5: 跑完第四节的手动测试清单
└── Step 6: 确认 AI 对话流式返回正常

Phase 2 — 安全与健壮性（1-2 天）
├── Step 7: 输入校验
├── Step 8: LLM 超时 + 重试
├── Step 9: 接口限流
├── Step 10: CORS 收紧
└── Step 11: 新增 /api/auth/me 和 /api/auth/password

Phase 3 — 部署（半天）
├── Step 12: 创建 Cloudflare 资源（D1 + KV + R2）
├── Step 13: 更新 wrangler.toml
├── Step 14: 配置 Secrets
├── Step 15: 远程数据库迁移
├── Step 16: wrangler deploy
└── Step 17: 生产环境验证

Phase 4 — 上下文优化（1 天）
├── Step 18: token 估算与截断逻辑
├── Step 19: 上下文数据格式优化（从 JSON dump 改为结构化中文描述）
└── Step 20: 历史消息滑动窗口
```

---

## 八、文件变更汇总

完成全部改造后，需要新增或修改的文件：

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `src/middleware/auth.ts` | PBKDF2 密码哈希 + timingSafeEqual |
| 新增 | `src/utils/validate.ts` | 输入校验工具函数 |
| 新增 | `src/middleware/rateLimit.ts` | KV 限流中间件 |
| 修改 | `src/index.ts` | 应用限流中间件 + CORS 收紧 |
| 修改 | `src/routes/auth.ts` | 新增 /me 和 /password 路由 |
| 修改 | `src/routes/profile.ts` | 添加输入校验 |
| 修改 | `src/routes/health.ts` | 添加输入校验 |
| 修改 | `src/routes/conditions.ts` | 添加输入校验 |
| 修改 | `src/routes/ai.ts` | 添加输入校验 + 超时处理 |
| 修改 | `src/services/llm.ts` | 超时 + 重试逻辑 |
| 修改 | `src/services/context.ts` | token 估算 + 截断 |
| 新增 | `.dev.vars` | 本地开发 secrets |
| 修改 | `wrangler.toml` | 替换所有 placeholder |
| 新增 | `.gitignore` | 忽略规则 |
