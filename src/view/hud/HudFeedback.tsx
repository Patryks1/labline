import { CaretRight, CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { useUiStore } from '../../store/uiStore'
import { ConsoleDialog } from './ui/ConsoleDialog'
import { HudButton } from './ui/HudPrimitives'

export function HudFeedback() {
  const confirm = useUiStore((s) => s.confirmRequest)
  const clearConfirm = useUiStore((s) => s.clearConfirm)
  const toast = useUiStore((s) => s.toast)
  const clearToast = useUiStore((s) => s.clearToast)

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(clearToast, 3200)
    return () => window.clearTimeout(timeout)
  }, [toast, clearToast])

  return (
    <>
      {toast ? (
        <div
          role="status"
          className={`hud-toast pointer-events-auto absolute bottom-[calc(var(--hud-ops)+0.75rem)] left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-panel px-3 py-2.5 text-[0.8125rem] shadow-2xl ${
            toast.tone === 'danger'
              ? 'border-danger/40 text-danger'
              : toast.tone === 'warning'
                ? 'border-amber/40 text-amber'
                : 'border-mint/40 text-mint'
          }`}
        >
          {toast.tone === 'positive' ? <CheckCircle size="1rem" weight="fill" /> : <WarningCircle size="1rem" weight="fill" />}
          <span className="text-bone">{toast.message}</span>
          <HudButton type="button" variant="ghost" aria-label="Dismiss notification" onClick={clearToast} className="ml-1 min-h-11 min-w-11 border-transparent p-0 text-muted hover:text-bone"><CaretRight size="0.9rem" /></HudButton>
        </div>
      ) : null}

      <ConsoleDialog
        open={Boolean(confirm)}
        titleId="hud-confirm-title"
        eyebrow={confirm ? (
          <span className={confirm.tone === 'danger' ? 'text-danger' : confirm.tone === 'warning' ? 'text-amber' : ''}>
            Confirm decision
          </span>
        ) : null}
        title={confirm?.title ?? 'Confirm decision'}
        onClose={clearConfirm}
        closeLabel="Cancel decision"
        maxWidthClass="max-w-[30rem]"
        footer={confirm ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <HudButton type="button" variant="secondary" onClick={clearConfirm}>Cancel</HudButton>
            <HudButton
              type="button"
              variant={confirm.tone === 'danger' ? 'danger' : confirm.tone === 'warning' ? 'secondary' : 'primary'}
              className={confirm.tone === 'warning' ? 'border-amber/40 bg-amber/10 text-amber' : ''}
              onClick={() => {
                const action = confirm.onConfirm
                clearConfirm()
                action()
              }}
            >
              {confirm.actionLabel}
            </HudButton>
          </div>
        ) : null}
      >
        <p className="text-[0.875rem] leading-relaxed text-muted">{confirm?.body}</p>
      </ConsoleDialog>
    </>
  )
}
