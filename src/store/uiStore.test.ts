import { afterEach, describe, expect, it } from 'vitest'
import { migrateUiPreferences, partializeUiPreferences, useUiStore } from './uiStore'

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
