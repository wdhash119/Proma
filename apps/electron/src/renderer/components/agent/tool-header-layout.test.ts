import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererAgentDirectory = join(import.meta.dir)

function readContentBlock(): string {
  return readFileSync(join(rendererAgentDirectory, 'ContentBlock.tsx'), 'utf8')
}

describe('工具调用头部宽度布局', () => {
  test('Given 工具头部 When 检查宽度上限 Then 不再使用百分比 max-w 提前截断', () => {
    const source = readContentBlock()

    expect(source).not.toContain('max-w-[28%]')
    expect(source).not.toContain('max-w-[60%]')
  })

  test('Given 普通工具行 When 检查容器 Then 占满可用宽度并允许内部收缩', () => {
    const source = readContentBlock()

    expect(source).toContain('flex w-full min-w-0')
    expect(source).not.toContain('inline-flex max-w-full')
  })

  test('Given 普通工具描述 When 检查 Then 占据剩余空间仅按真实溢出截断', () => {
    const source = readContentBlock()

    expect(source).toContain("'min-w-0 flex-1 truncate text-[14px]'")
  })

  test('Given 工具类型前缀 When 检查 Then 只允许收缩而不固定比例', () => {
    const source = readContentBlock()

    expect(source).toContain('min-w-0 truncate text-[14px] font-medium text-muted-foreground/65')
  })
})
