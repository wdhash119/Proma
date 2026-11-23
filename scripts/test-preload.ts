/**
 * bun test 的测试环境清理，由仓库根 `bunfig.toml` 的 `[test].preload` 加载。
 *
 * 为什么要清：`packages/live-compact/src/select.ts` 等 vendored 算法文件在**模块加载时**
 * 就把 SPINE_CHUNK_MIN / SPINE_CHUNK_MAX / SPINE_POINTER_TOKENS / SPINE_KEEP_ROUNDS /
 * SPINE_KEEP_ROUND_TOKENS 求值成模块级常量，运行期不再变化；SPINE_ENGINE /
 * SPINE_COOLDOWN_MS 之类的键也会改变 resolveEngine / resolveCooldownMs 的默认参数路径。
 * 算法包的测试按上游默认旋钮写期望（保留几轮、切段落在哪一轮、engine 与冷却判定），
 * 宿主环境一旦带着覆盖进来，这些用例会以“行为回归”的形状假失败。
 *
 * 污染从哪来：仓库代码不会把这类变量写进 App 自身的 process.env——向 utility 进程 fork
 * 时传的是独立 env 副本（`env: { ...liveCompactEnv }`）。但 App / Agent 会继承启动它的
 * 终端环境：调试时 export 过 SPINE_* 的终端一旦拉起 App，由它派生的 `bun test` 就会带上
 * 同一份覆盖，与业务代码无关。
 *
 * 为什么按前缀清而不是只清五个选段旋钮：测试里对 SPINE_* 的有意使用全部是显式传参
 * （resolveCooldownMs({...})、resolveEngine({ env: {...} })）或断言生成的 env 记录，
 * 没有任何用例依赖宿主 process.env 的加载期取值，所以整体清理是安全的。
 *
 * 覆盖范围：本文件只对仓库根 `bun test` 生效；bun 只读取**当前工作目录**的 bunfig.toml，
 * 从子包目录直接跑 bun test 不会加载它。之所以只放进 [test].preload 而不放顶层 preload，
 * 是为了不影响 `bun run dev` 与打包构建。
 */

for (const key of Object.keys(process.env)) {
  if (key.startsWith('SPINE_')) delete process.env[key]
}
