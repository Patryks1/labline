import { useGameStore } from '../../store/gameStore'
import { ConsoleDialog } from './ui/ConsoleDialog'

// oxlint-disable-next-line react/only-export-components
export const HOTKEY_ROWS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: 'Space / P', action: 'Pause / resume' },
  { keys: '0 1 2 3', action: 'Speed: pause · 1× · 2× · 5×' },
  { keys: 'Q / E', action: 'Rotate camera left / right' },
  { keys: 'Shift+1–7', action: 'Same workspaces' },
  { keys: 'Z X C V', action: 'Sub-tabs in current workspace' },
  { keys: '[', action: 'Toggle left drawer' },
  { keys: ']', action: 'Toggle command dock' },
  { keys: 'Tab', action: 'Cycle dock view (Shift reverse)' },
  { keys: 'F1–F12', action: 'Open panels from Demand through Market' },
  { keys: 'Esc', action: 'Close help / pause menu · open menu' },
  { keys: 'Ctrl/⌘+S', action: 'Quick save (autosave)' },
  { keys: '? / H', action: 'Toggle this help' },
]

export function HotkeyHelp() {
  const open = useGameStore((s) => s.hotkeyHelpOpen)
  const setOpen = useGameStore((s) => s.setHotkeyHelpOpen)

  return (
    <ConsoleDialog
      open={open}
      titleId="hotkey-help-title"
      title="Hotkeys"
      onClose={() => setOpen(false)}
      closeLabel="Close hotkey help"
      maxWidthClass="max-w-md"
    >
      <div className="rounded-lg border border-mint/25 bg-mint/5 p-3 text-[0.8125rem] leading-relaxed text-muted sm:hidden [@media(max-height:540px)]:block">
        Drag or pinch the map, swipe the workspace handle sideways, and pull sheets down to close. Tap <strong className="text-bone">More</strong> for every panel.
      </div>
      <dl className="hidden space-y-1.5 sm:block [@media(max-height:540px)]:hidden">
        {HOTKEY_ROWS.map((r) => (
          <div
            key={r.keys}
            className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-line/60 bg-panel-2 px-2.5 py-1.5"
          >
            <dt className="shrink-0">
              <kbd className="rounded bg-void px-1.5 py-0.5 font-mono text-[0.75rem] text-mint">
                {r.keys}
              </kbd>
            </dt>
            <dd className="text-right text-[0.8125rem] text-muted">{r.action}</dd>
          </div>
        ))}
      </dl>
    </ConsoleDialog>
  )
}
