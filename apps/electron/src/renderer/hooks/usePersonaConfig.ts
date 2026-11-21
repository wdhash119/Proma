/**
 * usePersonaConfig - 人设配置加载 hook
 *
 * 模块级守卫保证配置只从主进程加载一次（含旧系统提示词的首次迁移）；
 * 后续 CRUD 由各组件直接更新 personaConfigAtom，全应用共享。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { personaConfigAtom } from '@/atoms/persona-atoms'
import type { PersonaConfig } from '@proma/shared'

let configLoaded = false

export function usePersonaConfig(): PersonaConfig {
  const [config, setConfig] = useAtom(personaConfigAtom)

  React.useEffect(() => {
    if (configLoaded) return
    configLoaded = true
    window.electronAPI.getPersonaConfig().then((cfg) => {
      setConfig(cfg)
    }).catch((error) => {
      configLoaded = false
      console.error('[人设] 加载配置失败:', error)
    })
  }, [setConfig])

  return config
}