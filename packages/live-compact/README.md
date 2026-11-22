# @proma/live-compact

Proma 的 live compact 算法层。本包是 vendored 副本，不是独立演进的代码：`src/plan.ts`、`src/select.ts`、`src/cooldown.ts`、`src/recall.ts` 与上游 `pi-live-compact@0.12.0` 逐字节一致，`tests/` 下四份测试也只改了 import 路径。

## 来源

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/carrotciallo/pi-live-compact |
| 上游 commit | `6da2d086f111171446e0eda610527732b1800f4a` |
| 上游版本 | 0.12.0（port 自 dsh-live-compact 1.1.12，原作者 MerkyorLynn） |
| vendored 日期 | 2026-11-22 |
| 许可 | MIT，见 `LICENSE` |

机器可读的溯源信息在 `UPSTREAM.json`，逐函数移植说明在 `PORTING.md`，上游原始 README 保留为 `README.upstream.md`。

## 禁止手改算法文件

- `src/{plan,select,cooldown,recall}.ts` **不得修改任何一行**，包括注释、引号风格，以及 `cooldown.ts` 中 `latestOfficialCompaction(projected: any[])` 那一处上游遗留的 `any`。
- 原因：设置页的「同步上游」只替换这四个算法文件，胶层永久随 App 发版。手改会导致下次同步被覆盖（或产生合并冲突），也使本地文件无法再与上游 sha 逐字节比对。
- 需要改行为时，改 Proma 自有胶层（`apps/electron` 内的 live compact 扩展工厂），或向上游提 PR，再走同步流程。

## 更新方式

后续批次会在设置页提供「检查 / 同步 / 回退」服务：主进程直连 GitHub 拉取默认分支 HEAD 的 tarball，经版本号、导出形状、随包测试三重闸校验后原子激活，失败则保留现状。升级本包 vendored 基线时，同步更新 `UPSTREAM.json` 与本文件中的 commit / 版本，并保证 `tests/` 仍来自同一 commit。

## 测试

```bash
bun test packages/live-compact   # 94 例，全部来自上游算法测试
bun run typecheck                # 根 --filter '*' 会带上本包
```

测试文件随包同行（`tests/`），既是本地回归，也是 P3a 同步闸的行为基线。上游 `tests/handler.test.ts` 未纳入：它测的是上游的 Pi 扩展胶层，Proma 会用类型安全的工厂重写那一层。

## 类型消费与声明生成

对外类型入口是 `types/index.d.ts`（Proma 生成物），运行时入口仍是 `src/index.ts`，两者在 `package.json` 的 `exports` 里分开声明（`types` 条件 → 声明，`import` / `default` → 实现）。因此 bun / esbuild 打包仍直接编译 `.ts` 实现，而 tsc 消费方只看到声明样板：宿主 `apps/electron` extends 根配置（`noUnusedLocals` / `noUnusedParameters` / `noUncheckedIndexedAccess` 全开），若直接检查 vendored 实现会产生 94 条错误，走声明则完全避开，且不会把 `src/` 拉进宿主的类型检查图。

本包自己的 `bun run typecheck` 也只检查 `types/`（`strict: true`、`skipLibCheck: false`，确保声明真的被检查，而不是空跑）。

实现免检的两个原因：

1. 上游 `src/plan.ts:407` 有 1 处自身类型收窄瑕疵（`ids instanceof Set` 的 false 分支推出 `Set<unknown>`），只有改源码才能消除，而源码按红线必须原样同步；
2. 根配置的未使用变量与索引访问检查会被上游写法大面积违反。

实现的行为正确性由随包的 94 例测试守护。

### 重新生成声明

```bash
cd packages/live-compact && bun run types:generate
```

`types:generate` 做两件事：用 tsc 宽松模式（`--declaration --emitDeclarationOnly --noCheck`，`rootDir src --outDir types`）从 `src/index.ts` 产出 `types/*.d.ts`；再由 `scripts/add-dts-banner.ts` 给每份声明加一行中文横幅，并把上游源码里的 `./plan.ts` 这类显式扩展名导入改写为 `./plan`（否则消费方解析不到 `types/plan.ts`）。

生成物必须随上游同步再生：同步算法四件后重跑该命令并提交 `types/`，否则声明会与实现漂移。**不要手改 `types/` 内容**，改动会在下次生成时丢失。
