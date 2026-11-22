import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 打包契约：jiti 必须保持外部依赖。
 *
 * 背景（dev 实机故障）：主进程 `live-compact-algorithm-loader.ts` 用 `await import('jiti')`
 * 现场编译覆盖层 TS。若 esbuild 把 jiti 内联进 `dist/main.cjs`，jiti 的 ESM 实现会被转成
 * CJS，esbuild 产出的 `import_meta = {}` 让 `createRequire(import_meta.url)` 收到
 * undefined，形状闸即报 “The argument 'filename' must be a file URL object…” 并拒绝覆盖层。
 *
 * 因此四个主进程/运行时脚本都必须显式 `--external:jiti`，让运行时从 node_modules 正常
 * require 真正的 ESM/CJS 双格式包。
 */

interface ElectronPackageJson {
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}

const appRoot = join(import.meta.dir, '../../..')
const packageJson = JSON.parse(
  readFileSync(join(appRoot, 'package.json'), 'utf8'),
) as ElectronPackageJson

/** 必须保持 jiti 外部的构建/监听脚本。 */
const JITI_EXTERNAL_SCRIPTS = ['build:main', 'watch:main', 'build:agent-runtime', 'watch:agent-runtime'] as const

describe('jiti 打包契约', () => {
  for (const scriptName of JITI_EXTERNAL_SCRIPTS) {
    test(`${scriptName} 显式声明 --external:jiti`, () => {
      const command = packageJson.scripts?.[scriptName]
      expect(typeof command).toBe('string')
      expect(command).toContain('--external:jiti')
    })
  }

  test('build:main 与 watch:main 指向同一个入口与产物', () => {
    // 两个脚本一旦分叉，修好的 external 只覆盖一半路径（dev 用 watch，打包用 build）。
    const buildMain = packageJson.scripts?.['build:main'] ?? ''
    const watchMain = packageJson.scripts?.['watch:main'] ?? ''
    const entryAndOutput = 'src/main/index.ts --bundle --platform=node --format=cjs --outfile=dist/main.cjs'
    expect(buildMain).toContain(entryAndOutput)
    expect(watchMain).toContain(entryAndOutput)
  })

  test('jiti 仍是运行时依赖，外部化后能从 node_modules 解析', () => {
    // external 的前提是包真的会被安装进产物；被挪进 devDependencies 就会在打包版缺包。
    expect(packageJson.dependencies?.jiti).toBeDefined()
  })
})
