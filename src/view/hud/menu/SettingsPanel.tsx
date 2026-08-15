import { useId, useState, type ReactNode } from 'react'
import {
  ArrowsOut,
  Cloud,
  CurrencyDollar,
  Eye,
  GameController,
  Monitor,
  SpeakerHigh,
  SpeakerSlash,
} from '@phosphor-icons/react'
import type { CampaignRules } from '../../../sim/types'
import type { InstantCheatAction } from '../../../sim/systems/cheats'
import {
  RENDER_PRESETS,
  type InterfaceScale,
  type RenderPreset,
  useResolvedUiScale,
  useUiStore,
} from '../../../store/uiStore'
import { money } from '../format'
import { parseCheatMoneyAmount } from './cheatMoney'

export type SettingsCategory = 'interface' | 'video' | 'audio' | 'gameplay' | 'cheats'

const INTERFACE_SCALE_OPTIONS: ReadonlyArray<{
  value: InterfaceScale
  label: string
}> = [
  { value: 'auto', label: 'Auto' },
  { value: 0.8, label: '80%' },
  { value: 0.9, label: '90%' },
  { value: 1, label: '100%' },
  { value: 1.1, label: '110%' },
  { value: 1.25, label: '125%' },
  { value: 1.5, label: '150%' },
]

export interface GameplaySettingsContext {
  autoPause: CampaignRules['autoPause']
  setAutoPause: (key: keyof CampaignRules['autoPause'], enabled: boolean) => void
  onboardingDismissed: boolean
  setOnboardingDismissed: (dismissed: boolean) => void
}

export interface CheatSettingsContext {
  cash: number
  adjustMoney: (delta: number) => boolean
  runInstantAction: (action: InstantCheatAction) => number
}

export function SettingsPanel({ gameplay, cheats }: { gameplay?: GameplaySettingsContext; cheats?: CheatSettingsContext }) {
  const [category, setCategory] = useState<SettingsCategory>('interface')
  const categories: Array<{ id: SettingsCategory; label: string }> = [
    { id: 'interface', label: 'Interface' },
    { id: 'video', label: 'Video' },
    { id: 'audio', label: 'Audio' },
    ...(gameplay ? [{ id: 'gameplay' as const, label: 'Gameplay' }] : []),
    ...(cheats ? [{ id: 'cheats' as const, label: 'Cheats' }] : []),
  ]

  return (
    <div className="settings-panel mt-5 grid min-h-0 gap-4 md:grid-cols-[9rem_minmax(0,1fr)]">
      <div
        role="tablist"
        aria-label="Settings categories"
        className="grid grid-cols-3 gap-1 border border-line/80 bg-void/45 p-1 md:block md:space-y-1"
      >
        {categories.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`settings-tab-${item.id}`}
            aria-controls={`settings-panel-${item.id}`}
            aria-selected={category === item.id}
            onClick={() => setCategory(item.id)}
            className={`min-h-10 w-full px-2.5 text-left text-[0.75rem] font-semibold transition ${
              category === item.id
                ? 'bg-mint/15 text-mint shadow-[inset_2px_0_0_#48d7d1]'
                : 'text-muted hover:bg-panel-2/70 hover:text-bone'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`settings-panel-${category}`}
        aria-labelledby={`settings-tab-${category}`}
        className="min-w-0"
      >
        {category === 'interface' && <InterfaceSettings />}
        {category === 'video' && <VideoSettings />}
        {category === 'audio' && <AudioSettings />}
        {category === 'gameplay' && gameplay ? <GameplaySettings gameplay={gameplay} /> : null}
        {category === 'cheats' && cheats ? <CheatSettings cheats={cheats} /> : null}
      </div>
    </div>
  )
}

function InterfaceSettings() {
  const interfaceScale = useUiStore((state) => state.interfaceScale)
  const setInterfaceScale = useUiStore((state) => state.setInterfaceScale)
  const reducedMotion = useUiStore((state) => state.reducedMotion)
  const setReducedMotion = useUiStore((state) => state.setReducedMotion)
  const resolvedScale = useResolvedUiScale()

  return (
    <div className="space-y-3">
      <SettingCard icon={<Monitor size="1.15rem" />} title="Interface scale" description="Auto follows display height without enlarging controls on ultrawide screens.">
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="grid flex-1 grid-cols-4 gap-1.5">
            {INTERFACE_SCALE_OPTIONS.map((option) => (
              <button
                key={String(option.value)}
                type="button"
                aria-pressed={interfaceScale === option.value}
                onClick={() => setInterfaceScale(option.value)}
                className={`min-h-10 border px-2 font-mono text-[0.6875rem] transition ${
                  interfaceScale === option.value
                    ? 'border-mint/50 bg-mint/15 text-mint'
                    : 'border-line bg-void/35 text-muted hover:text-bone'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="status-chip status-chip--positive shrink-0">{Math.round(resolvedScale * 100)}%</span>
        </div>
      </SettingCard>

      <button
        type="button"
        aria-pressed={reducedMotion}
        onClick={() => setReducedMotion(!reducedMotion)}
        className="flex min-h-14 w-full items-center gap-3 border border-line/70 bg-panel-2/70 p-3.5 text-left hover:border-mint/30"
      >
        <ArrowsOut size="1.15rem" className="shrink-0 text-mint" />
        <span className="min-w-0 flex-1">
          <strong className="block text-[0.875rem] text-bone">Reduce interface motion</strong>
          <span className="mt-1 block text-[0.75rem] text-muted">Remove panel transitions and animated status changes.</span>
        </span>
        <span className={`status-chip ${reducedMotion ? 'status-chip--positive' : ''}`}>{reducedMotion ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}

function VideoSettings() {
  const renderPreset = useUiStore((state) => state.renderPreset)
  const setRenderPreset = useUiStore((state) => state.setRenderPreset)
  const cloudsVisible = useUiStore((state) => state.cloudsVisible)
  const toggleClouds = useUiStore((state) => state.toggleClouds)

  return (
    <div className="space-y-3">
      <SettingCard icon={<Monitor size="1.15rem" />} title="Render preset" description="Pixel ratio, decorative traffic, and level-of-detail transition timing.">
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {([['performance', 'Performance'], ['balanced', 'Balanced'], ['quality', 'Quality']] as const).map(([id, label]) => {
            const preset = RENDER_PRESETS[id as RenderPreset]
            return (
              <button
                key={id}
                type="button"
                aria-pressed={renderPreset === id}
                onClick={() => setRenderPreset(id)}
                className={`min-h-14 border px-2 py-2 text-left transition ${
                  renderPreset === id
                    ? 'border-mint/50 bg-mint/15 text-mint'
                    : 'border-line bg-void/35 text-muted hover:text-bone'
                }`}
              >
                <strong className="block text-[0.75rem]">{label}</strong>
                <span className="mt-1 block font-mono text-[0.5625rem] tabular-nums opacity-80">
                  {preset.pixelRatio}× · {preset.decorativeTraffic ? 'traffic' : 'no traffic'}
                </span>
              </button>
            )
          })}
        </div>
      </SettingCard>

      <button
        type="button"
        aria-pressed={cloudsVisible}
        onClick={toggleClouds}
        className="flex min-h-14 w-full items-center gap-3 border border-line/70 bg-panel-2/70 p-3.5 text-left hover:border-mint/30"
      >
        <Cloud size="1.15rem" weight={cloudsVisible ? 'fill' : 'duotone'} className="shrink-0 text-mint" />
        <span className="min-w-0 flex-1">
          <strong className="block text-[0.875rem] text-bone">World clouds</strong>
          <span className="mt-1 block text-[0.75rem] text-muted">Show the decorative cloud layer above the game map.</span>
        </span>
        <span className={`status-chip ${cloudsVisible ? 'status-chip--positive' : ''}`}>{cloudsVisible ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}

function AudioSettings() {
  const muted = useUiStore((state) => state.audioMuted)
  const setMuted = useUiStore((state) => state.setAudioMuted)
  const values = {
    master: useUiStore((state) => state.masterVolume),
    music: useUiStore((state) => state.musicVolume),
    effects: useUiStore((state) => state.effectsVolume),
  }
  const setters = {
    master: useUiStore((state) => state.setMasterVolume),
    music: useUiStore((state) => state.setMusicVolume),
    effects: useUiStore((state) => state.setEffectsVolume),
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        aria-pressed={muted}
        onClick={() => setMuted(!muted)}
        className="flex min-h-14 w-full items-center gap-3 border border-line/70 bg-panel-2/70 p-3.5 text-left hover:border-mint/30"
      >
        {muted ? <SpeakerSlash size="1.15rem" className="text-mint" /> : <SpeakerHigh size="1.15rem" className="text-mint" />}
        <span className="min-w-0 flex-1">
          <strong className="block text-[0.875rem] text-bone">Mute all audio</strong>
          <span className="mt-1 block text-[0.75rem] text-muted">Keep individual channel levels while silencing playback.</span>
        </span>
        <span className={`status-chip ${muted ? 'status-chip--positive' : ''}`}>{muted ? 'Muted' : 'On'}</span>
      </button>
      <SettingCard icon={<SpeakerHigh size="1.15rem" />} title="Volume levels" description="Saved globally for music and interface effects.">
        <div className="mt-3 space-y-3">
          {(['master', 'music', 'effects'] as const).map((channel) => (
            <VolumeControl
              key={channel}
              label={channel === 'master' ? 'Master' : channel === 'music' ? 'Music' : 'Effects'}
              value={values[channel]}
              onChange={setters[channel]}
            />
          ))}
        </div>
      </SettingCard>
    </div>
  )
}

function VolumeControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const id = useId()
  const outputId = `${id}-value`
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-[0.75rem] font-medium text-bone">{label}</label>
        <output id={outputId} htmlFor={id} className="font-mono text-[0.6875rem] tabular-nums text-muted">{Math.round(value * 100)}%</output>
      </div>
      <input
        id={id}
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={value}
        aria-describedby={outputId}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="w-full accent-mint"
      />
    </div>
  )
}

function GameplaySettings({ gameplay }: { gameplay: GameplaySettingsContext }) {
  return (
    <div className="space-y-3">
      <SettingCard icon={<GameController size="1.15rem" />} title="Simulation auto-pause" description="Choose the events that interrupt simulation time.">
        <div className="mt-3 space-y-1.5">
          {([
            ['projectComplete', 'Project completion', 'Construction, research, or model projects finish.'],
            ['majorEvent', 'Major world event', 'A new industry event begins.'],
            ['quarterlyReport', 'Quarterly review', 'A scheduled company review is ready.'],
            ['runwayEmergency', 'Runway emergency', 'Cash runway falls below 60 days.'],
          ] as const).map(([key, label, description]) => {
            const enabled = gameplay.autoPause[key]
            return (
              <button
                key={key}
                type="button"
                aria-pressed={enabled}
                onClick={() => gameplay.setAutoPause(key, !enabled)}
                className="flex min-h-12 w-full items-center gap-3 border border-line/60 bg-void/35 px-2.5 py-2 text-left hover:border-mint/30"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.8125rem] text-bone">{label}</span>
                  <span className="mt-0.5 block text-[0.6875rem] text-muted">{description}</span>
                </span>
                <span className={`status-chip ${enabled ? 'status-chip--positive' : ''}`}>{enabled ? 'On' : 'Off'}</span>
              </button>
            )
          })}
        </div>
      </SettingCard>

      <button
        type="button"
        aria-pressed={!gameplay.onboardingDismissed}
        onClick={() => gameplay.setOnboardingDismissed(!gameplay.onboardingDismissed)}
        className="flex min-h-14 w-full items-center gap-3 border border-line/70 bg-panel-2/70 p-3.5 text-left hover:border-mint/30"
      >
        <Eye size="1.15rem" className="shrink-0 text-mint" />
        <span className="min-w-0 flex-1">
          <strong className="block text-[0.875rem] text-bone">Starter objectives</strong>
          <span className="mt-1 block text-[0.75rem] text-muted">Show the guided launch sequence in mission control.</span>
        </span>
        <span className={`status-chip ${!gameplay.onboardingDismissed ? 'status-chip--positive' : ''}`}>
          {gameplay.onboardingDismissed ? 'Hidden' : 'Visible'}
        </span>
      </button>
    </div>
  )
}

function CheatSettings({ cheats }: { cheats: CheatSettingsContext }) {
  const inputId = useId()
  const feedbackId = `${inputId}-feedback`
  const [value, setValue] = useState('')
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)

  const apply = (direction: 1 | -1) => {
    const amount = parseCheatMoneyAmount(value)
    if (amount == null) {
      setFeedback({ text: 'Enter a positive, finite money amount.', error: true })
      return
    }
    if (!cheats.adjustMoney(direction * amount)) {
      setFeedback({ text: 'That amount cannot be applied.', error: true })
      return
    }
    setFeedback({
      text: `${direction > 0 ? 'Added' : 'Removed'} ${money(amount)}.`,
      error: false,
    })
    setValue('')
  }

  const runInstant = (action: InstantCheatAction, label: string) => {
    const affected = cheats.runInstantAction(action)
    setFeedback({
      text: affected > 0 ? `${label}: ${affected} completed.` : `${label}: nothing is currently in progress.`,
      error: false,
    })
  }

  return (
    <div className="space-y-3">
      <SettingCard
        icon={<CurrencyDollar size="1.15rem" />}
        title="Money"
        description="Add money to this campaign or remove it. Removing more than the balance sets cash to zero."
      >
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-[0.75rem]">
            <label htmlFor={inputId} className="font-medium text-bone">Amount</label>
            <span className="font-mono tabular-nums text-muted">Balance {money(cheats.cash)}</span>
          </div>
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={value}
            aria-invalid={feedback?.error ?? false}
            aria-describedby={feedback ? feedbackId : undefined}
            onChange={(event) => {
              setValue(event.currentTarget.value)
              setFeedback(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') apply(1)
            }}
            placeholder="e.g. 1000000"
            className={`w-full border bg-void/50 px-2.5 py-2 font-mono text-[0.8125rem] text-bone outline-none ${
              feedback?.error ? 'border-danger' : 'border-line focus:border-mint/50'
            }`}
          />
          {feedback ? (
            <p id={feedbackId} role={feedback.error ? 'alert' : 'status'} className={`mt-1.5 text-[0.6875rem] ${feedback.error ? 'text-danger' : 'text-mint'}`}>
              {feedback.text}
            </p>
          ) : null}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" className="hud-button hud-button--secondary" onClick={() => apply(-1)}>Remove money</button>
            <button type="button" className="hud-button hud-button--primary" onClick={() => apply(1)}>Add money</button>
          </div>
        </div>
      </SettingCard>
      <SettingCard
        icon={<ArrowsOut size="1.15rem" />}
        title="Instant actions"
        description="Complete current work immediately while preserving its normal finished state and follow-up decisions."
      >
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {([
            ['construction', 'Finish construction'],
            ['research', 'Complete research'],
            ['training', 'Complete training'],
            ['rackDelivery', 'Deliver rack orders'],
          ] as const).map(([action, label]) => (
            <button
              key={action}
              type="button"
              className="hud-button hud-button--secondary min-h-11"
              onClick={() => runInstant(action, label)}
            >
              {label}
            </button>
          ))}
        </div>
      </SettingCard>
    </div>
  )
}

function SettingCard({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="border border-line/70 bg-panel-2/70 p-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-mint">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[0.875rem] font-semibold text-bone">{title}</h3>
          <p className="mt-1 text-[0.75rem] leading-snug text-muted">{description}</p>
          {children}
        </div>
      </div>
    </section>
  )
}
