import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AUDIO_PREFERENCES,
  migrateUiPreferences,
  formatNegotiationTimestamp,
  partializeUiPreferences,
  powerNegotiationKey,
  reopenEndedNegotiation,
  useUiStore,
} from './uiStore'

describe('negotiation session persistence', () => {
  afterEach(() => {
    useUiStore.setState({ computeNegotiations: {}, powerNegotiations: {} })
  })

  it('retains compute conversations across navigation and isolates providers', () => {
    const first = 'provider-a'
    useUiStore.getState().updateComputeNegotiation(first, (current) => ({
      ...current,
      status: 'countered',
      failures: 2,
      contactAgainDay: 44,
      proposal: { capacity: 18, termDays: 120, offer: 97 },
      transcript: [...current.transcript, { side: 'player', text: 'Proposal A', day: 14, minute: 0 }],
    }))

    // Reading the store again models a panel unmount/remount; no component-local state participates.
    const remounted = useUiStore.getState().computeNegotiations[first]!
    expect(remounted).toMatchObject({ status: 'countered', failures: 2, contactAgainDay: 44 })
    expect(remounted.transcript).toHaveLength(1)
    expect(useUiStore.getState().computeNegotiations['provider-b']).toBeUndefined()

    useUiStore.getState().updateComputeNegotiation('provider-b', (current) => ({
      ...current,
      status: 'agreed',
      transcript: [{ side: 'provider', text: 'Separate thread', day: 14, minute: 0 }],
    }))
    expect(useUiStore.getState().computeNegotiations[first]!.transcript[0]!.text).toBe('Proposal A')
  })

  it('isolates power conversations by city and direction while preserving lock consequences', () => {
    const importKey = powerNegotiationKey('metro-1', 'import')
    const exportKey = powerNegotiationKey('metro-1', 'export')
    useUiStore.getState().updatePowerNegotiation(importKey, (current) => ({
      ...current,
      status: 'declined',
      failures: 3,
      contactAgainDay: 72,
      transcript: [{ side: 'provider', text: 'Talks paused', status: 'declined', day: 42, minute: 1 }],
    }))

    expect(useUiStore.getState().powerNegotiations[importKey]).toMatchObject({ failures: 3, contactAgainDay: 72 })
    expect(useUiStore.getState().powerNegotiations[exportKey]).toBeUndefined()
    expect(useUiStore.getState().powerNegotiations[powerNegotiationKey('metro-2', 'import')]).toBeUndefined()
  })

  it('keeps session conversations out of global UI localStorage preferences', () => {
    useUiStore.getState().updateComputeNegotiation('provider-a', (current) => ({ ...current, failures: 1 }))
    const partial = partializeUiPreferences(useUiStore.getState())
    expect(partial).not.toHaveProperty('computeNegotiations')
    expect(partial).not.toHaveProperty('powerNegotiations')
  })

  it('clears compute desk threads without touching power negotiations', () => {
    useUiStore.getState().updateComputeNegotiation('provider-a', (current) => ({
      ...current,
      status: 'signed',
      transcript: [{ side: 'provider', text: 'Contract active', day: 8, sequence: 0 }],
    }))
    useUiStore.getState().updatePowerNegotiation(powerNegotiationKey('metro-1', 'import'), (current) => ({
      ...current,
      failures: 2,
    }))
    useUiStore.getState().resetComputeNegotiations()
    expect(useUiStore.getState().computeNegotiations).toEqual({})
    expect(useUiStore.getState().powerNegotiations[powerNegotiationKey('metro-1', 'import')]).toMatchObject({
      failures: 2,
    })
  })

  it('reopens an ended signed desk while retaining its transcript', () => {
    const signed = {
      status: 'signed' as const,
      transcript: [{ side: 'provider' as const, text: 'Contract active', day: 8, sequence: 0 }],
      failures: 0,
      contactAgainDay: 0,
      proposal: { capacity: 12, termDays: 30, offer: 95 },
      message: 'Contract active',
    }
    expect(reopenEndedNegotiation(signed, true)).toBe(signed)
    expect(reopenEndedNegotiation(signed, false)).toMatchObject({
      status: 'idle',
      transcript: signed.transcript,
      message: undefined,
      proposal: undefined,
      failures: 0,
      contactAgainDay: 0,
    })
  })

  it('formats long retained threads as truthful day and sequence labels', () => {
    expect(formatNegotiationTimestamp({ day: 12, sequence: 190 }, 99, 0)).toBe('Day 12 · message 191')
    expect(formatNegotiationTimestamp({ day: 12, minute: 4 }, 99, 0)).toBe('Day 12 · message 5')
  })
})

describe('map camera UI preferences', () => {
  afterEach(() => {
    useUiStore.getState().resetMapCamera()
  })

  it('rotates, cycles tilt, and restores the standard view', () => {
    const store = useUiStore.getState()
    store.rotateMapCamera(-1)
    expect(useUiStore.getState().mapCameraHeading).toBe(3)
    store.cycleMapCameraTilt()
    expect(useUiStore.getState().mapCameraTilt).toBe('high')
    useUiStore.getState().resetMapCamera()
    expect(useUiStore.getState()).toMatchObject({
      mapCameraHeading: 0,
      mapCameraTilt: 'standard',
    })
  })
})

describe('cloud visibility UI preference', () => {
  afterEach(() => {
    useUiStore.setState({ cloudsVisible: true })
  })

  it('defaults to visible and toggles without changing navigation preferences', () => {
    const initial = useUiStore.getState()
    expect(initial.cloudsVisible).toBe(true)

    initial.toggleClouds()

    expect(useUiStore.getState()).toMatchObject({
      cloudsVisible: false,
      mapCameraHeading: initial.mapCameraHeading,
      mapCameraTilt: initial.mapCameraTilt,
    })
  })

  it('persists the preference and defaults legacy persisted state to visible', async () => {
    expect(partializeUiPreferences({ ...useUiStore.getState(), cloudsVisible: false })).toMatchObject({
      cloudsVisible: false,
    })
    expect(migrateUiPreferences({ renderPreset: 'quality' })).toMatchObject({
      renderPreset: 'quality',
      cloudsVisible: true,
    })
    expect(migrateUiPreferences({ cloudsVisible: false })).toMatchObject({
      cloudsVisible: false,
    })
  })
})

describe('audio UI preferences', () => {
  it('adds safe audio defaults to legacy persisted state', () => {
    expect(migrateUiPreferences({ renderPreset: 'quality', reducedMotion: true })).toMatchObject({
      renderPreset: 'quality',
      reducedMotion: true,
      ...DEFAULT_AUDIO_PREFERENCES,
    })
  })

  it('preserves valid values and clamps damaged persisted volumes', () => {
    expect(migrateUiPreferences({
      audioMuted: true,
      masterVolume: 0.45,
      musicVolume: -2,
      effectsVolume: 3,
    })).toMatchObject({
      audioMuted: true,
      masterVolume: 0.45,
      musicVolume: 0,
      effectsVolume: 1,
    })
    expect(migrateUiPreferences({
      audioMuted: 'yes',
      masterVolume: Number.NaN,
      musicVolume: '0.5',
      effectsVolume: Number.POSITIVE_INFINITY,
    })).toMatchObject(DEFAULT_AUDIO_PREFERENCES)
  })

  it('persists audio preferences with the existing visual preferences', () => {
    const partial = partializeUiPreferences({
      ...useUiStore.getState(),
      audioMuted: true,
      masterVolume: 0.6,
      musicVolume: 0.4,
      effectsVolume: 0.2,
    })
    expect(partial).toMatchObject({
      audioMuted: true,
      masterVolume: 0.6,
      musicVolume: 0.4,
      effectsVolume: 0.2,
    })
    expect(partial).not.toHaveProperty('toast')
    expect(partial).not.toHaveProperty('confirmRequest')
  })
})
