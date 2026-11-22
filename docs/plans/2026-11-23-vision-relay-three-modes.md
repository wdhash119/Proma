# 视觉助手三挡位改造 Implementation Plan

> **For implementation Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** 为 Agent 视觉助手提供“禁止 / 自动 / 强制”三挡位；自动档按当前模型图片输入能力注入视觉助手，强制档接管所有模型的 `Read` 图片结果。

**Architecture:** 用无副作用 policy 模块统一设置归一化与运行策略。自动档继续在 Proma 自定义工具层注入 `VisionRelay`；强制档额外包装 Pi 的 `Read` 定义，在图片结果进入 transcript 前替换为视觉模型文本 JSON。旧 `enabled` 设置只在读取/写入边界迁移，不扩散到运行逻辑。

**Tech Stack:** Bun、TypeScript、Electron 主进程、Pi Agent SDK、React、既有 Settings primitives、bun:test。

---

## 已确认边界

- 模式值使用 `'off' | 'auto' | 'force'`，UI 文案依次为“禁止 / 自动 / 强制”。
- 旧配置 `enabled: true` → `auto`；`enabled: false`、字段缺失 → `off`。有效 `mode` 优先于遗留 `enabled`；读取后不再回写 `enabled`。
- `auto`：`supported` 不注入；`unsupported` 与 `unknown` 注入。`unknown` 表示“未确认有视觉能力”，保守提供兜底。
- `force`：不依赖当前模型能力，注入 `VisionRelay`，同时包装 `Read`；图片结果必须替换为文本 JSON，不得把 image content 交给当前模型。
- `off`：不注入、不接管、不发视觉请求，保持功能不存在时的原行为。
- `auto` / `force` 都必须同时配置 `channelId` 与 `modelId` 才生效；`off` 下保留已选模型，便于再次开启。
- 保持现状：`automation` / `delegation` 不注入、不强制接管；视觉源仍排除无本地 adapter 的订阅渠道。
- 本次只接管 `Read` 图片结果，不扩张到 Browser 截图、用户消息 image content 或 Chat。
- 不修改 README、tutorial、release notes；不提交 commit。

## Task 1: 设置模型、迁移与纯策略

**Files:**
- Create: `apps/electron/src/main/lib/vision-relay-policy.ts`
- Create: `apps/electron/src/main/lib/vision-relay-policy.test.ts`
- Modify: `apps/electron/src/types/settings.ts`
- Modify: `apps/electron/src/main/lib/settings-service.ts`

实现以下公开契约（代码可补充必要类型与 JSDoc，但不要引入 `any`）：

```ts
export type VisionRelayMode = 'off' | 'auto' | 'force'

export interface VisionRelaySettings {
  mode: VisionRelayMode
  channelId?: string
  modelId?: string
}

export function normalizeVisionRelaySettings(input: unknown): VisionRelaySettings
export function isVisionRelayRouteConfigured(settings: VisionRelaySettings | undefined): boolean
export function shouldInjectVisionRelayTool(input: {
  settings: VisionRelaySettings | undefined
  imageInput: 'supported' | 'unsupported' | 'unknown'
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
}): boolean
export function shouldForceVisionRelayRead(input: {
  settings: VisionRelaySettings | undefined
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
}): boolean
```

`normalizeVisionRelaySettings` 必须只接受有效字符串 ID，去掉空字符串；有效 `mode` 原样返回，否则按旧 `enabled === true` 迁移为 `auto`，其余情况为 `off`。

`settings-service.ts` 的三处默认值都改为 `{ mode: 'off' }`。`getSettings()` 与 `updateSettings()` 都必须经过 `normalizeVisionRelaySettings`，更新时合并当前路由与本次部分更新，确保非法模式不能被 IPC 写入。

BDD 测试至少覆盖：
1. 旧 enabled true/false、无字段、有效 mode 优先、非法 mode/ID。
2. off 永远不注入且不强制。
3. auto 在 supported 时关闭，在 unsupported/unknown 时开启。
4. force 在 supported/unsupported/unknown 都注入且强制接管。
5. auto/force 缺 channelId 或 modelId 均不生效。
6. automation/delegation 均不生效，user/external 保持可用。

运行：`bun test apps/electron/src/main/lib/vision-relay-policy.test.ts`，预期全部通过。

## Task 2: 自动档改为通用能力判定

**Files:**
- Modify: `apps/electron/src/main/lib/vision-relay-service.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Test: `apps/electron/src/main/lib/adapters/pi-model-capability-overrides.test.ts`

具体改动：
1. 删除 `isVisionRelayEligibleForModel()` 及 DeepSeek ID 白名单。
2. `isVisionRelayConfigured()` 改为复用 `isVisionRelayRouteConfigured`，因此 off 或缺模型都返回 false。
3. `inspectImageWithVisionRelay()` 必须再次校验 mode 非 off 且路由完整，防止绕过工具注入直接调用。
4. `PiBuiltinToolsContext` 增加 `provider: ProviderType` 与 `modelCapabilities?: ModelCapabilityOverrides`。
5. `buildVisionRelayTools()` 改为 async：off 直接返回；auto 调用 `resolvePiImageInputCapability()`；force 不依赖当前能力；最终经 `shouldInjectVisionRelayTool()` 决定。
6. `buildPiBuiltinTools()` 调用处增加 `await`，工具 description 去掉 DeepSeek 限定；force 下说明普通 `Read` 图片调用也会被自动中转，直接调用 `VisionRelay` 用于更聚焦的问题。
7. 将 `selectedChannelModel` 查询上移到 `buildPiBuiltinTools()` 之前，传入 `channel.provider` 与 `selectedChannelModel?.capabilities`，后续 reasoning 解析复用同一结果，不重复查询。

运行：
`bun test apps/electron/src/main/lib/vision-relay-policy.test.ts apps/electron/src/main/lib/adapters/pi-model-capability-overrides.test.ts`

预期：现有能力覆盖测试不回归，新策略测试通过。

## Task 3: 强制档包装 Read 图片结果

**Files:**
- Create: `apps/electron/src/main/lib/adapters/pi-vision-relay-read.ts`
- Create: `apps/electron/src/main/lib/adapters/pi-vision-relay-read.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/vision-relay-service.ts`（仅导出必要输入/结果类型）

新模块提供：

```ts
export function createVisionRelayReadToolDefinition(
  sdk: PiSdk,
  cwd: string,
  options: {
    allowedRoots: string[]
    inspectImage: (input: InspectImageInput) => Promise<VisionRelayResult>
  },
): ToolDefinition
```

实现要求：
1. 内部调用 `sdk.createReadToolDefinition(cwd)`，保留名称、schema、权限与渲染行为。
2. 非图片结果原样返回，不调用视觉模型。
3. 图片结果使用 `resolvePathAgainstAgentCwd(params.path, ctx.cwd ?? cwd)` 解析绝对路径（与 Pi Read 一致，支持 `~` 展开），再调用 `inspectImage`；不得使用返回的 base64 重新构造第二条不受控链路。
4. 用既有 `serializePiToolResultPayload()` 生成纯文本 JSON content/details；成功与失败都不得保留原 image block，失败设置 `isError: true`。
5. description 补充强制模式语义，避免仍宣称图片一定作为附件交给当前模型。

`PiAgentQueryOptions` 增加可选 `visionRelayRead?: { allowedRoots: string[] }`；只有该字段存在时，`buildBuiltinToolDefinitions()` 才用新 wrapper 替换原 Read。orchestrator 通过 `shouldForceVisionRelayRead()` 计算，并传入 `browserAllowedRoots`。off/auto 或无人值守来源不得传该字段。

BDD 测试用 fake SDK 与注入的 fake `inspectImage`，至少覆盖：
1. 文本 Read 结果对象保持不变，视觉调用次数为 0。
2. 图片 Read 结果调用一次视觉服务，路径与 allowedRoots 正确，最终只有 text content。
3. 视觉服务失败时仍不含 image block，并返回 `isError: true`。
4. 相对路径按执行 ctx.cwd 解析，而不是进程 cwd。

运行：`bun test apps/electron/src/main/lib/adapters/pi-vision-relay-read.test.ts`，预期全部通过。

## Task 4: 三挡位设置 UI 与文案

**Files:**
- Modify: `apps/electron/src/renderer/components/settings/VisionRelaySettings.tsx`
- Modify: `apps/electron/src/renderer/components/onboarding/faq-content.ts`

UI 要求：
1. 用既有 `SettingsSegmentedControl` 替换 Switch，选项为“禁止 / 自动 / 强制”。
2. 模型选择器在非 off 模式下显示或保持可用；off 保留路由但运行时不使用。
3. auto/force 未选模型时显示明确“尚未生效”提示，不能假装已接管。
4. 动态说明：off 完全不参与；auto 仅无/未确认视觉能力时按需调用；force 所有模型的 Read 图片均走指定视觉模型。
5. 隐私说明明确：只有 auto/force 且路由完整时才授权图片与最多 1000 字符问题外发；强制模式当前模型只收到文本 JSON。
6. FAQ 改为通用视觉助手说明，不再限定 DeepSeek。

不新增 UI 依赖，复用 Radix/shadcn 与主题变量；保证键盘按钮可操作、深浅主题可读。

## Task 5: 版本与完整验证

**Files:**
- Modify: `apps/electron/package.json`（`0.19.133` → `0.19.134`）

依次运行：

```bash
bun test apps/electron/src/main/lib/vision-relay-policy.test.ts apps/electron/src/main/lib/adapters/pi-vision-relay-read.test.ts apps/electron/src/main/lib/adapters/pi-model-capability-overrides.test.ts
bun run typecheck
bun run electron:build
```

预期：目标测试全部通过、所有 workspace typecheck 通过、Electron 主进程/agent runtime/preload/renderer 构建成功。

最后检查：

```bash
git status --short
git diff --check
git diff --stat
git diff -- apps/electron/src/main/lib apps/electron/src/renderer apps/electron/src/types apps/electron/package.json docs/plans/2026-11-23-vision-relay-three-modes.md
```

不得覆盖无关改动或提交 release notes；实现子会话不提交 commit，由父 Agent 在审核与人工验收后统一收尾。最终报告需列出修改文件、测试命令与结果、未覆盖的真实模型联调边界。

## 执行结果（2026-11-23）

- 实现由 DeepSeek 官方渠道 `deepseek-flash` 完成，父 Agent 复核并修正了 `~` 路径解析与自动/禁止档隐私文案。
- 目标测试 33 pass / 0 fail（118 项断言）；7 个 workspace typecheck 全部通过；Electron build 通过；`git diff --check` 通过。
- 全量 Electron 测试 1587 pass / 3 skip / 3 fail；3 个失败均在 `pi-live-compact-extension.test.ts`，已在干净工作区复现，与本改造无关。
- 2026-11-23 00:42 GMT+8，用户明确确认“开发版 App 人工验证 Vision Relay 有效”。此项关闭真实 App 与视觉链路的首条人工验收，但用户未提供具体挡位、模型、图片和断言组合，因此不将其扩大记录为全组合回归通过。
