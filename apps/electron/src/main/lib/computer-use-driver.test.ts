import { describe, expect, test } from 'bun:test'
import type { ComputerUseDriverErrorCode } from './computer-use-driver'
import {
  ComputerUseDriverError,
  classifyComputerUseDriverError,
  checkComputerUseDriverResponse,
  parseComputerUseDriverPath,
} from './computer-use-driver'

const WINDOWS_DRIVER = 'C:\\Users\\devix\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe'
const POSIX_DRIVER = '/Users/devix/.local/bin/cua-driver'

describe('驱动路径解析', () => {
  test('Given driver_path 指向 Windows 绝对路径 When 解析 Then 返回规范化路径', () => {
    const record = ['# Computer Use', '', `driver_path: ${WINDOWS_DRIVER}`].join('\n')

    expect(parseComputerUseDriverPath(record, 'win32')).toBe(WINDOWS_DRIVER)
  })

  test('Given driver_path 指向 POSIX 绝对路径 When 解析 Then 返回该路径', () => {
    const record = `driver_path: ${POSIX_DRIVER}`

    expect(parseComputerUseDriverPath(record, 'darwin')).toBe(POSIX_DRIVER)
  })

  test('Given 中文键名与列表前缀 When 解析 Then 同样识别', () => {
    const record = ['- 绝对路径：`/opt/cua/bin/cua-driver`', 'Driver 路径: "/opt/cua/bin/cua-driver"'].join('\n')

    expect(parseComputerUseDriverPath(record, 'linux')).toBe('/opt/cua/bin/cua-driver')
  })

  test('Given 同一路径重复两次 When 解析 Then 去重后仍视为唯一', () => {
    const record = [`driver_path: ${POSIX_DRIVER}`, `driver_path: ${POSIX_DRIVER}`].join('\n')

    expect(parseComputerUseDriverPath(record, 'linux')).toBe(POSIX_DRIVER)
  })

  test('Given 两条 driver_path 指向不同路径 When 解析 Then 无法确定并返回 undefined', () => {
    const record = ['driver_path: /opt/a/cua-driver', 'driver_path: /opt/b/cua-driver'].join('\n')

    expect(parseComputerUseDriverPath(record, 'linux')).toBeUndefined()
  })

  test('Given 只有中文键名且路径不同 When 解析 Then 同样返回 undefined', () => {
    const record = ['绝对路径: /opt/a/cua-driver', 'Driver 路径: /opt/b/cua-driver'].join('\n')

    expect(parseComputerUseDriverPath(record, 'linux')).toBeUndefined()
  })

  test('Given driver_path 与中文键名冲突 When 解析 Then 显式 driver_path 优先', () => {
    const record = ['driver_path: /opt/explicit/cua-driver', '绝对路径: /opt/other/cua-driver'].join('\n')

    expect(parseComputerUseDriverPath(record, 'linux')).toBe('/opt/explicit/cua-driver')
  })

  test('Given 相对路径 When 解析 Then 忽略', () => {
    const record = ['driver_path: ./cua-driver', 'driver_path: bin/cua-driver'].join('\n')

    expect(parseComputerUseDriverPath(record, 'linux')).toBeUndefined()
  })

  test('Given 文件名不是 cua-driver When 解析 Then 忽略', () => {
    const record = ['driver_path: /opt/bin/other-driver', 'driver_path: /opt/bin/cua-driver-wrapper'].join('\n')

    expect(parseComputerUseDriverPath(record, 'linux')).toBeUndefined()
  })

  test('Given Windows 路径出现在 POSIX 机器 When 解析 Then 视为非绝对路径', () => {
    expect(parseComputerUseDriverPath(`driver_path: ${WINDOWS_DRIVER}`, 'linux')).toBeUndefined()
  })

  test('Given POSIX 路径出现在 Windows 机器 When 解析 Then 视为非绝对路径', () => {
    expect(parseComputerUseDriverPath(`driver_path: ${POSIX_DRIVER}`, 'win32')).toBeUndefined()
  })

  test('Given 文件名大小写不同 When 解析 Then 仍匹配 cua-driver.exe', () => {
    const record = 'driver_path: D:/Cua/CUA-DRIVER.EXE'

    expect(parseComputerUseDriverPath(record, 'win32')).toBe('D:\\Cua\\CUA-DRIVER.EXE')
  })

  test('Given 空记录 When 解析 Then 返回 undefined', () => {
    expect(parseComputerUseDriverPath('', 'win32')).toBeUndefined()
    expect(parseComputerUseDriverPath('# 只有说明文字', 'linux')).toBeUndefined()
  })
})

describe('驱动错误分类', () => {
  const cases: Array<[string, ComputerUseDriverErrorCode]> = [
    ['Error: window_id_not_found for 0x1234', 'window_unavailable'],
    ['window_owner_pid_mismatch: expected 42', 'window_unavailable'],
    ['Screen is locked, session 0 cannot capture', 'desktop_unavailable'],
    ['{"landed_on_target": false}', 'activation_blocked'],
    ['ERROR: Access is denied (0x80070005)', 'permission_denied'],
    ['operation ETIMEDOUT after 8000ms', 'timeout'],
    ['px_capture_unavailable for window', 'capture_failed'],
    ['something unexpected happened', 'driver_error'],
  ]

  test('Given 各类代表性 stderr When 归类 Then 得到对应错误码', () => {
    for (const [detail, code] of cases) {
      expect(classifyComputerUseDriverError(detail).code).toBe(code)
    }
  })

  test('Given 同时命中窗口失效与超时 When 归类 Then 优先报告窗口失效', () => {
    const error = classifyComputerUseDriverError('window_id_not_found: request timeout')

    expect(error.code).toBe('window_unavailable')
  })

  test('Given 任一错误 When 读取 message Then 为面向用户的中文说明', () => {
    const error = new ComputerUseDriverError('capture_failed')

    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('capture_failed')
    expect(error.message).toContain('未能取得有效窗口画面')
  })
})

describe('驱动响应校验', () => {
  test('Given 成功结果 When 校验 Then 不抛错', () => {
    expect(() => checkComputerUseDriverResponse('{"ok":true,"content":[]}')).not.toThrow()
  })

  test('Given 非 JSON 输出 When 校验 Then 不阻断调用', () => {
    expect(() => checkComputerUseDriverResponse('cua-driver 0.3.1 ready')).not.toThrow()
  })

  test('Given isError 标记 When 校验 Then 抛出分类错误', () => {
    expect(() => checkComputerUseDriverResponse('{"isError":true,"error":"window_id_not_found"}'))
      .toThrow('目标窗口已关闭')
  })

  test('Given structuredContent 内失败 When 校验 Then 同样抛出', () => {
    let code = ''
    try {
      checkComputerUseDriverResponse('{"structuredContent":{"success":false,"error":"access denied"}}')
    } catch (error) {
      code = error instanceof ComputerUseDriverError ? error.code : 'unknown'
    }

    expect(code).toBe('permission_denied')
  })

  test('Given landed_on_target 为 false When 校验 Then 归类为窗口激活失败', () => {
    expect(() => checkComputerUseDriverResponse('{"landed_on_target":false}'))
      .toThrow('系统未允许切换到目标窗口')
  })
})
