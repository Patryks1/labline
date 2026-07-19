import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { roundTripState } from '../save'
import { tickDay } from '../tick'
import type {
  ComputeContract,
  DataManifest,
  DatasetAsset,
  ResearchProgram,
  SimState,
  TrainingProgram,
} from '../types'
import { getLab, syncLabIndex, updateLab } from './labEngine'

const DATASET: DatasetAsset = {
  id: 'dataset-roundtrip',
  name: 'Verified code set',
  volumeMTok: 12,
  domainWeights: { code: 1 },
  verticalTags: ['software'],
  quality: 0.94,
  diversity: 0.81,
  freshness: 0.9,
  rights: 'owned',
  source: 'expert',
  exclusiveUntilDay: null,
  contaminationRisk: 0.01,
  acquiredDay: 1,
}

const MANIFEST: DataManifest = {
  id: 'manifest-roundtrip',
  assetIds: [DATASET.id],
  domainWeights: { code: 1 },
  uniqueMTok: 11,
  repeatedMTok: 1,
  effectiveQuality: 0.92,
  contaminationRisk: 0.01,
  createdDay: 2,
}

const RESEARCH_PROGRAM: ResearchProgram = {
  id: 'research-roundtrip',
  methodId: 'sys_batching',
  podId: 'pod-systems',
  phase: 'pilot',
  evidence: [],
  insightProgress: 0.25,
  engineeringProgress: 0.1,
  computeShare: 0.3,
  disclosure: 'secret',
}

const TRAINING_PROGRAM: TrainingProgram = {
  id: 'training-roundtrip',
  objective: 'Efficient code model',
  targetSegments: ['indie_api'],
  assignedPodIds: ['pod-foundations'],
  pilots: [],
  checkpoints: [],
  domainForecasts: { code: { low: 42, expected: 49, high: 55 } },
  confidence: 0.67,
  integratedMethods: ['dense_basics'],
  dataManifestId: MANIFEST.id,
}

function rivalContract(state: SimState, rivalId: string): ComputeContract {
  return {
    id: `contract-${rivalId}`,
    providerId: 'cloud-meridian',
    providerName: 'Meridian Cloud',
    buyerLabId: rivalId,
    kind: 'reserved',
    regionId: 'global-cloud',
    pf: 18,
    pricePerPfDay: 350,
    daysLeft: 90,
    daysTotal: 90,
    interruptionRisk: 0,
    terminationFee: 12_000,
    status: 'active',
    signedDay: state.day,
  }
}

function playerCanonicalContract(state: SimState): ComputeContract {
  return {
    id: 'contract-canonical-player',
    providerId: 'cloud-meridian',
    providerName: 'Meridian Cloud',
    buyerLabId: state.playerLabId,
    kind: 'reserved',
    regionId: 'global-cloud',
    pf: 2,
    pricePerPfDay: 320,
    daysLeft: 30,
    daysTotal: 30,
    interruptionRisk: 0,
    terminationFee: 2_000,
    status: 'active',
    signedDay: state.day,
  }
}

describe('canonical lab v4 synchronization', () => {
  it('preserves direct canonical fields through a full tick and save round trip', () => {
    let state = createGame(9_400)
    const playerId = state.playerLabId
    const rivalId = state.rivals[0]!.id
    const playerLab = state.labs[playerId]!
    const rivalLab = state.labs[rivalId]!
    const contract = playerCanonicalContract(state)
    const playerLead = {
      ...playerLab.researchLeads![0]!,
      name: 'Canonical Systems Lead',
    }
    const playerPod = {
      ...playerLab.researchPods![0]!,
      name: 'Canonical Systems Pod',
    }
    const canonicalDataset = { ...DATASET, id: 'dataset-canonical-authority' }
    const canonicalManifest = {
      ...MANIFEST,
      id: 'manifest-canonical-authority',
      assetIds: [canonicalDataset.id],
    }
    const canonicalResearch = { ...RESEARCH_PROGRAM, id: 'research-canonical-authority' }
    const canonicalTraining = {
      ...TRAINING_PROGRAM,
      id: 'training-canonical-authority',
      dataManifestId: canonicalManifest.id,
    }

    state = {
      ...state,
      labs: {
        ...state.labs,
        [playerId]: {
          ...playerLab,
          capital: { ...playerLab.capital!, investorConfidence: 0.913579 },
          computeContracts: [...(playerLab.computeContracts ?? []), contract],
          researchLeads: [playerLead, ...playerLab.researchLeads!.slice(1)],
          researchPods: [playerPod, ...playerLab.researchPods!.slice(1)],
          researchPrograms: [canonicalResearch],
          trainingPrograms: [canonicalTraining],
          data: {
            ...playerLab.data,
            assets: [...playerLab.data.assets, canonicalDataset],
            manifests: [...playerLab.data.manifests, canonicalManifest],
          },
        },
        [rivalId]: {
          ...rivalLab,
          capital: { ...rivalLab.capital!, investorConfidence: 0.812345 },
          researchPrograms: [{ ...canonicalResearch, id: 'research-canonical-rival' }],
          data: {
            ...rivalLab.data,
            assets: [...rivalLab.data.assets, { ...canonicalDataset, id: 'dataset-canonical-rival' }],
          },
        },
      },
    }

    const ticked = tickDay(state)
    const canonicalPlayer = getLab(ticked, playerId)
    const canonicalRival = getLab(ticked, rivalId)

    expect(canonicalPlayer.capital?.investorConfidence).toBeGreaterThan(0.9)
    expect(canonicalPlayer.computeContracts?.some((item) => item.id === contract.id)).toBe(true)
    expect(canonicalPlayer.researchLeads?.[0]?.name).toBe('Canonical Systems Lead')
    expect(canonicalPlayer.researchPods?.[0]?.name).toBe('Canonical Systems Pod')
    expect(canonicalPlayer.researchPrograms?.some((item) => item.id === canonicalResearch.id)).toBe(true)
    expect(canonicalPlayer.trainingPrograms?.some((item) => item.id === canonicalTraining.id)).toBe(true)
    expect(canonicalPlayer.data.assets.some((asset) => asset.id === canonicalDataset.id)).toBe(true)
    expect(canonicalRival.capital?.investorConfidence).toBeGreaterThan(0.8)
    expect(canonicalRival.researchPrograms?.some((item) => item.id === 'research-canonical-rival')).toBe(true)
    expect(canonicalRival.data.assets.some((asset) => asset.id === 'dataset-canonical-rival')).toBe(true)

    // The compatibility views are projections of the agreed canonical fields.
    expect(ticked.player.researchLeads?.[0]?.name).toBe('Canonical Systems Lead')
    expect(ticked.player.data.assets.some((asset) => asset.id === canonicalDataset.id)).toBe(true)
    expect(ticked.computeContracts.some((item) => item.id === contract.id)).toBe(true)

    const restored = roundTripState(ticked)
    const restoredPlayer = getLab(restored, playerId)
    const restoredRival = getLab(restored, rivalId)
    expect(restoredPlayer.capital).toEqual(canonicalPlayer.capital)
    expect(restoredPlayer.computeContracts?.some((item) => item.id === contract.id)).toBe(true)
    expect(restoredPlayer.researchPrograms?.some((item) => item.id === canonicalResearch.id)).toBe(true)
    expect(restoredPlayer.trainingPrograms?.some((item) => item.id === canonicalTraining.id)).toBe(true)
    expect(restoredPlayer.data.assets.some((asset) => asset.id === canonicalDataset.id)).toBe(true)
    expect(restoredRival.data.assets.some((asset) => asset.id === 'dataset-canonical-rival')).toBe(true)
  })

  it('imports compatibility-owned actions back into canonical fields before ticking', () => {
    let state = createGame(9_403)
    const playerId = state.playerLabId
    const contract = playerCanonicalContract(state)
    const compatibilityDataset = { ...DATASET, id: 'dataset-compatibility-action' }
    const compatibilityResearch = { ...RESEARCH_PROGRAM, id: 'research-compatibility-action' }
    const compatibilityTraining = {
      ...TRAINING_PROGRAM,
      id: 'training-compatibility-action',
    }
    state = {
      ...state,
      computeContracts: [...state.computeContracts, contract],
      player: {
        ...state.player,
        capital: { ...state.player.capital!, investorConfidence: 0.876543 },
        researchLeads: state.player.researchLeads?.map((lead, index) =>
          index === 0 ? { ...lead, name: 'Compatibility Lead' } : lead,
        ),
        researchPrograms: [compatibilityResearch],
        trainingPrograms: [compatibilityTraining],
        data: {
          ...state.player.data,
          assets: [...state.player.data.assets, compatibilityDataset],
        },
      },
    }

    state = tickDay(state)
    const canonical = getLab(state, playerId)
    expect(canonical.capital?.investorConfidence).toBeGreaterThan(0.87)
    expect(canonical.computeContracts?.some((item) => item.id === contract.id)).toBe(true)
    expect(canonical.researchLeads?.[0]?.name).toBe('Compatibility Lead')
    expect(canonical.researchPrograms?.some((item) => item.id === compatibilityResearch.id)).toBe(true)
    expect(canonical.trainingPrograms?.some((item) => item.id === compatibilityTraining.id)).toBe(true)
    expect(canonical.data.assets.some((asset) => asset.id === compatibilityDataset.id)).toBe(true)
  })

  it('round-trips player capital, contracts, programs, and canonical datasets', () => {
    let state = createGame(9401)
    const rivalOnly = rivalContract(state, state.rivals[0]!.id)
    const capital = {
      ...state.player.capital!,
      investorConfidence: 0.91,
    }
    state = {
      ...state,
      computeContracts: [...state.computeContracts, rivalOnly],
      player: {
        ...state.player,
        capital,
        // Deliberately stale: the top-level contract book is authoritative.
        computeContracts: [],
        researchPrograms: [RESEARCH_PROGRAM],
        trainingPrograms: [TRAINING_PROGRAM],
        data: {
          ...state.player.data,
          assets: [DATASET],
          manifests: [MANIFEST],
        },
      },
    }

    state = syncLabIndex(state)
    const canonical = getLab(state, state.playerLabId)
    expect(canonical.capital).toEqual(capital)
    expect(canonical.computeContracts?.map((contract) => contract.id)).toEqual([
      'cloud-launch-contract',
    ])
    expect(canonical.researchLeads).toEqual(state.player.researchLeads)
    expect(canonical.researchPods).toEqual(state.player.researchPods)
    expect(canonical.researchPrograms).toEqual([RESEARCH_PROGRAM])
    expect(canonical.trainingPrograms).toEqual([TRAINING_PROGRAM])
    expect(canonical.data.assets).toEqual([DATASET])
    expect(canonical.data.manifests).toEqual([MANIFEST])

    state = updateLab(state, state.playerLabId, (lab) => ({
      ...lab,
      capital: { ...lab.capital!, boardPressure: 0.44 },
      researchPrograms: lab.researchPrograms!.map((program) => ({
        ...program,
        phase: 'validation',
      })),
      trainingPrograms: lab.trainingPrograms!.map((program) => ({
        ...program,
        confidence: 0.8,
      })),
      data: {
        ...lab.data,
        assets: lab.data.assets.map((asset) => ({ ...asset, quality: 0.97 })),
        manifests: lab.data.manifests.map((manifest) => ({
          ...manifest,
          effectiveQuality: 0.95,
        })),
      },
      computeContracts: lab.computeContracts!.map((contract) => ({
        ...contract,
        pricePerPfDay: contract.pricePerPfDay + 7,
      })),
    }))

    expect(state.player.capital?.boardPressure).toBe(0.44)
    expect(state.player.researchPrograms?.[0]?.phase).toBe('validation')
    expect(state.player.trainingPrograms?.[0]?.confidence).toBe(0.8)
    expect(state.player.data.assets[0]?.quality).toBe(0.97)
    expect(state.player.data.manifests[0]?.effectiveQuality).toBe(0.95)
    expect(state.computeContracts).toHaveLength(2)
    expect(state.computeContracts.find((contract) => contract.id === rivalOnly.id)).toEqual(rivalOnly)
    expect(new Set(state.computeContracts.map((contract) => contract.id)).size).toBe(2)

    const resynced = syncLabIndex(state)
    expect(getLab(resynced, state.playerLabId).capital).toEqual(state.player.capital)
    expect(getLab(resynced, state.playerLabId).trainingPrograms).toEqual(
      state.player.trainingPrograms,
    )
    expect(getLab(resynced, state.playerLabId).data).toEqual(state.player.data)
  })

  it('round-trips the same v4 collections for rivals without dropping other contracts', () => {
    let state = createGame(9402)
    const original = state.rivals[0]!
    const contract = rivalContract(state, original.id)
    const capital = {
      ...state.player.capital!,
      investorConfidence: 0.57,
    }
    const data = {
      ...original.data!,
      assets: [DATASET],
      manifests: [MANIFEST],
    }
    state = {
      ...state,
      computeContracts: [...state.computeContracts, contract],
      rivals: state.rivals.map((rival) =>
        rival.id === original.id
          ? {
              ...rival,
              capital,
              computeContracts: [],
              researchLeads: state.player.researchLeads,
              researchPods: state.player.researchPods,
              researchPrograms: [RESEARCH_PROGRAM],
              trainingPrograms: [TRAINING_PROGRAM],
              data,
            }
          : rival,
      ),
    }

    state = syncLabIndex(state)
    const canonical = getLab(state, original.id)
    expect(canonical.capital).toEqual(capital)
    expect(canonical.computeContracts).toEqual([contract])
    expect(canonical.researchLeads).toEqual(state.player.researchLeads)
    expect(canonical.researchPods).toEqual(state.player.researchPods)
    expect(canonical.researchPrograms).toEqual([RESEARCH_PROGRAM])
    expect(canonical.trainingPrograms).toEqual([TRAINING_PROGRAM])
    expect(canonical.data.assets).toEqual([DATASET])
    expect(canonical.data.manifests).toEqual([MANIFEST])

    state = updateLab(state, original.id, (lab) => ({
      ...lab,
      capital: { ...lab.capital!, boardPressure: 0.31 },
      researchPrograms: lab.researchPrograms!.map((program) => ({
        ...program,
        engineeringProgress: 0.75,
      })),
      trainingPrograms: lab.trainingPrograms!.map((program) => ({
        ...program,
        confidence: 0.76,
      })),
      data: {
        ...lab.data,
        manifests: lab.data.manifests.map((manifest) => ({
          ...manifest,
          contaminationRisk: 0.02,
        })),
      },
      computeContracts: lab.computeContracts!.map((item) => ({
        ...item,
        pricePerPfDay: 333,
      })),
    }))

    const rival = state.rivals.find((candidate) => candidate.id === original.id)!
    expect(rival.capital?.boardPressure).toBe(0.31)
    expect(rival.researchPrograms?.[0]?.engineeringProgress).toBe(0.75)
    expect(rival.trainingPrograms?.[0]?.confidence).toBe(0.76)
    expect(rival.data?.manifests[0]?.contaminationRisk).toBe(0.02)
    expect(state.computeContracts.find((item) => item.id === contract.id)?.pricePerPfDay).toBe(333)
    expect(state.computeContracts.find((item) => item.id === 'cloud-launch-contract')).toBeDefined()
    expect(new Set(state.computeContracts.map((item) => item.id)).size).toBe(
      state.computeContracts.length,
    )

    const resynced = syncLabIndex(state)
    expect(getLab(resynced, original.id).capital).toEqual(rival.capital)
    expect(getLab(resynced, original.id).trainingPrograms).toEqual(rival.trainingPrograms)
    expect(getLab(resynced, original.id).data).toEqual(rival.data)
  })
})
