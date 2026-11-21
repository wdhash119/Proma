import { describe, expect, test } from 'bun:test'
import {
  ComputerUseDriverError,
  ComputerUseDriverResolver,
  type ComputerUseDriverEnvironment,
} from './computer-use-driver'

const WINDOWS_DRIVER = 'C:\\Users\\devix\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe'

interface DriverEnvironmentState {
  record: string
  files: Set<string>
}

function createEnvironment(options: {
  platform: NodeJS.Platform
  configDir: string
  home: string
  localAppData?: string
  path?: string
  record?: string
  files: string[]
}): { environment: ComputerUseDriverEnvironment; state: DriverEnvironmentState } {
  const state: DriverEnvironmentState = {
    record: options.record ?? '',
    files: new Set(options.files),
  }
  return {
    state,
    environment: {
      platform: options.platform,
      home: options.home,
      configDir: options.configDir,
      localAppData: options.localAppData,
      path: options.path ?? '',
      // 用记录内容代替真实 stat：内容变化即视为文件版本变化。
      recordVersion: () => state.record,
      readRecord: () => state.record,
      isFile: (candidate) => state.files.has(candidate),
    },
  }
}

describe('驱动路径解析器', () => {
  test('Given 记录文件指向存在的驱动 When 解析 Then 使用记录路径', () => {
    const { environment } = createEnvironment({
      platform: 'win32',
      configDir: 'C:\\Users\\devix\\.proma-dev',
      home: 'C:\\Users\\devix',
      record: `driver_path: ${WINDOWS_DRIVER}`,
      files: [WINDOWS_DRIVER],
    })

    expect(new ComputerUseDriverResolver(environment).resolve()).toBe(WINDOWS_DRIVER)
  })

  test('Given 记录文件被改写 When 再次解析 Then 丢弃缓存并使用新路径', () => {
    const other = 'C:\\Tools\\cua-driver\\cua-driver.exe'
    const { environment, state } = createEnvironment({
      platform: 'win32',
      configDir: 'C:\\Users\\devix\\.proma-dev',
      home: 'C:\\Users\\devix',
      record: `driver_path: ${WINDOWS_DRIVER}`,
      files: [WINDOWS_DRIVER, other],
    })
    const resolver = new ComputerUseDriverResolver(environment)
    expect(resolver.resolve()).toBe(WINDOWS_DRIVER)

    state.record = `driver_path: ${other}`

    expect(resolver.resolve()).toBe(other)
  })

  test('Given 记录路径已被删除 When 再次解析 Then 不再复用失效缓存', () => {
    const { environment, state } = createEnvironment({
      platform: 'win32',
      configDir: 'C:\\Users\\devix\\.proma-dev',
      home: 'C:\\Users\\devix',
      record: `driver_path: ${WINDOWS_DRIVER}`,
      files: [WINDOWS_DRIVER],
    })
    const resolver = new ComputerUseDriverResolver(environment)
    expect(resolver.resolve()).toBe(WINDOWS_DRIVER)

    state.files.delete(WINDOWS_DRIVER)

    expect(() => resolver.resolve()).toThrow('找不到 Cua Driver')
  })

  test('Given 无记录但默认安装位置存在 When 解析 Then 使用默认位置', () => {
    const localAppData = 'C:\\Users\\devix\\AppData\\Local'
    const installed = `${localAppData}\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe`
    const { environment } = createEnvironment({
      platform: 'win32',
      configDir: 'C:\\Users\\devix\\.proma-dev',
      home: 'C:\\Users\\devix',
      localAppData,
      files: [installed],
    })

    expect(new ComputerUseDriverResolver(environment).resolve()).toBe(installed)
  })

  test('Given 驱动只在 PATH 中 When 解析 Then 回退到 PATH 并去掉包裹引号', () => {
    const { environment } = createEnvironment({
      platform: 'linux',
      configDir: '/home/devix/.proma-dev',
      home: '/home/devix',
      path: '/usr/local/bin:"/opt/cua/bin"',
      files: ['/opt/cua/bin/cua-driver'],
    })

    expect(new ComputerUseDriverResolver(environment).resolve()).toBe('/opt/cua/bin/cua-driver')
  })

  test('Given 任何位置都没有驱动 When 解析 Then 抛出 driver_not_found', () => {
    const { environment } = createEnvironment({
      platform: 'darwin',
      configDir: '/Users/devix/.proma-dev',
      home: '/Users/devix',
      files: [],
    })

    let code = ''
    try {
      new ComputerUseDriverResolver(environment).resolve()
    } catch (error) {
      code = error instanceof ComputerUseDriverError ? error.code : 'unknown'
    }

    expect(code).toBe('driver_not_found')
  })
})
