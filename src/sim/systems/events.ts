import { createRng } from '../rng'
import type { LabId, SimState, WorldEvent } from '../types'
import { SEGMENTS } from '../balance/economy'
import { labIds, updateLab } from './labEngine'
import { appendFeedEvents } from './feed'

type EventTemplate = Omit<WorldEvent, 'day'>

export const MAX_SEGMENT_USAGE_MULTIPLIER = 3

/** Repair legacy runaway usage while preserving bounded event-driven spikes. */
export function clampSegmentUsageIntensity(
  segmentId: SimState['segments'][number]['id'],
  usageIntensity: number,
): number {
  const baseline = SEGMENTS.find((segment) => segment.id === segmentId)?.baseUsage ?? 1
  return Math.max(0, Math.min(baseline * MAX_SEGMENT_USAGE_MULTIPLIER, usageIntensity))
}

/** Ten three-part chains: enough variety to span a decade without bespoke RNG. */
const EVENT_POOL: EventTemplate[] = [
  {
    id: 'heatwave',
    chainId: 'grid_stress',
    chainStage: 1,
    nextEventId: 'transformer_backlog',
    title: 'Heatwave',
    body: 'Grid strain spikes energy prices while operators protect cooling headroom.',
    duration: 14,
    effects: { energyPriceMult: 1.55 },
  },
  {
    id: 'transformer_backlog',
    chainId: 'grid_stress',
    chainStage: 2,
    nextEventId: 'demand_response',
    title: 'Transformer backlog',
    body: 'Utilities ration new interconnections and reward labs that can shift load.',
    duration: 16,
    effects: { energyPriceMult: 1.22, chipLeadMult: 1.08 },
  },
  {
    id: 'demand_response',
    chainId: 'grid_stress',
    chainStage: 3,
    title: 'Demand-response contracts',
    body: 'Flexible operators stabilize the grid; regional power pressure begins to ease.',
    duration: 12,
    effects: { energyPriceMult: 0.88 },
  },
  {
    id: 'export_controls',
    chainId: 'chip_controls',
    chainStage: 1,
    nextEventId: 'allocation_auction',
    title: 'Export controls',
    body: 'Frontier accelerators face longer lead times and regional availability limits.',
    duration: 21,
    effects: { chipLeadMult: 1.8, exportBanGen: 3 },
  },
  {
    id: 'allocation_auction',
    chainId: 'chip_controls',
    chainStage: 2,
    nextEventId: 'alternate_accelerators',
    title: 'Accelerator allocation auction',
    body: 'Clouds and labs bid aggressively for the remaining compliant supply.',
    duration: 15,
    effects: { chipLeadMult: 1.45 },
  },
  {
    id: 'alternate_accelerators',
    chainId: 'chip_controls',
    chainStage: 3,
    title: 'Alternative accelerator ramp',
    body: 'Second-source hardware reaches production and gradually relaxes the bottleneck.',
    duration: 18,
    effects: { chipLeadMult: 0.82 },
  },
  {
    id: 'open_source_wave',
    chainId: 'open_ecosystem',
    chainStage: 1,
    nextEventId: 'price_compression',
    title: 'Open-source wave',
    body: 'Commodity models undercut API pricing; indie demand surges for cheap intelligence.',
    duration: 18,
    effects: { segmentBoost: { indie_api: 1.4, hobby: 1.3 }, rivalBoost: 0.05 },
  },
  {
    id: 'price_compression',
    chainId: 'open_ecosystem',
    chainStage: 2,
    nextEventId: 'ecosystem_contracts',
    title: 'API price compression',
    body: 'Developers benchmark every provider against a capable open outside option.',
    duration: 16,
    effects: { segmentBoost: { hobby: 1.28, indie_api: 1.32, startup_api: 1.12 } },
  },
  {
    id: 'ecosystem_contracts',
    chainId: 'open_ecosystem',
    chainStage: 3,
    title: 'Open ecosystem contracts',
    body: 'Support, hosting, and fine-tuning become the profitable layer around open models.',
    duration: 20,
    effects: { segmentBoost: { indie_api: 1.18, startup_api: 1.22, science: 1.14 } },
  },
  {
    id: 'enterprise_rfp',
    chainId: 'enterprise_buying',
    chainStage: 1,
    nextEventId: 'audit_sprint',
    title: 'Enterprise RFP season',
    body: 'Large buyers evaluate reliability, controls, and predictable serving costs.',
    duration: 20,
    effects: { segmentBoost: { enterprise: 1.6 } },
  },
  {
    id: 'audit_sprint',
    chainId: 'enterprise_buying',
    chainStage: 2,
    nextEventId: 'framework_awards',
    title: 'Procurement audit sprint',
    body: 'Shortlisted vendors face blind reliability and trust assessments.',
    duration: 14,
    effects: { segmentBoost: { enterprise: 1.32, legal: 1.16, healthcare: 1.12 } },
  },
  {
    id: 'framework_awards',
    chainId: 'enterprise_buying',
    chainStage: 3,
    title: 'Framework awards',
    body: 'Approved vendors gain slow-moving, durable demand across regulated buyers.',
    duration: 22,
    effects: { segmentBoost: { enterprise: 1.24, legal: 1.22, healthcare: 1.18 } },
  },
  {
    id: 'viral_demo',
    chainId: 'consumer_hype',
    chainStage: 1,
    nextEventId: 'capacity_crunch',
    title: 'Viral demo week',
    body: 'Consumer curiosity spikes. Fast, delightful products receive enormous attention.',
    duration: 10,
    effects: { segmentBoost: { consumer: 1.5, hobby: 1.4 } },
  },
  {
    id: 'capacity_crunch',
    chainId: 'consumer_hype',
    chainStage: 2,
    nextEventId: 'reputation_reckoning',
    title: 'Launch capacity crunch',
    body: 'Queues and outages turn viral attention into an operations test.',
    duration: 12,
    effects: { segmentBoost: { consumer: 1.25, hobby: 1.18 }, energyPriceMult: 1.08 },
  },
  {
    id: 'reputation_reckoning',
    chainId: 'consumer_hype',
    chainStage: 3,
    title: 'Reputation reckoning',
    body: 'Users settle on products that converted novelty into dependable daily value.',
    duration: 16,
    effects: { segmentBoost: { consumer: 1.16 } },
  },
  {
    id: 'talent_war',
    chainId: 'talent_cycle',
    chainStage: 1,
    nextEventId: 'salary_spiral',
    title: 'Talent war',
    body: 'Rivals poach aggressively. Labs without strong research operations lose trust.',
    duration: 12,
    effects: { brandHit: 4 },
  },
  {
    id: 'salary_spiral',
    chainId: 'talent_cycle',
    chainStage: 2,
    nextEventId: 'retention_reset',
    title: 'Senior salary spiral',
    body: 'Lead researchers demand larger pods, clearer missions, and competitive packages.',
    duration: 15,
    effects: { brandHit: 2 },
  },
  {
    id: 'retention_reset',
    chainId: 'talent_cycle',
    chainStage: 3,
    title: 'Research culture reset',
    body: 'The hiring frenzy cools as stable teams rebuild their experimental cadence.',
    duration: 18,
    effects: {},
  },
  {
    id: 'paper_moe',
    chainId: 'sparse_routing',
    chainStage: 1,
    nextEventId: 'replication_race',
    title: 'Breakthrough paper: sparse routing',
    body: 'Labs with integrated mixture-of-experts methods can absorb the public result fastest.',
    duration: 1,
    effects: {},
  },
  {
    id: 'replication_race',
    chainId: 'sparse_routing',
    chainStage: 2,
    nextEventId: 'routing_diffusion',
    title: 'Sparse-routing replication race',
    body: 'Independent replications reveal which efficiency claims survive real training runs.',
    duration: 14,
    effects: { segmentBoost: { science: 1.12, startup_api: 1.08 } },
  },
  {
    id: 'routing_diffusion',
    chainId: 'sparse_routing',
    chainStage: 3,
    title: 'Routing methods diffuse',
    body: 'Validated sparse techniques spread through publications, licenses, and hiring.',
    duration: 20,
    effects: {},
  },
  {
    id: 'creative_boom',
    chainId: 'creative_cycle',
    chainStage: 1,
    nextEventId: 'media_compute_shortage',
    title: 'Creative tools boom',
    body: 'Image, video, and audio budgets open across studios and agencies.',
    duration: 16,
    effects: { segmentBoost: { creative: 1.8 } },
  },
  {
    id: 'media_compute_shortage',
    chainId: 'creative_cycle',
    chainStage: 2,
    nextEventId: 'creator_consolidation',
    title: 'Media compute shortage',
    body: 'High-resolution generation collides with inference capacity and latency limits.',
    duration: 14,
    effects: { segmentBoost: { creative: 1.45 }, energyPriceMult: 1.06 },
  },
  {
    id: 'creator_consolidation',
    chainId: 'creative_cycle',
    chainStage: 3,
    title: 'Creator platform consolidation',
    body: 'Creators reward controllable multimodal tools with stable workflow integrations.',
    duration: 20,
    effects: { segmentBoost: { creative: 1.3, consumer: 1.08 } },
  },
  {
    id: 'corpus_lawsuit',
    chainId: 'data_rights',
    chainStage: 1,
    nextEventId: 'license_scramble',
    title: 'Training corpus lawsuit',
    body: 'Buyers ask harder questions about provenance, consent, and restricted sources.',
    duration: 12,
    effects: { segmentBoost: { legal: 1.18, enterprise: 1.08 }, brandHit: 1.5 },
  },
  {
    id: 'license_scramble',
    chainId: 'data_rights',
    chainStage: 2,
    nextEventId: 'provenance_standard',
    title: 'Premium corpus license scramble',
    body: 'Exclusive data partnerships become a scarce input to defensible specialist models.',
    duration: 18,
    effects: { segmentBoost: { legal: 1.24, science: 1.1 } },
  },
  {
    id: 'provenance_standard',
    chainId: 'data_rights',
    chainStage: 3,
    title: 'Provenance reporting standard',
    body: 'Auditable data manifests become normal procurement evidence.',
    duration: 20,
    effects: { segmentBoost: { enterprise: 1.12, legal: 1.2, healthcare: 1.08 } },
  },
  {
    id: 'discovery_challenge',
    chainId: 'science_race',
    chainStage: 1,
    nextEventId: 'verifier_race',
    title: 'Open discovery challenge',
    body: 'Research institutions publish difficult code, math, and science tasks with hidden tests.',
    duration: 15,
    effects: { segmentBoost: { science: 1.55, startup_api: 1.1 } },
  },
  {
    id: 'verifier_race',
    chainId: 'science_race',
    chainStage: 2,
    nextEventId: 'research_contracts',
    title: 'Verifier engineering race',
    body: 'Labs invest in tests, solvers, and simulations that turn synthetic attempts into signal.',
    duration: 16,
    effects: { segmentBoost: { science: 1.4, indie_api: 1.08 } },
  },
  {
    id: 'research_contracts',
    chainId: 'science_race',
    chainStage: 3,
    title: 'Research compute contracts',
    body: 'Institutions fund models that combine high scientific scores with verifiable results.',
    duration: 22,
    effects: { segmentBoost: { science: 1.32, enterprise: 1.08 } },
  },
]

export const AUTHORED_EVENT_COUNT = EVENT_POOL.length

function templateById(id: string): EventTemplate | undefined {
  return EVENT_POOL.find((event) => event.id === id)
}

function applyInstantEffects(state: SimState, event: WorldEvent): SimState {
  let next = state
  if (event.effects.brandHit) {
    for (const labId of labIds(next)) {
      next = updateLab(next, labId, (lab) => {
        const resist = lab.researchUnlocked.includes('org_talent') ? 0.4 : 1
        return {
          ...lab,
          brandTrust: Math.max(5, lab.brandTrust - event.effects.brandHit! * resist),
        }
      })
    }
  }

  if (event.id === 'paper_moe') {
    const absorbers: LabId[] = []
    for (const labId of labIds(next)) {
      next = updateLab(next, labId, (lab) => {
        if (!lab.researchUnlocked.some((id) => id.startsWith('moe_'))) return lab
        absorbers.push(labId)
        return {
          ...lab,
          dataQuality: Math.min(2.8, lab.dataQuality + 0.08),
          trainEfficiency: Math.min(1.5, lab.trainEfficiency + 0.03),
        }
      })
    }
    if (absorbers.includes(next.playerLabId)) {
      next = {
        ...next,
        alerts: [
          {
            id: `moe-paper-${next.day}`,
            day: next.day,
            severity: 'info' as const,
            message: 'Your MoE stack absorbs the sparse-routing paper.',
          },
          ...next.alerts,
        ].slice(0, 40),
      }
    }
  }
  return appendFeedEvents(next, [
    {
      id: `feed-world-event-${event.id}-${state.day}`,
      day: state.day,
      category: 'world',
      title: event.title,
      body: event.body,
      source: 'World Desk',
      tone: 'warning',
      kind: 'world_event',
    },
  ])
}

/** Deterministically activate an authored event; useful for chains and scenarios. */
export function spawnWorldEvent(state: SimState, eventId: string): SimState {
  const template = templateById(eventId)
  if (!template || state.activeEvents.some((event) => event.id === eventId)) return state
  const event: WorldEvent = {
    ...template,
    day: state.day,
    effects: { ...template.effects },
  }
  const next = {
    ...state,
    activeEvents: [...state.activeEvents, event],
    eventCooldowns: { ...state.eventCooldowns, [event.id]: 54 },
    news: [`Day ${state.day}: ${event.title} — ${event.body}`, ...state.news].slice(0, 64),
    alerts: [
      {
        id: `ev-${event.id}-${state.day}`,
        day: state.day,
        severity: 'warn' as const,
        message: `${event.title}: ${event.body}`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
  return applyInstantEffects(next, event)
}

export function tickEvents(state: SimState): SimState {
  const rng = createRng(state.seed + state.day * 13)
  const expired: WorldEvent[] = []
  const activeEvents: WorldEvent[] = []
  for (const event of state.activeEvents) {
    const aged = { ...event, duration: event.duration - 1 }
    if (aged.duration > 0) activeEvents.push(aged)
    else expired.push(event)
  }

  const eventCooldowns = { ...state.eventCooldowns }
  for (const key of Object.keys(eventCooldowns)) {
    eventCooldowns[key] = Math.max(0, (eventCooldowns[key] ?? 0) - 1)
  }
  let next: SimState = { ...state, activeEvents, eventCooldowns }

  // A completed stage immediately opens the next response window. Keeping the
  // handoff deterministic makes a chain replayable and gives the player time
  // to adapt between distinct market effects.
  for (const event of expired) {
    if (event.nextEventId) next = spawnWorldEvent(next, event.nextEventId)
  }

  // Random world cadence starts chains only; later stages are authored follow-ups.
  if (next.day > 8 && next.day % 9 === 0 && rng.next() < 0.72) {
    const candidates = EVENT_POOL.filter(
      (event) =>
        (event.chainStage ?? 1) === 1 &&
        !eventCooldowns[event.id] &&
        !next.activeEvents.some((active) => active.chainId === event.chainId),
    )
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(rng.next() * candidates.length)]!
      next = spawnWorldEvent(next, pick.id)
    }
  }

  // Segment boosts approach an immutable baseline-relative target, then decay
  // back to baseline. Using the prior day's value as the target compounded
  // demand without bound and left it elevated after an event expired.
  const segments = next.segments.map((segment) => {
    const baseline = SEGMENTS.find((definition) => definition.id === segment.id)?.baseUsage ?? 1
    let multiplier = 1
    for (const event of next.activeEvents) {
      multiplier *= event.effects.segmentBoost?.[segment.id] ?? 1
    }
    const targetMultiplier = Math.min(
      MAX_SEGMENT_USAGE_MULTIPLIER,
      multiplier > 1 ? 0.55 + multiplier * 0.45 : 1,
    )
    const current = clampSegmentUsageIntensity(segment.id, segment.usageIntensity)
    return {
      ...segment,
      usageIntensity: current * 0.85 + baseline * targetMultiplier * 0.15,
    }
  })
  next = { ...next, segments }

  return next
}

export function eventChipLeadMult(state: SimState): number {
  return state.activeEvents.reduce(
    (multiplier, event) => multiplier * (event.effects.chipLeadMult ?? 1),
    1,
  )
}

export function eventExportBanGen(state: SimState): number | null {
  for (const event of state.activeEvents) {
    if (event.effects.exportBanGen) return event.effects.exportBanGen
  }
  return null
}
