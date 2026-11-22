// 为 types/*.d.ts 生成物补打中文横幅，并把声明里的 .ts 后缀 import 改为无后缀。
//
// 背景：声明由 vendored 算法经 tsc 宽松模式导出（见 package.json 的 types:generate），
// 上游源码用 `./plan.ts` 这种显式扩展名导入，直接产出会让消费方（moduleResolution
// bundler、无 allowImportingTsExtensions）解析不到 types/plan.ts。这里统一改写为
// `./plan`，让 tsc 正常落到同目录的 plan.d.ts。
//
// 幂等：横幅已存在时不重复插入；无后缀改写对已改写文件无副作用。

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BANNER = "// 由 vendored 算法经 tsc 宽松模式生成，随上游同步再生；实现文件禁止手改";
const typesDir = join(import.meta.dir, "..", "types");

let touched = 0;
for (const name of readdirSync(typesDir)) {
  if (!name.endsWith(".d.ts")) continue;
  const path = join(typesDir, name);
  const raw = readFileSync(path, "utf8");
  const unextended = raw.replace(/(from\s+"\.\/[^"]+?)\.ts"/g, '$1"');
  const body = unextended.startsWith(BANNER) ? unextended : `${BANNER}\n${unextended}`;
  if (body !== raw) {
    writeFileSync(path, body);
    touched += 1;
  }
}

console.log(`types 横幅与导入后缀处理完成，改动 ${touched} 个文件`);
