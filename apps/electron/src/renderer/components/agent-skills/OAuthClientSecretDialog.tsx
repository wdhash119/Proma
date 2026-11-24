import * as React from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface OAuthClientSecretDialogProps {
  serverName: string | null
  /** 当前连接配置里的公开 clientId；提示用户密钥必须在同一 OAuth App 下生成。 */
  clientId?: string | null
  onOpenChange: (open: boolean) => void
  onSave: (clientSecret: string) => Promise<void>
}

/** 用户显式输入 OAuth client secret 的最小安全入口；值只通过 IPC 送入 Keychain。 */
export function OAuthClientSecretDialog({ serverName, clientId, onOpenChange, onSave }: OAuthClientSecretDialogProps): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (inputRef.current) inputRef.current.value = ''
    setSaving(false)
  }, [serverName])

  const handleSave = async (): Promise<void> => {
    const clientSecret = inputRef.current?.value ?? ''
    if (!clientSecret.trim() || saving) return
    setSaving(true)
    try {
      await onSave(clientSecret)
      if (inputRef.current) inputRef.current.value = ''
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(serverName)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] p-7" onOpenAutoFocus={(event) => event.preventDefault()}>
        {serverName && <>
          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="flex items-center gap-2 text-xl font-semibold"><KeyRound size={19} />保存 OAuth Client Secret</DialogTitle>
            <DialogDescription className="text-[15px] leading-6">
              {serverName} 的 OAuth 服务要求 Client Secret。它只会加密保存到系统 Keychain，不会写入 mcp.json、显示给 Agent 或回传到页面。
            </DialogDescription>
          </DialogHeader>
          {clientId && (
            <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
              Client Secret 必须在 clientId 为 <code className="font-mono text-foreground">{clientId}</code> 的 OAuth App 下生成。
              如果你刚新建了 OAuth App，请先让 Agent 把连接配置里的 clientId 更新为新 App 的值，再粘贴新 App 的密钥，否则凭据不匹配会导致授权失败。
            </p>
          )}
          <div className="mt-7">
            <label htmlFor="oauth-client-secret" className="text-sm font-medium text-foreground">Client Secret <span className="text-destructive">*</span></label>
            <Input
              id="oauth-client-secret"
              autoComplete="off"
              type="password"
              className="mt-2 h-12 text-sm"
              placeholder="粘贴 OAuth 应用的 Client Secret"
              ref={inputRef}
              onKeyDown={(event) => { if (event.key === 'Enter') void handleSave() }}
            />
          </div>
          <DialogFooter className="mt-7 gap-3 sm:justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
            <Button onClick={() => { void handleSave() }} disabled={saving}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              安全保存并继续授权
            </Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  )
}
