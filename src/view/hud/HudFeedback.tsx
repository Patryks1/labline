import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { useUiStore } from '../../store/uiStore'

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
          className={`pointer-events-auto absolute bottom-[calc(var(--hud-ops)+0.75rem)] left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-panel px-3 py-2.5 text-[0.8125rem] shadow-2xl ${
            toast.tone === 'danger'
              ? 'border-danger/40 text-danger'
              : toast.tone === 'warning'
                ? 'border-amber/40 text-amber'
                : 'border-mint/40 text-mint'
          }`}
        >
          {toast.tone === 'positive' ? <CheckCircle size="1rem" weight="fill" /> : <WarningCircle size="1rem" weight="fill" />}
          <span className="text-bone">{toast.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={clearToast} className="ml-1 text-muted hover:text-bone"><X size="0.9rem" /></button>
        </div>
      ) : null}

      {confirm ? (
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-void/78 p-4 backdrop-blur-sm">
          <div className="hud-surface relative w-full max-w-[30rem] rounded-xl p-5">
            <div className="relative z-10 flex items-start justify-between gap-4">
              <div>
                <p className={`hud-eyebrow ${confirm.tone === 'danger' ? 'text-danger' : confirm.tone === 'warning' ? 'text-amber' : ''}`}>Confirm decision</p>
                <h2 className="mt-2 text-[1.125rem] font-semibold tracking-tight text-bone">{confirm.title}</h2>
                <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">{confirm.body}</p>
              </div>
              <button type="button" aria-label="Cancel" onClick={clearConfirm} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-bone"><X size="1rem" /></button>
            </div>
            <div className="relative z-10 mt-5 flex justify-end gap-2">
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
          </div>
        </div>
      ) : null}
    </>
  )
}
