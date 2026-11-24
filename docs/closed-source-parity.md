# 开源版与闭源版能力对照

本文记录开源 Proma 跟进闭源版 v0.22.110 行为的完整结果，供后续维护与差异审计使用。

- 基线提交：`f706bfeb`（版本 0.19.59）
- 当前提交：`dad580a3`（版本 0.19.84）
- 分支：`feat/closed-source-parity`
- 规模：25 次提交，201 个文件变更（+15945 / −7754），新增 46 个源文件与 42 个测试文件
- 测试：879 pass / 3 skip / 0 fail（882 tests / 111 files）

参考实现来源为本机安装的闭源 Proma v0.22.110（`app.asar` 内 `dist/main.cjs` 与 renderer bundle），不依赖运行日志推断。

---

## 1. 运行时与 Agent 核心

| 能力 | 闭源 | 开源现状 | 状态 |
| --- | --- | --- | --- |
| Pi Agent 运行时 | 1.5.2 | 1.6.0（含 `pi-ai` patch，6 条断流重试模式） | ➕ 领先 |
| Chat 模式主入口 | 已退役 | 已退役，侧栏无 Chat 按钮，问答侧栏与问答工具 Skill 一并下线 | ✅ 一致 |
| 历史 Chat 管理 | 设置页 `legacy-chat` | 只读视图与 Chat→Agent 迁移一并移除，历史数据文件不在启动时删除 | ➖ 开源移除 |
| 权限模式 / 计划模式 | 已下线 | 已下线，`AgentPermissionService` 保留供 Slack 与协作使用 | ✅ 一致 |
| 任务进度浮层 | 已下线 | 已下线，`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`/`TodoRead` 全部移除 | ✅ 一致 |
| 上下文压缩反馈 | 消息流内单行提示 | `CompactionNotice`，终态 6s 消失 | ✅ 一致 |
| 过程摘要 | 每轮一行 | 「执行过程: N 次工具调用，M 条消息 + 耗时」，可展开 | ✅ 一致 |
| Agent 灵动岛 | 已退役 | 全链路删除（含 Swift helper 与构建脚本） | ✅ 一致 |
| 托盘 | 保留图标与新建会话 | 保留，后台完成提示音改渲染进程播放 | ✅ 一致 |
| Markdown 渲染 | 分块增量 | 分块增量 | ✅ 一致 |

## 2. 工具族对照

### 2.1 已对齐

| 工具族 | 工具 | 状态 |
| --- | --- | --- |
| 基础 | `AskUserQuestion` `CompactContext` `Present` `TaskWrite` `SelectWorktree` `VaultOpen` `InstallWindowsShell` | ✅ |
| 终端 | `TerminalOpen` `TerminalExecute` `TerminalRead` `TerminalList` `TerminalInterrupt` `TerminalClose` | ✅ |
| 浏览器（23 个） | `BrowserNavigate` `BrowserObserve` `BrowserAct` `BrowserClick` `BrowserFill` `BrowserFind` `BrowserPress` `BrowserHover` `BrowserDrag` `BrowserScroll` `BrowserExtract` `BrowserDomAction` `BrowserExecuteJavaScript` `BrowserScreenshot` `BrowserWaitFor` `BrowserSelectOption` `BrowserUpload` `BrowserNewTab` `BrowserListTabs` `BrowserSelectTab` `BrowserCloseTab` `BrowserClose` `BrowserPreviewOpen` | ✅ |
| 记忆（4 个） | `MemorySearch` `MemoryInspect` `MemoryUpdate` `MemoryHistory` | ✅ |
| 联网 | `WebSearch` `WebFetch` | ✅ 本地实现（见 §3） |
| Proma 自操作（10 个） | `PromaObserve` `PromaFind` `PromaAct` `PromaClick` `PromaFill` `PromaPress` `PromaDomAction` `PromaScroll` `PromaWaitFor` `PromaScreenshot` | ✅ |
| Computer Use | `ComputerUsePreview` | ✅ |

### 2.2 已补齐（原缺口）

| 工具族 | 工具 | 状态 |
| --- | --- | --- |
| 项目指令维护 | `ProjectInstructionsMaintain` `Inspect` `Migrate` `Replan` `Resume` | ✅ 已实现 |
| 项目地图 | `ProjectMapInspect` `ProjectMapReviewComplete` | ✅ 已实现 |
| 记忆扩展 | `MemoryInitialize` `MemoryArchive` `MemoryMigrateProfile` | ✅ 已实现 |

### 2.3 仍缺

| 工具族 | 缺失工具 | 影响 |
| --- | --- | --- |
| macOS OCR | `ComputerUseReadText` | macOS 无树界面文字识别不可用（用户已决定搁置 macOS） |

### 2.4 开源独有

| 工具 | 说明 |
| --- | --- |
| `VisionRelay` | 开源自有视觉助手转发，闭源由 Proma Cloud 承担 |

### 2.5 跨供应商协作（闭源没有的能力）

闭源 v0.22.110 的 `delegate_agent` 参数里没有 `channelId`，`list_available_agent_models` 也只列父会话渠道。开源版新增：

- `resolveDelegationTarget` 支持四种组合：都不指定继承父会话、只给 channelId、只给 modelId（跨渠道查唯一归属）、都给（校验归属）
- 同一 modelId 属于多个启用渠道时要求显式 channelId 并列出候选，不猜
- `list_available_agent_models` 返回全部启用渠道；`delegate_agent` / `delegate_agents` 的 item 均可指定 `channelId`
- 凭据链路未改：orchestrator 已按 channelId 解析 provider 与 OAuth 凭据

真实验证：主会话在 DeepSeek 渠道，指定副渠道 channelId 委派，子会话 meta 的 channelId 与 effectiveModelId 均正确，子会话正常启动并回传结果。

## 3. 联网检索

| 项 | 闭源 | 开源 |
| --- | --- | --- |
| `WebSearch` | Proma Cloud 一等工具，每次成功请求扣 0.0059 积分 | 本地 DuckDuckGo HTML 端点，零密钥零计费 |
| `WebFetch` | Proma Cloud 转 Markdown，单页 4 万字上限 | 本地抓取 + 零依赖 HTML→Markdown 转换，3MB 上限、5 跳重定向、20s 超时 |
| 失败策略 | 由云端返回 | 给出「改用受管浏览器」的可执行提示 |

实测：Agent 通过本地 `WebSearch` 回答「Electron 稳定版 45.4.1」，独立核实为 2 天前发布的 Latest Stable，结果准确。

## 4. Computer Use / Cua Driver

| 模块 | 闭源 | 开源现状 | 状态 |
| --- | --- | --- | --- |
| 驱动路径解析 | 支持 `driver_path` / 中文键名 / 默认位置 / PATH | 同，含 mtime+size 缓存 | ✅ |
| 驱动调用 | 8s 超时、2MB buffer | 同 | ✅ |
| 错误分类 | 8 类 | 同（窗口失效/桌面不可用/激活被拒/权限/超时/采集失败等，中文文案） | ✅ |
| 窗口镜像预览 | snapshot + macOS 原生流 | 仅 snapshot（2s 轮询，空闲停采） | ⚠️ 部分 |
| macOS 原生流 | `displayMedia` + 窗口源代理 | 未实现 | ❌ 搁置 |
| Apple Vision OCR | Swift helper | 未实现 | ❌ 搁置 |
| macOS 系统权限块 | 屏幕录制/辅助功能引导 | 未实现 | ❌ 搁置 |
| CDN 更新检查 | `latest.yml` 严格校验 + 按天检查 | 同（多键也拒、降级拒绝、网络失败保留旧结论） | ✅ |
| 设置页 | `computer-use` 分区 + 侧栏红点 | 同 | ✅ |

真实端到端验证（本机 Cua Driver 0.53.0）：采集 960×380 PNG 294KB；设置页显示「已安装 0.53.0」；点「检查更新」写入 `0.55.0` 并出现更新条与红点。

## 5. 记忆与 Skills

| 能力 | 闭源 | 开源现状 | 状态 |
| --- | --- | --- | --- |
| 记忆存储 | 全局画像 + 工作区 `memory/` | 同（`revision` 乐观锁、历史快照上限 50） | ✅ |
| 单条维护 | `applyMemoryOperations` 只改命中行 | 同 | ✅ |
| 跨层检索 | 逐行打分带来源行号 | 同 | ✅ |
| 设置页 | 闭源 renderer 无独立「关于你」分区 | 「关于你」：目标切换、字数预算、历史版本与恢复 | ➕ 开源增强 |
| Skills 30 天未用 | 有 | `skill-usage.json` + 能力页筛选与计数 | ✅ |
| 交付物 | `Present` + 会话顶部区 | 同（`artifacts.json`，同路径去重、上限 20） | ✅ |

## 6. 自动化 / 清单 / 协作

| 能力 | 闭源 | 开源现状 | 状态 |
| --- | --- | --- | --- |
| 定时任务提醒策略 | `always` / `failures-only` / `never` | 同 | ✅ |
| 快速捕获快捷键 | `Cmd/Ctrl+Shift+T` | 同（主进程全局 + 应用内回退） | ✅ |
| 协作子会话 | 支持 | 支持（`agent-collaboration` Skill 1.2.0） | ✅ |

## 7. 变更请求 / Worktree

| 能力 | 闭源 | 开源现状 | 状态 |
| --- | --- | --- | --- |
| PR 状态追踪 | 会话元数据 + 轮询 | 同（活跃 30s / 空闲 120s / 关闭 300s / 退避上限 900s） | ✅ |
| PR 来源发现 | 手动 / 分支 / `gh pr create` / 正文链接 | 同（含 fork upstream） | ✅ |
| 轮次结束发现 | 有 | `TurnDiscoveryScheduler`，5s 防抖，仅项目根或已有绑定时触发 | ✅ |
| push 后按实际分支 | 有 | `change-request-observer` 解析 `To <remote>` 行 | ✅ |
| worktree 恢复 | 检出日志 + 一键恢复 | 同（20 条上限、拒绝可疑路径、真实 git 恢复测试） | ✅ |
| 元数据写入 | — | `changeRequests` 不 bump `updatedAt`，避免侧栏跳顶 | ➕ 开源细化 |

## 8. 语音与剪贴板

| 能力 | 闭源 | 开源现状 | 状态 |
| --- | --- | --- | --- |
| 按住说话 | `pressToTalkEnabled` + token 守卫 | 同（450ms 阈值、8px 取消、松手补发 stop） | ✅ |
| 长按输出模式 | 固定 `proma-input` | 同 | ✅ |
| 剪贴板写入 | 主进程优先 | 同，且新增契约测试禁止 renderer 直调 `navigator.clipboard.writeText` | ✅ |

## 9. 设置页分区

| 闭源分区 | 开源对应 | 状态 |
| --- | --- | --- |
| general 通用设置 | 同 | ✅ |
| channels 模型配置 | 同 | ✅ |
| computer-use Computer Use | 同（本任务新增） | ✅ |
| bots 远程连接 | 同 | ✅ |
| shortcuts 快捷键管理 | 同 | ✅ |
| onboarding Proma 新手引导 | 同 | ✅ |
| voice-input 语音输入 | 同 + 「按住说话」开关 | ✅ |
| legacy-chat 历史 Chat | — | ➖ 开源移除 |
| migration 数据迁移 | 同 | ✅ |
| storage 磁盘管理 | 同 | ✅ |
| appearance 外观设置 | 同 | ✅ |
| about 关于/更新 | 同 | ✅ |
| billing 购买额度 | — | ❌ 排除（支付订阅） |
| api 开放 API | — | ❌ 排除（Proma Cloud） |
| usage 用量 | — | ❌ 排除（官方额度） |
| — | 视觉助手 | ➕ 开源自备 |
| — | 提示词管理 | ➕ 开源自备 |
| — | 代理设置 | ➕ 开源自备 |
| — | 关于你（本任务新增） | ➕ 开源增强 |

## 10. 默认 Skills

| Skill | 闭源版本 | 开源 | 备注 |
| --- | --- | --- | --- |
| agent-collaboration | 1.2.0 | 1.2.0 | ✅ |
| automation | 1.0.15 | 1.0.15 | ✅ 任务工具下线后同步改写 |
| cua-driver-cli | 1.0.17 | 1.0.17 | ✅ 本任务移植 |
| jev-use | 1.0.6 | 1.0.6 | ✅ 本任务移植 |
| proma-self-control | 1.0.1 | 1.0.1 | ✅ 本任务补齐（原为悬空引用） |
| docx / pdf / pptx / xlsx | — | 同 | ✅ |
| executing-plans / writing-plans / find-skills / skill-creator | — | 同 | ✅ |
| guizang-ppt-skill / in-app-browser / prompt-clarifier / session-cleaner / proma-coach | — | 同 | ✅ |
| proma-cloud-sdk | 有 | — | ❌ 排除（Proma Cloud） |
| proma-gpt-image-25 | 有 | — | ❌ 排除（商业版视觉） |
| proma-build-in-proma-app | 有 | — | ❌ 未移植（强依赖 Proma Open API 与商业版模型目录） |
| proma-web-search | 1.2.0 | — | ⚠️ 未移植：其正文围绕「Proma Cloud 一等工具 + 扣积分」描述，与本地实现不符；路由建议已写进系统提示词 |
| knowledge-maintenance | — | 有 | ➕ 开源自备 |

## 11. 明确排除的范围

用户已确认排除 Proma 自有 LLM API 相关能力：

- Proma Cloud 官方渠道与额度
- 支付订阅（`billing` 设置页）
- 开放 API / app key（`api` 设置页）
- 官方用量统计（`usage` 设置页）
- `proma-cloud-sdk`、`proma-gpt-image-25` Skill
- ChatGPT / Claude 官方渠道对接

第三方模型渠道（DeepSeek、Kimi、OpenAI 兼容等）保持完整。

## 12. 已知限制与未验证项

| 项 | 原因 | 影响 |
| --- | --- | --- |
| macOS 原生流 / Apple Vision OCR / 权限块 | 无 macOS 测试环境（用户确认搁置） | macOS 上预览走快照轮询，无 OCR |
| `ComputerUseReadText` 缺失 | 同上 | 无树界面只能看截图 |
| `proma-web-search` Skill | 内容绑定 Proma Cloud 计费模型 | 路由建议已在系统提示词中覆盖 |
| 按住说话真实录音 | 需麦克风 + 豆包凭据 | UI、落盘、状态守卫已验证，录音链路未跑 |
| Linux deb/AppImage 打包 | 需 Linux Runner | 配置已静态核对（deb target、afterInstall、显式 depends） |
| 安装包代码签名 | 无证书 | `NotSigned`，SmartScreen 首启提示未知发布者 |
| 真实安装/卸载流程 | 静默安装需 UAC 提权，未绕过 | 安装包结构与内容已核验 |

## 13. 打包与验证状态

Windows 打包在开启开发者模式后完整通过：

| 产物 | 大小 |
| --- | --- |
| `Proma Setup 0.19.84.exe`（NSIS） | 216 MB |
| `.exe.blockmap` | 226 KB |
| `latest.yml` | 345 B |
| `win-unpacked/` | 801 MB |

内容核验：`Proma.exe` 225MB、`resources/bin/proma.exe` 115MB、`app.asar` 247MB、`node-pty` 相关文件 236 个（含 `win32-x64/pty.node`、`conpty.node`）。

打包产物实测：窗口正常打开、界面完整；`node-pty` 经同版本 Electron 直接 `require` 并 `spawn('cmd.exe')`，输出 `pkg-terminal-ok`、退出码 0。

## 14. 后续建议优先级

1. **项目指令与地图工具族**（6–7 个工具）：这是 Agent 协作能力的核心缺口，且与 Proma Coach 的脚手架逻辑相关。
2. **记忆归档三件套**：现有 4 个记忆工具已可用，缺归档与迁移能力。
3. **`proma-web-search` Skill**：改写为本地实现版本（去掉计费描述，保留路由建议），即可补上文档层缺口。
4. **macOS 三项**：需 macOS 环境才能验证，建议在有环境时一次性补完。
5. **代码签名证书**：正式分发前必须解决。
