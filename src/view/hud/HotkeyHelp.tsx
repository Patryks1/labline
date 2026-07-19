import { useGameStore } from '../../store/gameStore'

const ROWS: { keys: string; action: string }[] = [
  { keys: 'Space / P', action: 'Pause / resume' },
  { keys: '0 1 2 3', action: 'Speed: pause · 1× · 2× · 5×' },
  { keys: '+ / = / .', action: 'Step one day' },
  { keys: 'Q E F R T Y', action: 'Strategy · Lab · Infra · Build · Market · Company' },
  { keys: 'Shift+1–6', action: 'Same workspaces' },
  { keys: 'Z X C V', action: 'Sub-tabs in current workspace' },
  { keys: '[', action: 'Toggle left drawer' },
  { keys: ']', action: 'Toggle command dock' },
  { keys: 'Tab', action: 'Cycle dock view (Shift reverse)' },
  { keys: 'F1–F4', action: 'P&L · Trends · Rivals · Feed' },
  { keys: 'Esc', action: 'Close help / pause menu · open menu' },
  { keys: 'Ctrl/⌘+S', action: 'Quick save (autosave)' },
  { keys: '? / H', action: 'Toggle this help' },
]

export function HotkeyHelp() {
  const open = useGameStore((s) => s.hotkeyHelpOpen)
  const setOpen = useGameStore((s) => s.setHotkeyHelpOpen)
  if (!open) return null

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-void/70 p-4 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-bone">Hotkeys</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full px-2 py-0.5 text-[0.8125rem] text-muted hover:bg-panel-2 hover:text-bone"
          >
            Esc
          </button>
        </div>
        <div className="space-y-1.5">
          {ROWS.map((r) => (
            <div
              key={r.keys}
              className="flex items-center justify-between gap-3 rounded-lg border border-line/60 bg-panel-2 px-2.5 py-1.5"
            >
              <kbd className="shrink-0 rounded bg-void px-1.5 py-0.5 font-mono text-[0.75rem] text-mint">
                {r.keys}
              </kbd>
              <span className="text-right text-[0.8125rem] text-muted">{r.action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
