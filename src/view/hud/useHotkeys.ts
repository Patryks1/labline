import { useEffect } from 'react'
import { useGameStore } from '../../store/gameStore'
import type { Speed } from '../../sim/types'
import {
  COMMAND_VIEWS,
  NAV_GROUPS,
  defaultPanelForGroup,
  groupForPanel,
  type CommandViewId,
} from './navConfig'

const SPEEDS: Speed[] = [0, 1, 2, 5]

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (t.isContentEditable) return true
  return false
}

/**
 * Global game chrome hotkeys (skip when typing in fields).
 *
 * Space — pause / play
 * 0–3  — speed (0 pause, 1=1×, 2=2×, 3=5×)
 * +/=  — step one day
 * Q E F R T Y — Strategy / Lab / Infra / Build / Market / Company
 * Shift+1–6 — same workspaces
 * [    — toggle left drawer
 * ]    — toggle command dock
 * Tab  — cycle command dock view (shift reverse)
 * F1–F4 — P&L / Trends / Rivals / Feed
 * ? / H — hotkey help overlay via custom event
 * Esc  — close pause menu / help / clear build mode
 * Ctrl/Cmd+S — quick save (autosave)
 */
export function useHotkeys() {
  const phase = useGameStore((s) => s.phase)

  useEffect(() => {
    if (phase !== 'playing') return

    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return

      const st = useGameStore.getState()
      const k = e.key

      // Quick save (allow meta/ctrl)
      if ((e.metaKey || e.ctrlKey) && (k === 's' || k === 'S')) {
        e.preventDefault()
        void st.quickSave()
        return
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Pause / play
      if (k === ' ' || k === 'p' || k === 'P') {
        e.preventDefault()
        st.togglePause()
        return
      }

      // Speeds
      if (k === '0') {
        e.preventDefault()
        st.setSpeed(0)
        st.setPaused(true)
        return
      }
      if (k === '1' || k === '2' || k === '3') {
        // Digit alone without shift: speed if not held with workspace intent.
        // Workspace uses Digit with optional shift, or letter keys.
        // Prefer: bare 1/2/3 = speed when not using Shift; Shift+1–6 = groups.
        if (!e.shiftKey) {
          e.preventDefault()
          const map: Record<string, Speed> = { '1': 1, '2': 2, '3': 5 }
          const sp = map[k]!
          st.setPaused(false)
          st.setSpeed(sp)
          return
        }
      }

      // Step day
      if (k === '+' || k === '=' || k === '.') {
        e.preventDefault()
        st.stepDay()
        return
      }

      // Left rail collapse
      if (k === '[') {
        e.preventDefault()
        st.toggleLeftRail()
        return
      }
      // Command dock
      if (k === ']') {
        e.preventDefault()
        st.toggleCommandDock()
        return
      }

      // Cycle dock view
      if (k === 'Tab') {
        e.preventDefault()
        const order = COMMAND_VIEWS.map((v) => v.id)
        const i = order.indexOf(st.commandView)
        const next = e.shiftKey
          ? order[(i - 1 + order.length) % order.length]!
          : order[(i + 1) % order.length]!
        st.setCommandView(next)
        if (!st.commandDockOpen) st.setCommandDockOpen(true)
        return
      }

      // F1–F4 command views
      if (k === 'F1' || k === 'F2' || k === 'F3' || k === 'F4') {
        e.preventDefault()
        const idx = Number(k.slice(1)) - 1
        const view = COMMAND_VIEWS[idx]?.id as CommandViewId | undefined
        if (view) {
          st.setCommandView(view)
          st.setCommandDockOpen(true)
        }
        return
      }

      // Workspace letters from navConfig (Q E F R T Y …)
      const letterHit = NAV_GROUPS.find(
        (g) => g.letter.toLowerCase() === k.toLowerCase(),
      )
      if (letterHit) {
        e.preventDefault()
        if (letterHit.id === 'infrastructure') st.openSites()
        else st.setPanel(defaultPanelForGroup(letterHit.id))
        return
      }

      // Shift+1–N workspaces
      if (e.shiftKey && k >= '1' && k <= '9') {
        e.preventDefault()
        const g = NAV_GROUPS[Number(k) - 1]
        if (g) {
          if (g.id === 'infrastructure') st.openSites()
          else st.setPanel(defaultPanelForGroup(g.id))
        }
        return
      }

      // Subnav within group: Z X C V (first four items)
      const subMap: Record<string, number> = { z: 0, x: 1, c: 2, v: 3, Z: 0, X: 1, C: 2, V: 3 }
      if (k in subMap) {
        const group = groupForPanel(st.activePanel)
        const item = group.items[subMap[k]!]
        if (item) {
          e.preventDefault()
          st.setPanel(item.id)
          if (!st.leftRailOpen) st.setLeftRailOpen(true)
        }
        return
      }

      // Help
      if (k === '?' || k === 'h' || k === 'H') {
        e.preventDefault()
        st.toggleHotkeyHelp()
        return
      }

      // Escape stack: help → pause menu → build → open pause menu
      if (k === 'Escape') {
        if (st.hotkeyHelpOpen) {
          e.preventDefault()
          st.setHotkeyHelpOpen(false)
          return
        }
        if (st.pauseMenuOpen) {
          e.preventDefault()
          st.setPauseMenuOpen(false)
          return
        }
        if (st.buildMode) {
          e.preventDefault()
          st.setBuildMode(null)
          return
        }
        e.preventDefault()
        st.setPauseMenuOpen(true)
        return
      }

      // Comma cycles speed downward
      if (k === ',') {
        e.preventDefault()
        const cur = st.state.paused ? 0 : st.state.speed
        const i = SPEEDS.indexOf(cur as Speed)
        const prev = SPEEDS[Math.max(0, (i < 0 ? 1 : i) - 1)] ?? 0
        if (prev === 0) {
          st.setSpeed(0)
          st.setPaused(true)
        } else {
          st.setPaused(false)
          st.setSpeed(prev)
        }
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])
}
