import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AUDIO_PREFERENCES,
  migrateUiPreferences,
  partializeUiPreferences,
  useUiStore,
} from './uiStore'

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
