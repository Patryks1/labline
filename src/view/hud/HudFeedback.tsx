import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { useUiStore } from '../../store/uiStore'
import { ConsoleDialog } from './ui/ConsoleDialog'

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
          <button type="button" aria-label="Dismiss notification" onClick={clearToast} className="ml-1 flex min-h-11 min-w-11 items-center justify-center text-muted hover:text-bone"><X size="0.9rem" /></button>
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
            <button type="button" className="hud-button hud-button--secondary" onClick={clearConfirm}>Cancel</button>
            <button
              type="button"
              className={`hud-button ${confirm.tone === 'danger' ? 'hud-button--danger' : confirm.tone === 'warning' ? 'border-amber/40 bg-amber/10 text-amber' : 'hud-button--primary'}`}
              onClick={() => {
                const action = confirm.onConfirm
                clearConfirm()
                action()
              }}
            >
              {confirm.actionLabel}
            </button>
          </div>
        ) : null}
      >
        <p className="text-[0.875rem] leading-relaxed text-muted">{confirm?.body}</p>
      </ConsoleDialog>
    </>
  )
}
