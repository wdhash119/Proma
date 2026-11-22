// @proma/live-compact 统一出口。
//
// 本包只做一件事：把上游 pi-live-compact@0.12.0 的算法层四件（plan / select /
// cooldown / recall）原样 vendored 进来，供 Proma 自有胶层（apps/electron 内的
// live compact 扩展工厂）调用。
//
// 四条约束：
// 1. src/ 下四个算法文件与上游逐字节一致，**禁止手改**——这是设置页“同步上游”
//    能力的前提（同步只替换算法四件，胶层随 App 发版）。
// 2. 本文件是 Proma 自有文件，允许维护；但只做再导出，不写业务逻辑。
// 3. 四件之间无同名导出（select 从 plan 只 import、不 re-export），因此用
//    `export *` 即可；未来上游同步若引入重名，这里会直接报错，需改成显式命名
//    再导出并在 UPSTREAM.json 记录。
// 4. 上游的宿主胶层（extensions/live-compact.ts）不在本包内，由 Proma 用类型安全
//    的方式重写，因此不导出任何 Pi 扩展入口。

export * from "./plan.ts";
export * from "./select.ts";
export * from "./cooldown.ts";
export * from "./recall.ts";
