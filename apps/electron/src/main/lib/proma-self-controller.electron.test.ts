import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const controllerModulePath = join(import.meta.dir, 'proma-self-controller.ts')
const repoRoot = dirname(dirname(dirname(dirname(dirname(import.meta.dir)))))

/** 与 planning-manager 测试一致：直接读 electron 包里的 path.txt 拼出可执行文件。 */
function resolveElectronBinary(): string {
  const electronPackageDirectory = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
  const platformPath = readFileSync(join(electronPackageDirectory, 'path.txt'), 'utf8').trim()
  return join(electronPackageDirectory, 'dist', platformPath)
}

const electronBinary = resolveElectronBinary()

/**
 * Proma 自操作依赖 Electron 的真实 debugger / AX 树 / 输入注入，Bun 里无法模拟。
 * 因此用独立 Electron 进程开一个真实窗口，跑完整的观察与操作链路：
 * observe → find → click → fill → scroll → screenshot，并验证受保护控件与旧 ref 被拒绝。
 */
test('Given a real Electron window When Proma self-control tools run Then observe/click/fill/scroll/screenshot work and protected targets are refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'proma-self-control-'))
  const sourcePath = join(home, 'verify-self-control.ts')
  const outputPath = join(home, 'verify-self-control.cjs')

  const source = `
    import assert from 'node:assert/strict'
    import { app, BrowserWindow } from 'electron'
    import { PromaSelfController } from ${JSON.stringify(controllerModulePath)}

    // 无头/无 GPU 环境也能稳定渲染，避免截图与坐标计算受硬件加速影响。
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('force-device-scale-factor', '1')

    const sessionId = 'verify-session'

    const page = \`<!doctype html>
      <html><head><meta charset="utf-8"><title>自操作测试页</title></head>
      <body>
        <button id="ok" aria-label="打开设置">打开设置</button>
        <button id="danger">删除项目</button>
        <div data-proma-self-control="deny"><button id="denied">点了也不该生效</button></div>
        <input id="name" aria-label="名称" placeholder="名称" />
        <div id="log"></div>
        <div id="mirror"></div>
        <div style="height:2400px"></div>
        <div id="bottom">底部标记</div>
        <script>
          document.getElementById('ok').addEventListener('click', () => {
            document.getElementById('log').textContent = 'clicked';
          });
          document.getElementById('name').addEventListener('input', (event) => {
            document.getElementById('mirror').textContent = '填好了:' + event.target.value;
          });
        </script>
      </body></html>\`

    function fail(message) {
      const error = new Error(message)
      error.__verifyFailure = true
      throw error
    }

    async function expectRejection(promise, needle, label) {
      try {
        await promise
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes(needle)) fail(\`\${label}: 错误文案不含「\${needle}」，实际为「\${message}」\`)
        return message
      }
      fail(\`\${label}: 期望被拒绝，实际成功\`)
    }

    let currentStep = 'boot'
    let report = {}

    async function main() {
      await app.whenReady()
      const win = new BrowserWindow({
        width: 900,
        height: 700,
        show: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      })
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
      // 等首帧，确保 capturePage 与元素坐标可用。
      await new Promise((resolve) => setTimeout(resolve, 400))

      const controller = new PromaSelfController(() => win)
      currentStep = 'observe'

      // 1) 观察：拿到真实 AX 快照
      const snapshot = await controller.observe(sessionId, 200)
      assert.equal(snapshot.title, '自操作测试页', '窗口标题应来自真实页面')
      assert.ok(snapshot.elements.length > 0, 'AX 树应至少返回一个元素')
      const okButton = snapshot.elements.find((element) => element.name === '打开设置')
      assert.ok(okButton, '应观察到「打开设置」按钮')
      report.observeCount = snapshot.elements.length

      currentStep = 'find'
      // 2) 语义定位
      const found = await controller.find(sessionId, { role: 'button', name: '删除项目' })
      assert.equal(found.elements.length, 1, 'find 应精确命中一个按钮')
      report.findResolved = found.elements[0].ref

      currentStep = 'click'
      // 3) 点击：用真实鼠标事件触发页面逻辑
      const beforeClick = await controller.observe(sessionId, 200)
      const clickTarget = beforeClick.elements.find((element) => element.name === '打开设置')
      assert.ok(clickTarget, '点击前需要重新观察拿到有效 ref')
      await controller.click(sessionId, clickTarget.ref)
      const clicked = await controller.waitFor(sessionId, { kind: 'text', value: 'clicked' }, 3000)
      assert.equal(clicked.matched, true, '点击后页面应更新出 clicked 文本')
      report.clickWorked = true

      currentStep = 'stale-ref'
      // 4) 重新观察后，上一代 ref 必须失效
      await controller.observe(sessionId, 200)
      await expectRejection(
        controller.click(sessionId, clickTarget.ref),
        '已失效',
        '旧 ref 点击',
      )
      report.staleRefRejected = true

      currentStep = 'fill'
      // 5) 填写：真实键盘输入触发 input 事件
      const beforeFill = await controller.observe(sessionId, 200)
      const input = beforeFill.elements.find((element) => element.editable)
      assert.ok(input, '应观察到可编辑字段')
      await controller.fill(sessionId, input.ref, '张三')
      const filled = await controller.waitFor(sessionId, { kind: 'text', value: '填好了:张三' }, 3000)
      assert.equal(filled.matched, true, '填写后页面应回显输入内容')
      report.fillWorked = true

      currentStep = 'blocked-label'
      // 6) 受保护动作标签
      const forDanger = await controller.observe(sessionId, 200)
      const danger = forDanger.elements.find((element) => element.name === '删除项目')
      assert.ok(danger, '应观察到「删除项目」按钮')
      await expectRejection(controller.click(sessionId, danger.ref), '需要用户亲自操作', '受保护标签点击')
      report.blockedLabelRejected = true

      currentStep = 'blocked-container'
      // 7) 受保护容器（标签本身不敏感，靠 DOM 守卫拦截）
      const forDenied = await controller.observe(sessionId, 200)
      const denied = forDenied.elements.find((element) => element.name === '点了也不该生效')
      assert.ok(denied, '应观察到 deny 区域内的按钮')
      await expectRejection(controller.click(sessionId, denied.ref), '需要用户亲自操作', '受保护容器点击')
      report.blockedContainerRejected = true

      currentStep = 'blocked-dom'
      // 8) DOM 操作也应被同一守卫拦住
      await expectRejection(
        controller.domAction(sessionId, { action: 'click', selector: '#denied' }),
        '需要用户亲自操作',
        'DOM 受保护点击',
      )
      report.blockedDomRejected = true

      currentStep = 'scroll'
      // 9) 滚动
      const scrolled = await controller.scroll(sessionId, { deltaY: 600 })
      assert.equal(scrolled && scrolled.ok, true, '滚动应成功')
      assert.equal(scrolled.moved, true, '滚动应真正改变位置')
      report.scrollWorked = true

      currentStep = 'screenshot'
      // 10) 截图：无显示/远程会话下 Chromium 无合成器，此时必须给出可读错误而不是内部错误名
      try {
        const shot = await controller.screenshot(sessionId)
        assert.equal(shot.mimeType, 'image/png', '截图应为 PNG')
        assert.ok(shot.base64.length > 2000, '截图数据不应为空')
        report.screenshotBytes = Math.floor(shot.base64.length * 0.75)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        assert.ok(
          message.includes('无法截取 Proma 窗口画面'),
          '截图失败时必须给出可读提示，实际为: ' + message,
        )
        report.screenshotUnavailable = message
      }

      currentStep = 'dispose'
      // 11) 会话清理后 ref 失效
      controller.disposeSession(sessionId)
      const afterDispose = await controller.observe(sessionId, 50)
      assert.ok(afterDispose.generation >= 1, 'dispose 后重新观察应使用新的 generation')

      console.log('__VERIFY_RESULT__' + JSON.stringify(report))
      win.destroy()
    }

    const timer = setTimeout(() => {
      console.error('自操作验证超时')
      app.exit(2)
    }, 60_000)

    main().then(() => {
      clearTimeout(timer)
      app.exit(0)
    }).catch((error) => {
      clearTimeout(timer)
      console.error(error && error.__verifyFailure ? error.message : (error && error.stack) || String(error))
      app.exit(1)
    })
  `

  writeFileSync(sourcePath, source)

  try {
    const build = await Bun.build({
      entrypoints: [sourcePath],
      target: 'node',
      format: 'cjs',
      external: ['electron'],
    })
    expect(build.success, build.logs.map((log) => log.message).join('\n')).toBe(true)
    const compiledScript = build.outputs[0]
    if (!compiledScript) throw new Error('未生成自操作验证脚本')
    await Bun.write(outputPath, compiledScript)

    const result = spawnSync(electronBinary, [outputPath], {
      cwd: repoRoot,
      // 不使用 ELECTRON_RUN_AS_NODE：这里需要真实的 BrowserWindow 与 debugger。
      // 不覆盖 HOME/USERPROFILE：Electron 在 Windows 上会因 USERPROFILE 指向
      // 缺少 AppData 结构的临时目录而以 exit 3 静默退出。控制器本身不读配置路径。
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 120_000,
    })

    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    expect(result.status, combined).toBe(0)

    const marker = '__VERIFY_RESULT__'
    const markerIndex = combined.indexOf(marker)
    expect(markerIndex, `未找到验证结果输出:\n${combined}`).toBeGreaterThanOrEqual(0)
    const payload = combined.slice(markerIndex + marker.length).split('\n')[0] ?? '{}'
    const report = JSON.parse(payload) as Record<string, unknown>

    // 关键路径必须真的跑过，而不是全部被跳过。
    expect(report.clickWorked).toBe(true)
    expect(report.fillWorked).toBe(true)
    expect(report.scrollWorked).toBe(true)
    expect(report.staleRefRejected).toBe(true)
    expect(report.blockedLabelRejected).toBe(true)
    expect(report.blockedContainerRejected).toBe(true)
    expect(report.blockedDomRejected).toBe(true)
    expect(Number(report.screenshotBytes)).toBeGreaterThan(2000)
    expect(Number(report.observeCount)).toBeGreaterThan(0)
  } finally {
    // 设置 PROMA_KEEP_VERIFY=1 可保留临时脚本，便于排查 Electron 侧失败。
    if (!process.env.PROMA_KEEP_VERIFY) rmSync(home, { recursive: true, force: true })
    else console.log('[自操作验证] 临时目录已保留:', home)
  }
}, 180_000)
