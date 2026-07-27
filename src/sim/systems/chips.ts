import { getChipDef, buyableChips } from '../balance/chips'
import { aggregateEffects } from './research'
import type { SimState } from '../types'
import { mapEnergy } from './map'
import { fleetStats } from './racks'
import { eventChipLeadMult, eventExportBanGen } from './events'
import { transportDeliveryAccess } from './transport'

export function buyChips(state: SimState, defId: string, count: number): SimState {
  const def = getChipDef(defId)
  if (def.custom) {
    return {
      ...state,
      alerts: [
        {
          id: `chip-custom-${state.day}`,
          day: state.day,
          severity: 'warn' as const,
          message: 'Custom silicon is produced in your fab, not bought.',
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }

  const ban = eventExportBanGen(state)
  if (ban != null && def.generation >= ban) {
    return {
      ...state,
      alerts: [
        {
          id: `chip-ban-${state.day}`,
          day: state.day,
          severity: 'danger' as const,
          message: `Export controls block ${def.name} orders.`,
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }

  const effects = aggregateEffects(state.player.researchUnlocked)
  const discount = effects.chipDiscount ?? 0
  const unit = def.price * (1 - discount)
  const total = unit * count
  if (count <= 0 || state.player.cash < total) {
    return {
      ...state,
      alerts: [
        {
          id: `chip-fail-${state.day}`,
          day: state.day,
          severity: 'warn' as const,
          message: state.player.cash < total ? 'Insufficient cash for chips.' : 'Invalid order.',
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }

  const lead = Math.max(1, Math.round(def.leadTimeDays * eventChipLeadMult(state)))
  const chips = state.player.chips.map((c) => ({
    ...c,
    arriving: c.arriving.map((a) => ({ ...a })),
  }))
  let inv = chips.find((c) => c.defId === defId)
  if (!inv) {
    inv = { defId, count: 0, arriving: [] }
    chips.push(inv)
  }
  inv.arriving.push({ daysLeft: lead, count })

  const energy = mapEnergy(state)
  const freeRacks = Math.max(0, energy.rackCap - fleetStats(state).rackUnitsUsed)
  const alerts = [
    {
      id: `chip-buy-${state.day}-${defId}`,
      day: state.day,
      severity: 'info' as const,
      message: `Ordered ${count}× ${def.name} — ${lead}d lead ($${(total / 1e6).toFixed(2)}M)`,
    },
    ...state.alerts,
  ]
  if (count > freeRacks) {
    alerts.unshift({
      id: `chip-rack-${state.day}`,
      day: state.day,
      severity: 'warn' as const,
      message: `Only ${freeRacks} free racks — expand DCs or chips will throttle.`,
    })
  }

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - total,
      chips,
    },
    alerts: alerts.slice(0, 40),
  }
}

export function tickChipDeliveries(state: SimState): SimState {
  const dailyProgress = transportDeliveryAccess(state)
  const chips = state.player.chips.map((inv) => {
    const arriving: typeof inv.arriving = []
    let count = inv.count
    for (const a of inv.arriving) {
      if (a.daysLeft <= dailyProgress) count += a.count
      else arriving.push({ daysLeft: a.daysLeft - dailyProgress, count: a.count })
    }
    return { ...inv, count, arriving }
  })
  return { ...state, player: { ...state.player, chips } }
}

export { buyableChips }
