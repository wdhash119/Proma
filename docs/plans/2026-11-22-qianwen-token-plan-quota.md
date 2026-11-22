# Qianwen Token Plan Quota Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Proma 现有 `qianwen-token-plan` / `qianwen-token-plan-openai` 渠道的额度徽标中，显示千问个人版本月额度和团队版各席位类型的 Credits 剩余比例与重置时间，并在编辑渠道时提供 device-code 登录、重新登录和清除登录。

**Architecture:** 推理链路继续使用 `Channel.apiKey` 中的 `sk-sp` Key；新增可选 `Channel.planQuotaCredential` 只保存加密后的千问账号访问凭据，绝不进入 Pi runtime。主进程实现官方 CLI v1.12.0 同款的 device-code + PKCE、`GenerateCLIAccessToken` 派生凭证、个人版 cs-data 查询和团队版 BSS 查询；renderer 复用现有额度徽标与 60 秒缓存。

**Tech Stack:** Electron 主进程、React、TypeScript、Bun test、`safeStorage`、`writeJsonFileAtomic`、`createManagedProxyFetch`、OAuth 2.0 Device Authorization Grant + PKCE。

**参考基线:** 会话 `0eb7bbf7-3d8e-46b7-8464-6969d472e1da`；官方 `QianWen-AI/qianwen-cli` v1.12.0（commit `8da73d46da8aef2ac9639136f4b9643d20f92aa8`）；当前 Proma `main` 为 `e1f86c18`，应用版本 `0.19.131`，`@proma/shared` 版本 `0.1.93`。

**协作分工:** 父 Agent 负责计划、协调、审查和最终验证；代码修改委派 DeepSeek 官方渠道 `deepseek-flash`。实现子会话不得提交代码，父 Agent 审查通过后再决定是否提交。

**执行状态（2026-11-22）:** `deepseek-flash` 已完成 Task 1–7 和应用版本递增；父 Agent 完成三轮 diff 审查并退回修正真实 device-code、flat/cs-data envelope、表单请求、团队字段层级与缓存竞态。父 Agent 独立验证结果为 176 项测试通过、7 个 workspace typecheck 通过、`bun run electron:build` 成功。开发版启动后，用户于 2026-11-22 22:29（GMT+8）确认“登录后已能正确显示”，真实账号主链路验收通过。当前改动未 commit；个人版/团队版分别对照、同账号聚合及清除/重登等扩展边界未在用户反馈中逐项说明。

---

## 1. 用户已确认的决策

| 决策项 | 最终决策 |
| --- | --- |
| 凭据存储 | 新增可选 `Channel.planQuotaCredential`，使用与 API Key 相同的 `safeStorage` 加密和 `channels.json` 原子写；不增加 `CONFIG_VERSION` |
| 登录入口 | **仅编辑已有千问 Token Plan 渠道时显示**；新建渠道不显示登录入口，也不在创建时传额度凭据 |
| 套餐覆盖 | **首版同时覆盖个人版和团队版**；同一账号两者都存在时聚合展示 |
| 上游接口 | 接受「千问内部网关、无兼容承诺」；host/action/product/API 名集中在路由模块，错误可定位 |
| 推理凭据 | `Channel.apiKey` 始终保留 `sk-sp` Key；不得被 OAuth JSON 覆盖 |
| 个人版窗口 | monthly 已用/剩余百分比、进度、可选重置时间；不把遗留 weekly 冒充 monthly |
| 团队版窗口 | `GetSeatSubscriptionSummary` 中 Standard / Pro / Max 席位 Credits 的已用/剩余百分比、进度、可选重置时间 |
| 轮询频率 | 复用成功 60 秒、失败 15 秒的 renderer 缓存，不增加秒级轮询 |
| Token 续期 | **不实现 refresh。** 官方 CLI v1.12.0 虽读取 `RefreshToken`，但没有 refresh 流程，只持久化 `access_token + expires_at`；过期后重新登录 |

### 非目标

- 不修改 `pi-model-registry.ts`、`agent-orchestrator.ts`、`chat-service.ts`、`reasoning-profile.ts`、`pi-agent-adapter.ts`。
- 首版不展示绝对 Credits、加油包、Harness、免费 token 额度或 CNY 账户余额。
- 官方 CLI 当前团队版 `fiveHourCredits` / `weeklyCredits` 只有空占位，首版不得凭字段名虚构 5 小时或每周窗口。
- 不接入 Pi SDK OAuth provider，不引入 `@qianwenai/qianwen-cli` 运行时依赖，不要求用户安装 Node/npm 包。
- 不使用 API Key 查询额度，不把管理请求发送到渠道 `baseUrl` 或 `platform.qianwenai.com`。
- 不更新 README、tutorial 或 release notes。

## 2. 当前代码落点

- `apps/electron/src/renderer/lib/channel-plan-quota.ts` 已将两个千问 Token Plan provider 纳入白名单，成功结果缓存 60 秒、失败结果缓存 15 秒，**无需修改**。
- `apps/electron/src/main/lib/channel-manager.ts` 的 `getChannelPlanQuota()` 尚无千问分支，最终落入“未提供可用接口”。
- `apps/electron/src/renderer/components/chat/ChannelPlanQuotaButton.tsx` 与 `renderer/lib/channel-plan-quota-display.ts` 已能展示 `custom` 窗口、百分比和重置时间。
- `ChannelForm.tsx` 的 Codex/Copilot/xAI 登录流程可参考 device-code 事件、取消和立即保存，但千问必须保留独立 API Key 区域和“测试连接”按钮。

## 3. 上游契约与映射

### 3.1 登录

```text
POST https://t.qianwenai.com/cli/device/code
  ?client_id=<本机 UUID>&code_challenge=<S256>&code_challenge_method=S256
User-Agent: qianwen-cli/1.12.0

POST https://t.qianwenai.com/cli/device/token
  ?client_id=<同一 UUID>&token=<Token>&code_verifier=<verifier>
User-Agent: qianwen-cli/1.12.0
```

- `client_id` 是 Proma 生成并持久化的随机 UUID，不需要注册应用或 `client_secret`。
- device code 默认 `ExpiresIn=300`、`Interval=2`；收到 `slow_down` 后间隔增加 5 秒，并用于后续全部轮询。
- 成功响应取 `Data.Credentials.AccessToken` 与 `ExpireTime`。`ExpireTime` 是带时区的 ISO 8601 时间，转换为毫秒时间戳；不能按本地无时区日期解析。
- `User.AliyunId` 仅作为可选账号摘要；日志和错误不得包含 access token、device token、PKCE verifier 或完整授权 URL。

### 3.2 个人版

```text
POST https://cli.qianwenai.com/data/v2/api.json
Authorization: Bearer <AccessToken>
Content-Type: application/json

{"product":"ModelStudioRegional","action":"GenerateCLIAccessToken",
 "version":"2026-02-10","region":"cn-beijing","params":{}}
```

`cliAccessToken` 必须是非空字符串且不同于 access token。cs-data 固定绑定 issuer `https://cli.qianwenai.com/data/v2/api.json`、region `cn-beijing`、site `qianwenai`。

P0 个人版只调用：

- `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription`，`Data.commodityCode` 只能为 `sfm_tokenplansolo_public_cn`；
- `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`，不得附加业务参数。

cs-data HTTP 200 不代表业务成功。必须依次校验：外层 `code === '200' && successResponse === true`；`data.success === true` 并识别 `BailianGateway.Login.NotLogined`；`data.DataV2.ret[0]` 以 `SUCCESS::` 开头；business envelope `code === 'SUCCESS' && success === true`；最后读取 business `data`。

### 3.3 团队版

```text
POST https://cli.qianwenai.com/data/v2/api.json
Authorization: Bearer <AccessToken>
Content-Type: application/json

{"product":"BssOpenAPI-V3","action":"GetSeatSubscriptionSummary",
 "region":"cn-beijing","params":{"productCode":"sfm_tokenplanteams_dp_cn"}}
```

- 团队版直接使用 access token，不使用 `cliAccessToken`。
- 原始响应可以是顶层数据或 `Data` 包裹；若存在 `Success`，必须为 `true`，若存在 `Code`，必须为 `Success`；`ProductCode` 若存在必须匹配团队版产品码。
- `SubscriptionGroupList[]` 中只处理 `SpecType` 为 `standard` / `pro` / `max` 的组。
- Credits 必须来自 `EquityList` 中**唯一** `EquityType === 'CREDITS'` 的权益；缺权益、多个 Credits 权益或显式 unit 不是 Credits 时，该组不可展示。
- 从该权益读取十进制字符串 `TotalValue` / `SurplusValue`。P0 只在两者均可安全转换成有限 number、`total > 0`、`0 <= remaining <= total` 时计算百分比；不用浮点结果反写绝对 Credits。
- `NextCycleFlushTime` 仅在能解析为有效时间时作为 `resetAt`；不将订阅 `EndTime` 当重置时间。
- 同一 `SpecType` 出现多个组时，不直接用浮点相加。首版可分别展示为“团队 Max 1 / 团队 Max 2”，或在无法可靠区分时跳过冲突组并返回部分数据提示；不得合并出不准确的总额。

### 3.4 映射到现有额度契约

| 上游 | Proma |
| --- | --- |
| 有效个人订阅 `status === 'VALID'` 且 `startTime <= now < endTime` | `planName` 的个人版部分为 Lite/Essential/Standard/Pro；未知档位只显示“个人版” |
| `per1MonthPercentage`（0..1，已用比例） | `usedPercent = ratio * 100`，`remainingPercent = 100 - usedPercent`，保留两位小数 |
| `per1MonthResetTime` | `resetAt`；缺失时仍显示百分比 |
| 个人 monthly | `{ type:'custom', label:'个人版本月', showProgress:true }` |
| 团队组 `remaining / total` | `remainingPercent`、`usedPercent`，保留两位小数 |
| 团队席位 | `{ type:'custom', label:'团队 Standard/Pro/Max', showProgress:true }`；重复组加序号 |
| 两种版本同时存在 | `planName:'千问 Token Plan（个人版 + 团队版）'`，windows 同时包含个人和团队 |
| 只有一种版本 | 使用对应个人或团队 planName，不为另一版本生成空窗口 |
| 一个版本失败、另一个成功 | 返回成功 windows，同时设置脱敏 `message:'部分千问额度暂不可用'`；display 在 tooltip 附加该提示 |
| 只有个人 weekly | 不生成 monthly 窗口 |
| 两者都无有效额度 | `supported:false`，返回未订阅或可操作的查询失败原因 |

## 4. 实施任务

### Task 1: 共享凭据、Channel 与 IPC 契约

**Files:**

- Modify: `packages/shared/src/types/channel.ts`
- Create: `packages/shared/src/types/channel.qianwen-oauth.test.ts`
- Modify: `packages/shared/package.json`

**Step 1: 先写失败测试**

覆盖：

- 完整凭据序列化/解析往返，只保留 access/expires/accountId，不序列化 refresh；
- 空值、非法 JSON、缺 access、expires 为 0/负数/NaN 时返回 null；
- 60 秒过期 skew；
- `qianwen-token-plan` 与 `qianwen-token-plan-openai` 为 true，`qianwen` / `qianwen-anthropic` 为 false。

Run: `bun test packages/shared/src/types/channel.qianwen-oauth.test.ts`

Expected: FAIL，相关导出尚不存在。

**Step 2: 实现共享契约**

```ts
export interface QianwenPlanQuotaCredentials {
  access: string
  /** access token 到期时间，Unix 毫秒。 */
  expires: number
  accountId?: string
}

export function isQianwenTokenPlanProvider(provider: ProviderType): boolean {
  return provider === 'qianwen-token-plan' || provider === 'qianwen-token-plan-openai'
}

export function isQianwenPlanQuotaCredentialExpired(
  credentials: QianwenPlanQuotaCredentials,
  skewMs = 60_000,
): boolean {
  return Date.now() >= credentials.expires - skewMs
}
```

同时实现严格 `serializeQianwenPlanQuotaCredentials` / `parseQianwenPlanQuotaCredentials`，不使用 `any`。

Channel 只增加：

```ts
export interface Channel {
  // ...既有字段
  /** 加密后的额度查询凭据；只用于千问 Token Plan，不参与推理。 */
  planQuotaCredential?: string
}

export interface ChannelUpdateInput {
  // ...既有字段
  /** 明文额度查询凭据；undefined 保留，null 清除。 */
  planQuotaCredential?: string | null
}
```

**不要修改 `ChannelCreateInput`**，因为只有编辑渠道才能登录。

新增 IPC 常量和类型：

```ts
QIANWEN_OAUTH_LOGIN: 'channel:qianwen-oauth-login',
QIANWEN_OAUTH_CANCEL: 'channel:qianwen-oauth-cancel',
QIANWEN_OAUTH_DEVICE_CODE: 'channel:qianwen-oauth-device-code',

export interface QianwenOAuthDeviceCode {
  verificationUri: string
  qrCodeData?: string
}

export interface QianwenOAuthLoginResult {
  success: boolean
  credentials?: string
  accountId?: string
  message?: string
}
```

**Step 3: 测试、版本和提交准备**

将 `@proma/shared` 从 `0.1.93` patch +1 至 `0.1.94`；若执行时版本已前进，只在最新 patch 上 +1。

```bash
bun test packages/shared/src/types/channel.qianwen-oauth.test.ts \
  packages/shared/src/types/channel.qianwen.test.ts \
  packages/shared/src/types/channel.codex.test.ts
```

Expected: 全部 PASS。本子任务不提交，等待父 Agent 整体审查。

### Task 2: 集中内部路由并实现 device-code + PKCE 登录

**Files:**

- Create: `apps/electron/src/main/lib/qianwen-api-routes.ts`
- Create: `apps/electron/src/main/lib/qianwen-oauth-service.ts`
- Create: `apps/electron/src/main/lib/qianwen-oauth-service.test.ts`

**Step 1: 写 OAuth 正常路径与异常测试**

通过依赖注入 transport、sleeper、浏览器打开函数和时钟，禁止真实网络。至少覆盖：

- S256 challenge、同一 client_id、原始 verifier、`qianwen-cli/1.12.0` UA；
- pending 后成功、slow_down 后 2 秒变 7 秒、access_denied、expired_token、deadline、非法 ExpireTime；
- 取消不再 poll，新登录 abort 旧登录；
- 只打开 `https://account.qianwenai.com/...`；
- 成功和失败后 transport 都 close；
- 错误和日志不包含 token、verifier、完整授权 URL 或代理地址。

**Step 2: 新建唯一路由表**

`qianwen-api-routes.ts` 至少导出：

```ts
export const QIANWEN_AUTH_ORIGIN = 'https://t.qianwenai.com'
export const QIANWEN_CLI_API_URL = 'https://cli.qianwenai.com/data/v2/api.json'
export const QIANWEN_CS_DATA_URL = 'https://cs-data.qianwenai.com/cli/api.json'
export const QIANWEN_VERIFICATION_HOST = 'account.qianwenai.com'
export const QIANWEN_CLI_USER_AGENT = 'qianwen-cli/1.12.0'
export const QIANWEN_REGION = 'cn-beijing'
export const QIANWEN_SITE = 'qianwenai'
export const QIANWEN_SOLO_COMMODITY_CODE = 'sfm_tokenplansolo_public_cn'
export const QIANWEN_TEAM_COMMODITY_CODE = 'sfm_tokenplanteams_dp_cn'
export const QIANWEN_SOLO_SUBSCRIPTION_API =
  'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription'
export const QIANWEN_SOLO_USAGE_API =
  'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'
```

不得从渠道 `baseUrl`、上游响应或 renderer 输入拼装 host。

**Step 3: 实现登录**

公开接口：

```ts
export interface QianwenLoginOptions {
  onDeviceCode?: (deviceCode: QianwenOAuthDeviceCode) => void
}

export interface QianwenOAuthDependencies {
  createTransport?: typeof createManagedProxyFetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  openExternal?: (url: string) => Promise<void>
  now?: () => number
}

export async function loginQianwenOAuth(
  options?: QianwenLoginOptions,
  dependencies: QianwenOAuthDependencies = {},
): Promise<QianwenPlanQuotaCredentials>

export function cancelQianwenOAuthLogin(): void
```

- verifier 为 `randomBytes(32).toString('base64url')`，challenge 为 SHA-256 base64url。
- client ID 存 `getConfigDir()/qianwen-device.json`，只有 `{"clientId":"<uuid>"}`；格式非法时重建，使用 `writeJsonFileAtomic`。
- `getEffectiveProxyUrl()` 每次登录解析一次；managed transport 在 finally close。
- 请求 `redirect:'error'`，单次 30 秒超时，整体受 ExpiresIn 与 AbortController 控制；sleep 可取消。
- device code 先推 renderer，再打开经验证 URL；模块级 activeLoginAbort 单飞。
- 即使响应含 RefreshToken，也不得声称或实现 refresh。

Run:

```bash
bun test apps/electron/src/main/lib/qianwen-oauth-service.test.ts \
  apps/electron/src/main/lib/oauth-proxy-scope.test.ts
```

Expected: PASS。

### Task 3: 实现个人版 + 团队版额度解析与查询

**Files:**

- Create: `apps/electron/src/main/lib/qianwen-plan-quota.ts`
- Create: `apps/electron/src/main/lib/qianwen-plan-quota.test.ts`
- Reference: `apps/electron/src/main/lib/github-copilot-plan-quota.ts`

**Step 1: 先写个人版 parser BDD**

- 有效 Pro + monthly=0.16 → 个人版本月剩余 84%，resetAt 正确；
- usedRatio 0/1；0.1234 → 12.34/87.66；
- 只有 weekly、ratio 越界/字符串/NaN、缺 monthly 均不生成个人窗口；
- reset 缺失可展示，非法不猜测；
- 无订阅、非 VALID、now 不在有效期不生成个人窗口；
- 两个千问 provider 在最终结果中原样保留。

**Step 2: 先写团队版 parser BDD**

- Standard/Pro/Max 单组正常映射，百分比与 resetAt 正确；
- 原始数据在顶层和 `Data` 包裹两种形态均可解析；
- 空组列表表示无团队额度；
- 非 Credits 单位、0 或多个 Credits 权益、Total/Surplus 非法、total=0、remaining>total 时跳过该组；
- 未知 SpecType 不生成任意上游标签；
- 同 SpecType 重复组按序号展示或明确跳过冲突，不能静默浮点求和；
- 部分组非法时保留合法组并返回部分数据提示。

**Step 3: 实现 parser 与 envelope guard**

建议导出：

```ts
export function parseQianwenPersonalQuota(input: {
  subscription: unknown
  usage: unknown
  now?: number
}): { planName?: string; windows: ChannelPlanQuotaWindow[]; message?: string }

export function parseQianwenTeamQuota(value: unknown): {
  windows: ChannelPlanQuotaWindow[]
  message?: string
}
```

最终 `ChannelPlanQuotaResult` 由查询函数聚合。所有输入以 `unknown` guard，不使用 `any`，不把任意上游字符串直接作为 planName/label。

**Step 4: 实现 transport 查询与缓存**

```ts
export async function queryQianwenPlanQuota(
  channelId: string,
  provider: 'qianwen-token-plan' | 'qianwen-token-plan-openai',
  credentials: QianwenPlanQuotaCredentials,
  proxyUrl?: string,
  createTransport: typeof createManagedProxyFetch = createManagedProxyFetch,
): Promise<ChannelPlanQuotaResult>
```

- access token 过期时 fetch 次数为 0，直接提示重新登录。
- 个人版派生凭证按 channelId 缓存 `{accessToken,cliAccessToken}` 并 Promise 单飞；access 变化立即弃用旧值。
- 缓存派生凭证遇 `NotLogined` 可重签并重试一次；新凭证仍失败则停止。
- 团队版与个人版独立查询，团队版不依赖派生凭证；一个版本失败不能抹掉另一个版本的成功 windows。
- 两版本均失败时，认证错误优先映射为重新登录；429 为稍后重试；其他错误使用固定脱敏文案。
- 每个查询周期创建 managed transport，finally 取消未消费 body 并 close；15 秒超时、redirect error。
- 派生凭证只驻留内存，不写配置和日志。

**Step 5: transport mock 验证请求链**

覆盖 Generate → personal subscription/usage、team direct access、个人+团队聚合、个人无订阅但团队成功、个人失败但团队成功、团队失败但个人成功、两者失败、派生缓存失效重签一次、access 过期零请求、429/超时/非法 JSON/envelope、所有错误不泄露 secret。

Run: `bun test apps/electron/src/main/lib/qianwen-plan-quota.test.ts`

Expected: PASS。

### Task 4: 将凭据生命周期接入 ChannelManager

**Files:**

- Modify: `apps/electron/src/main/lib/channel-manager.ts`
- Create: `apps/electron/src/main/lib/channel-qianwen-plan-quota.test.ts`
- Reference: `apps/electron/src/main/lib/channel-runtime-api-key.test.ts`

**Step 1: 用临时 HOME 写测试**

- 千问渠道更新额度凭据后，`resolveChannelRuntimeApiKey()` 仍返回原 `sk-sp` Key；
- `planQuotaCredential:null` 清除登录但保留 API Key；
- provider 改成非千问时自动移除额度凭据；
- 非千问渠道不能写入非空额度凭据；
- 未登录和 access token 过期返回明确原因且不访问网络；
- 旧版没有该字段的 `channels.json` 可读，`CONFIG_VERSION` 不增加。

**Step 2: 实现 update 语义**

```ts
const nextProvider = input.provider ?? existing.provider
const planQuotaCredential = input.planQuotaCredential === null || !isQianwenTokenPlanProvider(nextProvider)
  ? undefined
  : input.planQuotaCredential !== undefined
    ? encryptApiKey(input.planQuotaCredential)
    : existing.planQuotaCredential
```

非千问 provider 显式传非空凭据要抛固定错误。`undefined` 保留、`null` 清除，全表单 auto-save 不得意外清登录。继续 `writeJsonFileAtomic`。创建渠道不接收额度凭据。

**Step 3: 接入 getChannelPlanQuota**

在解密 API Key 之前处理千问：

1. 无凭据返回“请先在编辑渠道中登录千问账号”；
2. 只在主进程解密并 parse；
3. 获取一次 proxy，调用 `queryQianwenPlanQuota(channel.id, provider, credentials, proxyUrl)`；
4. 其他 provider 原逻辑不变。

不得修改 `resolveChannelRuntimeApiKey()` 的默认分支。

Run:

```bash
bun test apps/electron/src/main/lib/channel-qianwen-plan-quota.test.ts \
  apps/electron/src/main/lib/channel-runtime-api-key.test.ts \
  apps/electron/src/main/lib/qianwen-plan-quota.test.ts
```

Expected: PASS。

### Task 5: 贯通 OAuth IPC 与 preload

**Files:**

- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

将 `withOAuthDeviceCodeQr` 泛型改为结构约束 `{verificationUri:string;qrCodeData?:string}`。新增 LOGIN/CANCEL handler，device-code 只发发起方且检查 sender 是否销毁；成功序列化凭据，失败仅返回脱敏消息。

preload 增加：

```ts
qianwenOAuthLogin: () => Promise<import('@proma/shared').QianwenOAuthLoginResult>
qianwenOAuthCancel: () => Promise<void>
onQianwenOAuthDeviceCode: (
  callback: (deviceCode: import('@proma/shared').QianwenOAuthDeviceCode) => void,
) => () => void
```

事件返回 removeListener unsubscribe。

Run: `bun run typecheck`

Expected: PASS。

### Task 6: 仅在编辑渠道时增加独立额度登录

**Files:**

- Modify: `apps/electron/src/renderer/components/settings/ChannelForm.tsx`

**Step 1: 状态与事件**

增加 loggingIn/ref、deviceCode、`qianwenCredential:string|null|undefined`，订阅 device-code，卸载时 cancel。

**Step 2: 严格只在编辑模式展示**

```ts
const showQianwenQuotaLogin = isEdit && isQianwenTokenPlanProvider(provider)
```

- 新建模式不渲染登录 UI，不调用登录 IPC，不在 `doCreate` 中附加凭据，不修改创建 dirty 逻辑。
- 编辑模式在 API Key 区域之后显示“订阅额度（可选）”，不影响 `hasRequiredSecret`。
- 不把千问加入 `isSubscriptionProvider`，保留 `sk-sp` 的测试连接。

**Step 3: 登录、取消和清除**

- 登录成功编辑模式立即 update；只传当前 `provider`、`baseUrl` 与 `planQuotaCredential`，不传 `apiKey`，避免覆盖推理 Key。传 provider/baseUrl 是为了处理刚切换千问类型但 auto-save 尚未落库的情况。
- 清除登录立即传 `planQuotaCredential:null`，保留 API Key。
- 取消只 abort，不清已保存凭据。
- 新建模式即使通过其他路径收到 device-code 事件，也不得自动创建渠道。
- 已保存的加密态只用于 Boolean 登录状态，不新增解密额度凭据到 renderer 的 IPC。
- 文案明确“该登录只用于读取订阅额度，模型调用仍使用上方 API Key”。

Run: `bun run typecheck`

Expected: PASS。

### Task 7: 锁定个人/团队/部分成功显示与缓存行为

**Files:**

- Modify: `apps/electron/src/renderer/lib/channel-plan-quota-display.ts`
- Modify: `apps/electron/src/renderer/lib/channel-plan-quota-display.test.ts`
- Review only: `apps/electron/src/renderer/lib/channel-plan-quota.ts`
- Review only: `apps/electron/src/renderer/lib/channel-plan-quota.test.ts`

测试固定 now，覆盖：

- 个人版“个人版本月 84% · 重置时长”；
- 团队 Standard/Pro/Max 多窗口及重复组序号；
- 个人+团队 planName 与 tooltip 全量明细；
- 部分成功时显示成功 windows，并在 title 附加 `quota.message`；
- 无 resetAt 不虚构时间；未登录/过期显示主进程原因；
- DeepSeek `¥78.82`、Kimi、Codex 既有断言不变。

`channel-plan-quota-display.ts` 只需做最小改动：成功结果存在 `message` 时在 title 末尾追加，不改变 summary 和既有无 message 行为。

Run:

```bash
bun test apps/electron/src/renderer/lib/channel-plan-quota-display.test.ts \
  apps/electron/src/renderer/lib/channel-plan-quota.test.ts \
  apps/electron/src/renderer/components/channel-plan-quota-toolbar.test.ts
```

Expected: PASS。确认 renderer 查询层已有两个 provider，TTL 不变，登录/清除通过 updatedAt 失效旧缓存。

### Task 8: 版本、全量验证、真实账号验收与提交

**Files:**

- Modify: `apps/electron/package.json`
- Review: `docs/plans/2026-11-22-qianwen-token-plan-quota.md`

**Step 1: 最小相关测试与静态检查**

```bash
bun test packages/shared/src/types/channel.qianwen-oauth.test.ts \
  packages/shared/src/types/channel.qianwen.test.ts \
  apps/electron/src/main/lib/qianwen-oauth-service.test.ts \
  apps/electron/src/main/lib/qianwen-plan-quota.test.ts \
  apps/electron/src/main/lib/channel-qianwen-plan-quota.test.ts \
  apps/electron/src/main/lib/channel-runtime-api-key.test.ts \
  apps/electron/src/main/lib/oauth-proxy-scope.test.ts \
  apps/electron/src/renderer/lib/channel-plan-quota-display.test.ts \
  apps/electron/src/renderer/lib/channel-plan-quota.test.ts \
  apps/electron/src/renderer/components/channel-plan-quota-toolbar.test.ts
bun run typecheck
git diff --check
```

Expected: 全 PASS，typecheck 通过，diff check 无输出。

**Step 2: 构建**

将 `apps/electron/package.json` 从 `0.19.131` patch +1 至 `0.19.132`；若版本已前进则基于最新 patch +1。

```bash
bun run electron:build
```

Expected: 成功。

**Step 3: 真实 Electron 验收**

由父 Agent 按 `cua-driver-cli` 验收，用户在浏览器亲自授权，Agent 不读取或导出 token。

- 新建渠道阶段没有千问额度登录入口，API Key、模型和测试连接行为不变；
- 编辑已有个人版账号渠道，登录后显示个人版本月百分比/reset，与官方 CLI status 一致；
- 编辑团队版账号渠道，显示 Standard/Pro/Max 实际存在的窗口，与官方 CLI `seatSummaries` 一致；
- 若账号同时有两版本，windows 同时存在；部分接口失败不抹掉成功窗口，并显示部分不可用提示；
- Anthropic / OpenAI 兼容两个 provider 都能显示；
- 清除/重新登录立即保存，API Key 和模型调用不变，旧账号缓存失效；
- 取消、关闭表单、连续登录无孤立轮询；
- 过期、NotLogined、断网/代理、429、结构变化均有脱敏文案；
- 深浅主题、键盘、loading/disabled、长 tooltip 正常；日志与 IPC 不泄露凭据。

**Step 4: 父 Agent 审查后提交**

实现子会话不得 commit。父 Agent 检查 `git status --short`、`git diff --stat`、完整 diff，确认只有计划内文件后，分两个提交：

```bash
git add packages/shared/src/types/channel.ts \
  packages/shared/src/types/channel.qianwen-oauth.test.ts \
  packages/shared/package.json
git commit -m "feat(shared): add Qianwen plan quota credential contract

Made-with: Proma"

git add apps/electron/package.json \
  apps/electron/src/main/ipc.ts \
  apps/electron/src/main/lib/channel-manager.ts \
  apps/electron/src/main/lib/qianwen-api-routes.ts \
  apps/electron/src/main/lib/qianwen-oauth-service.ts \
  apps/electron/src/main/lib/qianwen-oauth-service.test.ts \
  apps/electron/src/main/lib/qianwen-plan-quota.ts \
  apps/electron/src/main/lib/qianwen-plan-quota.test.ts \
  apps/electron/src/main/lib/channel-qianwen-plan-quota.test.ts \
  apps/electron/src/preload/index.ts \
  apps/electron/src/renderer/components/settings/ChannelForm.tsx \
  apps/electron/src/renderer/lib/channel-plan-quota-display.ts \
  apps/electron/src/renderer/lib/channel-plan-quota-display.test.ts \
  docs/plans/2026-11-22-qianwen-token-plan-quota.md
git commit -m "feat(electron): show Qianwen Token Plan quota

Made-with: Proma"
```

## 5. 验收标准

- [ ] 两个千问 Token Plan provider 均能显示个人版本月额度和团队版实际席位额度。
- [ ] 同一账号两版本可聚合，部分成功不抹掉可用数据。
- [ ] 仅编辑模式有登录入口，新建流程零变化。
- [ ] `sk-sp` 推理 Key 始终不变，Pi runtime 文件零改动。
- [ ] `planQuotaCredential` 加密且原子写；旧配置无迁移、无 CONFIG_VERSION 升级。
- [ ] access token 过期不虚构 refresh；用户得到重新登录提示。
- [ ] 派生凭证缓存失效最多重签一次；请求有超时、代理和取消语义。
- [ ] monthly/weekly 不混淆，团队席位 Credits 与订阅到期/重置时间不混淆。
- [ ] 正常、边界、异常、部分成功、CRUD 隔离和 renderer 展示均有 BDD 测试。
- [ ] `bun run typecheck`、相关 `bun test`、`bun run electron:build` 通过。
- [ ] 真实 Electron + 用户授权验收通过，日志和错误不泄露凭据。

## 6. 回滚策略

1. 回滚桌面端提交恢复旧查询行为，不影响推理；旧版会再次显示“未提供可用接口”。
2. 回滚共享契约前先回滚所有引用方。旧版读到额外 `planQuotaCredential` 不应删除整个 `channels.json`。
3. 清理功能数据只针对千问渠道写 `planQuotaCredential:null` 并删除 `qianwen-device.json`；不得清空 `apiKey`，删除用户文件前单独确认。
4. 上游结构突变时只让额度分支返回固定可定位错误，保持失败缓存 15 秒，禁止自动切换到未经验证的 host 或 API Key 查询。

## 7. 后续阶段

- **P1：**个人版 `quota-config` 和团队版精确十进制总量/余量，以可靠文案展示绝对 Credits；订阅到期日进 planName。
- **P2：**加油包、Harness、免费额度和 CNY 账户余额作为独立窗口，不与 Token Plan Credits 相加。
- **团队 5h/weekly：**只有取得真实上游字段和官方 CLI 实现证据后再做，不能从空占位字段推断。
- **续期：**官方出现可验证 refresh 契约后再实现并发刷新锁和条件回写。
- **兜底：**内部网关频繁变化时，可评估读取用户已安装官方 CLI 的 `--format json`，不作为隐式依赖。
