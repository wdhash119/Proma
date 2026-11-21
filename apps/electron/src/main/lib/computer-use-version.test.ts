import { describe, expect, test } from 'bun:test'
import { parseCuaDriverVersion } from './computer-use-version'

describe('Cua Driver 版本输出解析', () => {
  test('Given 纯版本行 When 解析 Then 返回 SemVer', () => {
    expect(parseCuaDriverVersion('cua-driver 0.3.1')).toBe('0.3.1')
    expect(parseCuaDriverVersion('  cua-driver 1.2.3  \n')).toBe('1.2.3')
  })

  test('Given 带 build 后缀 When 解析 Then 仍返回可比较版本', () => {
    expect(parseCuaDriverVersion('cua-driver 0.3.1 (build 9f2c)\n')).toBe('0.3.1')
    expect(parseCuaDriverVersion('CUA-DRIVER 0.3.1 (BUILD 9F2C)')).toBe('0.3.1')
  })

  test('Given 非法或过长输出 When 解析 Then 返回 null', () => {
    for (const output of [
      '',
      '   ',
      'cua-driver',
      'cua-driver abc',
      'cua-driver 1.0 beta',
      'something 1.0.0',
      'cua-driver 01.2.3',
      'cua-driver 0.3.1\nextra',
      'cua-driver 0.3.1 (build 9f2c) trailing',
      `cua-driver 0.3.1 ${'x'.repeat(200)}`,
    ]) {
      expect(parseCuaDriverVersion(output)).toBeNull()
    }
  })
})
