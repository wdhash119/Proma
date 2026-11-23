/**
 * SettingsHelpTip - 设置项问号提示
 *
 * 设置页的说明文字只保留一句结论，其余解释收进问号 tooltip：
 * 页面不被大段 description 撑开，又想看细节时鼠标悬停或键盘 Tab 到问号即可。
 *
 * 基于既有 ui/tooltip（Radix）；App 根已提供 TooltipProvider，
 * 这里不再嵌套 Provider，避免覆盖全局 delayDuration。
 */

import * as React from 'react'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface SettingsHelpTipProps {
  /** tooltip 正文：短句用 string，需要强调时可传 ReactNode */
  content: React.ReactNode
  /** 无障碍名称；缺省“说明”，同一页有多个问号时传具体项名 */
  label?: string
  /** 额外 className（用于对齐微调） */
  className?: string
}

export function SettingsHelpTip({
  content,
  label = '说明',
  className,
}: SettingsHelpTipProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-full',
            'text-muted-foreground/70 transition-colors hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            'focus-visible:ring-offset-background',
            className,
          )}
        >
          <HelpCircle className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 leading-relaxed">
        {content}
      </TooltipContent>
    </Tooltip>
  )
}
