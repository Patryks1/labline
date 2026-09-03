import type { BuildableKind, PanelId, SimState } from '../../sim/types'
import { computeSnapshot } from '../../sim/systems/compute'
import { planExposedModelIds } from '../../sim/balance/modelRouter'
import { isDcAnchor, isDcKind, isHqAnchor, isHqKind } from '../../sim/systems/map'
import {
  pendingStaffPoaches,
  playerHqStaffCap,
  playerStaff,
  staffTotal,
} from '../../sim/systems/staff'
import { facilityAnchorTiles } from '../../sim/systems/worldAccess'
import { ECONOMY } from '../../sim/balance/economy'
import { trainingStateOf } from '../../sim/training/state'
import { money } from './format'
import { runActivityViewModel } from './runViewModel'
import { selectFinanceDashboardReadouts } from './data/financeDashboardModel'

export type ObjectiveSeverity = 'info' | 'warning' | 'danger'

export interface Objective {
  id: string
  title: string
  description: string
  progress: string
  severity: ObjectiveSeverity
  panel: PanelId
  actionLabel: string
  buildKind?: BuildableKind
}

function playerHasCompletedHq(state: SimState): boolean {
  return facilityAnchorTiles(state, { ownerId: 'player' }).some(
    (tile) =>
      isHqKind(tile.kind) &&
      isHqAnchor(tile) &&
      tile.buildingProgress >= tile.buildingTarget,
  )
}

export function buildObjectives(state: SimState, includeGuidance = true): Objective[] {
  const objectives: Objective[] = []
  const snap = computeSnapshot(state)
  const playerTiles = facilityAnchorTiles(state, { ownerId: 'player' })
  const halls = playerTiles.filter(
    (tile) =>
      isDcKind(tile.kind) &&
      isDcAnchor(tile) &&
      tile.buildingProgress >= tile.buildingTarget,
  )
  const hasRacks = state.player.rackFleet.some((rack) => rack.status === 'live' || rack.status === 'ordered')
  const publicModels = state.player.models.filter((model) => model.shipped || model.release === 'released')
  const hasPublishedProduct = publicModels.some(
    (model) =>
      model.apiPriceInPerMTok != null ||
      model.apiPriceOutPerMTok != null ||
      state.player.pricing.plans.some(
        (plan) =>
          plan.enabled &&
          planExposedModelIds(
            plan,
            state.player.models,
            state.player.modelRouters,
          ).includes(model.id),
      ),
  )
  const hasResearch =
    state.player.activeResearch != null ||
    state.player.researchQueue.length > 0 ||
    state.player.researchUnlocked.length > 1
  const activeCloudPf = state.computeContracts
    .filter((contract) => contract.status === 'active' && contract.buyerLabId === state.playerLabId)
    .reduce((sum, contract) => sum + contract.pf, 0)
  const hasHq = playerHasCompletedHq(state)
  const researchers = playerStaff(state).researcher ?? 0
  const seats = playerHqStaffCap(state)
  const training = trainingStateOf(state, state.playerLabId)
  const liveEndpoints = training.endpoints.filter((endpoint) => endpoint.status === 'live')
  const keptCheckpoints = training.checkpoints.filter(
    (checkpoint) => checkpoint.status === 'kept' || checkpoint.status === 'released',
  )
  const hasRouter = liveEndpoints.some(
    (endpoint) => endpoint.policy !== 'single' || endpoint.members.length > 1,
  )
  const completedRecipe = training.recipes.some((recipe) => recipe.status === 'completed')
  const activity = runActivityViewModel(state)
  const finance = selectFinanceDashboardReadouts(state).current
  const hasPublicOffer = publicModels.length > 0 || liveEndpoints.length > 0

  const poach = pendingStaffPoaches(state)[0]
  if (poach) {
    const daysLeft = Math.max(0, poach.resolveDay - state.day)
    objectives.push({
      id: `staff-poach-${poach.id}`,
      title: 'Match a poach offer',
      description: `${poach.rivalName} is raiding your team. Pay a raise before the window closes or they leave.`,
      progress: `${money(poach.retainCost)} · ${daysLeft}d left`,
      severity: 'warning',
      panel: 'org',
      actionLabel: 'Match the offer',
    })
  }

  if (finance.cash < 0) {
    const restructuring = state.player.capital?.restructuring
    const atFloor = finance.cash <= ECONOMY.victory.bankruptCash
    objectives.push({
      id: 'cash-recovery',
      title: atFloor
        ? 'Use the insolvency window'
        : 'Raise cash before bankruptcy',
      description:
        'Take credit or sell equity. The run ends only after the recovery window expires.',
      progress:
        restructuring?.active
          ? `${restructuring.daysLeft}d · ${restructuring.stage.replace('_', ' ')}`
          : money(finance.cash),
      severity: 'danger',
      panel: 'stats',
      actionLabel: 'Open Capital',
    })
  } else if (finance.runwayDays < 30) {
    objectives.push({
      id: 'runway-risk',
      title: 'Protect the cash runway',
      description: 'Current spending leaves fewer than 30 days of runway.',
      progress: `${Math.max(0, Math.floor(finance.runwayDays))} days left`,
      severity: 'danger',
      panel: 'stats',
      actionLabel: 'Review funding',
    })
  }

  if (snap.rawFlopsPf > 0 && snap.throttled) {
    objectives.push({
      id: 'power-throttle',
      title: 'Restore compute output',
      description: 'The fleet is power-throttled. Add generation or grid capacity.',
      progress: `${snap.mwDemand.toFixed(2)} MW demand · ${snap.mwAvailable.toFixed(2)} MW available`,
      severity: 'danger',
      panel: 'map',
      buildKind: 'substation',
      actionLabel: 'Build grid capacity',
    })
  }

  if (state.lastMarket.unservedRatio > 0.08 && state.lastMarket.playerDemandMTok > 0) {
    objectives.push({
      id: 'unserved-demand',
      title: 'Recover customer capacity',
      description: 'Demand is going unserved, which raises churn and weakens share.',
      progress: `${Math.round(state.lastMarket.unservedRatio * 100)}% unserved`,
      severity: 'warning',
      panel: activeCloudPf > 0 ? 'computeMarket' : 'racks',
      actionLabel: activeCloudPf > 0 ? 'Add cloud capacity' : 'Expand the fleet',
    })
  }

  const emptyHall = halls.find((hall) => hall.racksUsed <= 0)
  if (emptyHall && !hasRacks) {
    objectives.push({
      id: 'empty-hall',
      title: 'Put the new hall to work',
      description: 'A completed data hall has no installed compute.',
      progress: `${emptyHall.name || 'Data hall'} · ${emptyHall.rackCapacity} bays open`,
      severity: 'warning',
      panel: 'racks',
      actionLabel: 'Install racks',
    })
  }

  if (includeGuidance) {
    if (!hasHq || state.player.starterHqGrant) {
      objectives.push({
        id: 'place-hq',
        title: 'Place your free HQ',
        description: 'Claim an in-city lot with the starter grant — desks unlock hiring.',
        progress: state.player.starterHqGrant ? 'Grant ready · $0' : 'No HQ online',
        severity: 'info',
        panel: 'build',
        buildKind: 'hq',
        actionLabel: 'Place HQ',
      })
    } else if (researchers < 1) {
      objectives.push({
        id: 'hire-researchers',
        title: 'Hire researchers',
        description: 'Staff the HQ from the city talent pool before research or training.',
        progress: `${researchers} researchers · ${seats} seats · ${staffTotal(playerStaff(state))} hired`,
        severity: 'info',
        panel: 'org',
        actionLabel: 'Open hiring',
      })
    } else if (activeCloudPf <= 0 && !hasPublicOffer) {
      objectives.push({
        id: 'secure-cloud',
        title: 'Secure launch compute',
        description: 'Sign on-demand, reserved, or spot capacity before training.',
        progress: 'No remote PF online',
        severity: 'info',
        panel: 'computeMarket',
        actionLabel: 'Open compute market',
      })
    } else if (state.day <= 7 && !hasPublicOffer && training.runs.length === 0) {
      objectives.push({
        id: 'secure-cloud',
        title: 'Review your cloud runway',
        description: 'Your launch contract is live. Compare reserved and spot terms before committing.',
        progress: `${activeCloudPf.toFixed(0)} PF · ${money(state.player.cloudCredits ?? 0)} credits`,
        severity: 'info',
        panel: 'computeMarket',
        actionLabel: 'Review contracts',
      })
    } else if (training.runs.length === 0 && liveEndpoints.length === 0) {
      objectives.push({
        id: 'ship-model',
        title: 'Train your first model',
        description: 'Start a run from a design in Models. Progress, incidents, and checkpoints live on the run.',
        progress: 'No training run started',
        severity: 'info',
        panel: 'models',
        actionLabel: 'Configure training',
      })
    } else if (keptCheckpoints.length === 0) {
      objectives.push({
        id: 'keep-checkpoint',
        title: 'Keep a checkpoint',
        description: 'Retain a snapshot from the active run before you evaluate or release.',
        progress: activity
          ? `${Math.round(activity.progress * 100)}% · ${activity.name}`
          : 'No checkpoint kept',
        severity: 'info',
        panel: 'models',
        actionLabel: 'Open pipeline',
      })
    } else if (training.evals.length === 0) {
      objectives.push({
        id: 'order-eval',
        title: 'Order your first eval',
        description: 'Hidden truth stays fogged until you measure. Order a suite or audit from the Pipeline.',
        progress: `${keptCheckpoints.length} kept checkpoint${keptCheckpoints.length === 1 ? '' : 's'}`,
        severity: 'info',
        panel: 'models',
        actionLabel: 'Order eval',
      })
    } else if (liveEndpoints.length === 0) {
      objectives.push({
        id: 'ship-model',
        title: 'Release a live endpoint',
        description: activity
          ? 'Finish the run, then publish an endpoint customers can buy.'
          : 'Turn a kept checkpoint into a live endpoint.',
        progress: activity
          ? `${Math.round(activity.progress * 100)}% trained`
          : `${training.evals.length} eval${training.evals.length === 1 ? '' : 's'} ordered`,
        severity: 'info',
        panel: 'models',
        actionLabel: activity ? 'Review training' : 'Release endpoint',
      })
    } else if (!completedRecipe) {
      objectives.push({
        id: 'complete-recipe',
        title: 'Run a post-training recipe',
        description: 'Instruct, preference, reasoning, or agentic work improves the model. Extra stages update the same checkpoint.',
        progress: `${liveEndpoints.length} live endpoint${liveEndpoints.length === 1 ? '' : 's'}`,
        severity: 'info',
        panel: 'models',
        actionLabel: 'Open post-train',
      })
    } else if (!hasRouter) {
      objectives.push({
        id: 'create-router',
        title: 'Create a router',
        description: 'Compose a domain, cascade, or modality endpoint from more than one checkpoint.',
        progress: 'Single-checkpoint endpoints only',
        severity: 'info',
        panel: 'models',
        actionLabel: 'Open fleet',
      })
    } else if (!hasPublishedProduct) {
      objectives.push({
        id: 'publish-product',
        title: 'Publish a customer offer',
        description: 'Set API prices or attach the released model to a live plan.',
        progress: `${publicModels.length} released model${publicModels.length === 1 ? '' : 's'}`,
        severity: 'info',
        panel: 'plans',
        actionLabel: 'Configure product',
      })
    } else if (!hasResearch) {
      objectives.push({
        id: 'start-research',
        title: 'Start a research program',
        description: 'Queue an available technology to improve future efficiency.',
        progress: 'Research queue empty',
        severity: 'info',
        panel: 'research',
        actionLabel: 'Open research',
      })
    } else if (finance.share < 0.01) {
      objectives.push({
        id: 'gain-share',
        title: 'Win the first market share',
        description: 'Improve the offer, capacity, or brand until customers switch.',
        progress: `${(finance.share * 100).toFixed(1)}% share`,
        severity: 'info',
        panel: 'market',
        actionLabel: 'Review the market',
      })
    } else if (
      state.calendar.year >= state.config.campaignRules.startYear + 2 &&
      halls.length === 0 &&
      state.player.cash > 80_000_000
    ) {
      objectives.push({
        id: 'evaluate-owned-infra',
        title: 'Evaluate an owned cluster',
        description: 'At sustained utilization, colocation or an owned site may beat cloud over 36–60 months.',
        progress: `${activeCloudPf.toFixed(0)} PF rented · no owned halls`,
        severity: 'info',
        panel: 'map',
        buildKind: 'dc',
        actionLabel: 'Compare sites',
      })
    }
  }

  const severityOrder: Record<ObjectiveSeverity, number> = { danger: 0, warning: 1, info: 2 }
  return objectives
    .toSorted((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .slice(0, 3)
}
