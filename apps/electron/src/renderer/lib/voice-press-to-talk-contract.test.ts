import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..')
const electronRoot = join(rendererRoot, '..')

describe('按住说话契约', () => {
  test('Given 语音输入设置类型 When 检查 Then 含 pressToTalkEnabled', () => {
    const settingsSource = readFileSync(join(electronRoot, 'types/settings.ts'), 'utf8')
    expect(settingsSource).toContain('pressToTalkEnabled?: boolean')
    // 长按事件必须带 token，主进程才能判定会话归属。
    expect(settingsSource).toContain("action: 'start' | 'stop'")
    expect(settingsSource).toContain('pressToTalk?: VoicePressToTalkRequest')
  })

  test('Given 设置页 When 检查 Then 提供按住说话开关并广播变更事件', () => {
    const settingsPage = readFileSync(join(rendererRoot, 'components/settings/VoiceInputSettings.tsx'), 'utf8')
    expect(settingsPage).toContain('按住说话')
    expect(settingsPage).toContain('按住 450 毫秒后才开始录音')
    expect(settingsPage).toContain('VOICE_DICTATION_SETTINGS_CHANGED_EVENT')
    expect(settingsPage).toContain('update({ pressToTalkEnabled })')
  })

  test('Given 麦克风按钮 When 检查 Then 绑定长按事件且保留点击 toggle', () => {
    const button = readFileSync(join(rendererRoot, 'components/ai-elements/speech-button.tsx'), 'utf8')
    expect(button).toContain('useVoicePressToTalk')
    expect(button).toContain('onPointerDown')
    expect(button).toContain('onPointerUp')
    expect(button).toContain('onClick={handleClick}')
    // 长按已消费手势时要跳过 click，否则会立刻再切换一次。
    expect(button).toContain('shouldSuppressClick')
  })

  test('Given 主进程 toggle 通道 When 检查 Then 把布尔结果返回渲染端', () => {
    const ipcSource = readFileSync(join(electronRoot, 'main/ipc.ts'), 'utf8')
    expect(ipcSource).toContain('normalizeVoicePressToTalkRequest')
    const preloadSource = readFileSync(join(electronRoot, 'preload/index.ts'), 'utf8')
    expect(preloadSource).toContain('toggleVoiceDictation: (input?: VoiceDictationToggleInput) => Promise<boolean>')
  })

  test('Given 长按守卫 When 检查 Then 主进程仍以自校验状态为准', () => {
    const windowSource = readFileSync(join(electronRoot, 'main/lib/voice-dictation-window.ts'), 'utf8')
    expect(windowSource).toContain('canStopVoicePressToTalk')
    expect(windowSource).toContain('canStartVoicePressToTalk')
    expect(windowSource).toContain('activePressToTalkToken')
  })
})
