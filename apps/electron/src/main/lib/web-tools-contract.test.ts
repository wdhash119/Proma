import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('联网工具契约', () => {
  test('Given Pi 工具集 When 检查 Then 注册了 WebSearch 与 WebFetch', () => {
    const tools = readAppFile('src/main/lib/adapters/pi-builtin-tools.ts')

    expect(tools).toContain("name: 'WebSearch'")
    expect(tools).toContain("name: 'WebFetch'")
    expect(tools).toContain('buildWebResearchTools')
    // 工具必须真正注入到统一入口，否则模型看不到。
    expect(tools).toContain('tools.push(...buildWebResearchTools(sdk, ctx))')
  })

  test('Given 联网实现 When 检查 Then 不依赖 Proma Cloud 或用户密钥', () => {
    const search = readAppFile('src/main/lib/web-search-service.ts')
    const fetchService = readAppFile('src/main/lib/web-fetch-service.ts')

    for (const source of [search, fetchService]) {
      expect(source).not.toContain('proma-cloud')
      expect(source).not.toContain('/api/v1/tools')
      expect(source).not.toContain('PROMA_API_KEY')
    }
    // 搜索走公开 HTML 端点，抓取走本地 fetch。
    expect(search).toContain('html.duckduckgo.com')
    expect(fetchService).toContain('await fetch(current')
    expect(fetchService).toContain("redirect: 'manual'")
  })

  test('Given 抓取实现 When 检查 Then 有超时、体积上限与协议限制', () => {
    const fetchService = readAppFile('src/main/lib/web-fetch-service.ts')

    expect(fetchService).toContain('DEFAULT_TIMEOUT_MS')
    expect(fetchService).toContain('MAX_BYTES')
    expect(fetchService).toContain("url.protocol !== 'http:'")
    expect(fetchService).toContain('MAX_REDIRECTS')
  })

  test('Given 系统提示词 When 检查 Then 联网工具优先于浏览器且要求核验', () => {
    const prompt = readAppFile('src/main/lib/agent-prompt-builder.ts')

    expect(prompt).toContain('公开资料检索先用')
    expect(prompt).toContain('WebSearch')
    expect(prompt).toContain('WebFetch')
    expect(prompt).toContain('改用受管浏览器打开原文核对')
  })

  test('Given 搜索结果渲染 When 检查 Then 兼容 { results: [...] } 包装', () => {
    const renderer = readAppFile('src/renderer/components/agent/tool-result-renderers/web-search-result.tsx')

    expect(renderer).toContain('results?: unknown')
    expect(renderer).toContain('Array.isArray(parsed)')
  })
})
