import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mainLib = import.meta.dir
const appSrc = join(mainLib, '../..')
const preloadPath = join(appSrc, 'preload/index.ts')
const ipcPath = join(appSrc, 'main/ipc.ts')
const feishuTypesPath = join(appSrc, '../../../packages/shared/src/types/feishu.ts')
const dingtalkTypesPath = join(appSrc, '../../../packages/shared/src/types/dingtalk.ts')

/** 旧版单机器人飞书/钉钉的写入与 Bridge 开关链路：产品已改用多 Bot v2 API。 */
const retiredBridges = [
  'saveFeishuConfig',
  'startFeishuBridge',
  'stopFeishuBridge',
  'saveDingTalkConfig',
  'startDingTalkBridge',
  'stopDingTalkBridge',
]

/** 设置页旧 API fallback 仍在读取这些方法，不能随退役一起删除。 */
const retainedReadBridges = [
  'getFeishuConfig',
  'getDecryptedFeishuSecret',
  'testFeishuConnection',
  'getFeishuStatus',
  'getDingTalkConfig',
  'getDecryptedDingTalkSecret',
  'testDingTalkConnection',
  'getDingTalkStatus',
]

describe('飞书/钉钉单机器人配置链退役', () => {
  test('Given preload When 检查 Then 旧版 save/start/stop 六个 bridge 已移除', () => {
    const preload = readFileSync(preloadPath, 'utf8')

    for (const bridge of retiredBridges) {
      expect(preload).not.toContain(`${bridge}:`)
    }
  })

  test('Given 设置页仍依赖旧读取 API When 检查 Then get 系 bridge 保留', () => {
    const preload = readFileSync(preloadPath, 'utf8')

    for (const bridge of retainedReadBridges) {
      expect(preload).toContain(`${bridge}:`)
    }
  })

  test('Given 主进程 IPC When 检查 Then 旧版 save/start/stop 六个 handler 已移除', () => {
    const ipc = readFileSync(ipcPath, 'utf8')

    expect(ipc).not.toContain('FEISHU_IPC_CHANNELS.SAVE_CONFIG')
    expect(ipc).not.toContain('FEISHU_IPC_CHANNELS.START_BRIDGE')
    expect(ipc).not.toContain('FEISHU_IPC_CHANNELS.STOP_BRIDGE')
    expect(ipc).not.toContain('DINGTALK_IPC_CHANNELS.SAVE_CONFIG')
    expect(ipc).not.toContain('DINGTALK_IPC_CHANNELS.START_BRIDGE')
    expect(ipc).not.toContain('DINGTALK_IPC_CHANNELS.STOP_BRIDGE')
  })

  test('Given 主进程 IPC When 检查 Then 旧读取 handler 与多 Bot v2 handler 仍在', () => {
    const ipc = readFileSync(ipcPath, 'utf8')

    expect(ipc).toContain('FEISHU_IPC_CHANNELS.GET_CONFIG')
    expect(ipc).toContain('FEISHU_IPC_CHANNELS.GET_DECRYPTED_SECRET')
    expect(ipc).toContain('FEISHU_IPC_CHANNELS.TEST_CONNECTION')
    expect(ipc).toContain('FEISHU_IPC_CHANNELS.GET_STATUS')
    expect(ipc).toContain('FEISHU_IPC_CHANNELS.SAVE_BOT_CONFIG')
    expect(ipc).toContain('DINGTALK_IPC_CHANNELS.GET_CONFIG')
    expect(ipc).toContain('DINGTALK_IPC_CHANNELS.GET_DECRYPTED_SECRET')
    expect(ipc).toContain('DINGTALK_IPC_CHANNELS.TEST_CONNECTION')
    expect(ipc).toContain('DINGTALK_IPC_CHANNELS.GET_STATUS')
    expect(ipc).toContain('DINGTALK_IPC_CHANNELS.SAVE_BOT_CONFIG')
  })

  test('Given 共享通道常量 When 检查 Then 旧版单机器人写入与 Bridge 开关常量已删除', () => {
    const feishu = readFileSync(feishuTypesPath, 'utf8')
    const dingtalk = readFileSync(dingtalkTypesPath, 'utf8')

    for (const source of [feishu, dingtalk]) {
      expect(source).not.toContain("'feishu:save-config'")
      expect(source).not.toContain("'feishu:start-bridge'")
      expect(source).not.toContain("'feishu:stop-bridge'")
      expect(source).not.toContain("'dingtalk:save-config'")
      expect(source).not.toContain("'dingtalk:start-bridge'")
      expect(source).not.toContain("'dingtalk:stop-bridge'")
    }

    expect(feishu).toContain("GET_CONFIG: 'feishu:get-config'")
    expect(dingtalk).toContain("GET_CONFIG: 'dingtalk:get-config'")
  })
})