import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  buildGameConfig,
  DIFFICULTY_PRESETS,
  MAX_CITY_COUNT,
  MAX_MAP_DIMENSION,
  MIN_CITY_COUNT,
  MIN_MAP_DIMENSION,
  type AdvancedOverrides,
  type CompanyMarkId,
  type DifficultyId,
} from '../../sim/balance/gameConfig'
import { ECONOMY } from '../../sim/balance/economy'
import { defaultCampaignRules } from '../../sim/campaign'
import { MANUAL_SLOTS, type SaveSlotId } from '../../sim/save'
import { useGameStore } from '../../store/gameStore'
import { money } from './format'
import { formatLastPlayed } from './menuTime'
import { useUiStore } from '../../store/uiStore'
import { FeedPost } from './ui/FeedPost'
import { LablineMenuShell } from './menu/LablineMenuShell'
import { SettingsPanel } from './menu/SettingsPanel'
import {
  ArrowRight,
  ArrowLeft,
  Database,
  DiceFive,
  GearSix,
  GlobeHemisphereWest,
  Lock,
  Newspaper,
  Play,
  Plus,
  Question,
  WarningCircle,
} from '@phosphor-icons/react'

type ScenarioId = DifficultyId | 'custom'

const SCENARIOS: { id: ScenarioId; label: string; blurb: string }[] = [
  {
    id: 'easy',
    label: 'Easy',
    blurb: '40% more runway, lower build and research costs, and four slower rivals.',
  },
  {
    id: 'normal',
    label: 'Normal',
    blurb: 'Balanced rivals on the 300×300 frontier.',
  },
  {
    id: 'hard',
    label: 'Hard',
    blurb: '25% less runway, higher build and research costs, and sharper rivals.',
  },
  {
    id: 'custom',
    label: 'Custom',
    blurb: 'Tune world size, markets, costs, research and capital.',
  },
]

type MenuTab = 'home' | 'new' | 'load' | 'news' | 'settings'
type NewGameStep = 0 | 1 | 2

const MENU_NEWS_POSTS = [
  {
    source: 'Labline Ops', timeLabel: 'Roads 0.6', tone: 'positive' as const,
    title: 'Street generation pass shipped',
    detail: 'Road furniture now sits on verges, junctions use seeded signals, and zebra crossings span eligible approaches.',
  },
  {
    source: 'World Systems', timeLabel: 'Generator V6.3', tone: 'research' as const,
    title: 'Neighborhood loops opened',
    detail: 'New worlds reject street branches that collide with existing roads and open short local-road cycles.',
  },
  {
    source: 'Interface', timeLabel: 'Menu', tone: 'serve' as const,
    title: 'Sandbox setup now uses steps',
    detail: 'Identity, market controls, and launch review each fit into a compact screen without scrolling.',
  },
  {
    source: 'Simulation', timeLabel: 'Systems', tone: 'warning' as const,
    title: 'Larger living worlds',
    detail: 'Expanded maps, city statistics, municipal power, traffic, and suburban growth now share one world model.',
  },
] as const

const COMPANY_MARKS: { id: CompanyMarkId; label: string }[] = [
  { id: 'orbit', label: 'Orbit' },
  { id: 'delta', label: 'Delta' },
  { id: 'prism', label: 'Prism' },
  { id: 'hex', label: 'Hex' },
  { id: 'spire', label: 'Spire' },
  { id: 'grid', label: 'Grid' },
  { id: 'nexus', label: 'Nexus' },
  { id: 'wave', label: 'Wave' },
  { id: 'core', label: 'Core' },
]

const COMPANY_NAME_PREFIXES = [
  'Arc',
  'Beacon',
  'Copper',
  'Helix',
  'Kestrel',
  'Lattice',
  'Morrow',
  'Northstar',
  'Parallax',
  'Signal',
  'Vector',
] as const

const COMPANY_NAME_SUFFIXES = [
  'Compute',
  'Dynamics',
  'Foundry',
  'Frontier',
  'Intelligence',
  'Labs',
  'Research',
  'Systems',
  'Works',
] as const

// Save discovery can remount the menu in development and during storage
// recovery. Keep explicit navigation authoritative for the whole page session,
// not merely for one component instance.
let explicitMenuTabSelected = false

export function NewGameMenu() {
  const startGame = useGameStore((s) => s.startGame)
  const continueGame = useGameStore((s) => s.continueGame)
  const loadGame = useGameStore((s) => s.loadGame)
  const deleteSave = useGameStore((s) => s.deleteSave)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  const saves = useGameStore((s) => s.saveSlots)
  const storageReady = useGameStore((s) => s.storageReady)
  const lifecycleError = useGameStore((s) => s.lifecycleError)
  const clearLifecycleError = useGameStore((s) => s.clearLifecycleError)
  const requestConfirm = useUiStore((s) => s.requestConfirm)

  const [tab, setTab] = useState<MenuTab>('home')
  const [status, setStatus] = useState<string | null>(null)
  const [problemSlot, setProblemSlot] = useState<SaveSlotId | null>(null)
  /** Bump after delete so slot list re-reads localStorage */
  const [savesTick, setSavesTick] = useState(0)
  const [labName, setLabName] = useState('Labline')
  const [companyMark, setCompanyMark] = useState<CompanyMarkId>('orbit')
  const [difficulty, setDifficulty] = useState<DifficultyId>('normal')
  const [scenario, setScenario] = useState<ScenarioId>('normal')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [newGameStep, setNewGameStep] = useState<NewGameStep>(0)
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 99999))
  const [adv, setAdv] = useState<AdvancedOverrides>({})
  const initialTabResolved = useRef(false)

  useEffect(() => {
    void refreshSaves()
  }, [refreshSaves])

  const compatibleSaveCount = saves.filter((meta) => meta.compatible).length
  useEffect(() => {
    if (
      explicitMenuTabSelected ||
      initialTabResolved.current ||
      !storageReady ||
      saves.length === 0
    ) return
    initialTabResolved.current = true
    setTab('home')
  }, [compatibleSaveCount, saves.length, storageReady])

  const selectTab = (next: MenuTab) => {
    explicitMenuTabSelected = true
    initialTabResolved.current = true
    if (next === 'new') setNewGameStep(0)
    setTab(next)
  }

  // savesTick only forces local archive affordances to repaint after confirmation.
  void savesTick
  const bySlot = Object.fromEntries(saves.map((m) => [m.slotId, m])) as Partial<
    Record<SaveSlotId, (typeof saves)[0]>
  >
  const canContinue = compatibleSaveCount > 0
  const latestSave = saves.find((meta) => meta.compatible)
  const showNewsFeed = tab !== 'load' && tab !== 'new'

  const preview = useMemo(
    () =>
      buildGameConfig({
        labName,
        companyMark,
        difficulty,
        seed,
        advanced: scenario === 'custom' ? adv : undefined,
      }),
    [labName, companyMark, difficulty, seed, adv, scenario],
  )

  const setAdvField = <K extends keyof AdvancedOverrides>(k: K, v: AdvancedOverrides[K]) => {
    setScenario('custom')
    setAdv((a) => ({ ...a, [k]: v }))
  }

  const applyScenario = (next: ScenarioId) => {
    if (next === 'custom') {
      setScenario('custom')
      setAdv({
        mapWidth: preview.mapWidth,
        mapHeight: preview.mapHeight,
        cityCount: preview.cityCount,
        rivalCount: preview.rivalCount,
        economyMult: preview.economyMult,
        researchCostMult: preview.researchCostMult,
        startingCashMult: preview.startingCashMult,
        campaignRules: preview.campaignRules,
      })
      setShowAdvanced(true)
      return
    }
    setScenario(next)
    setDifficulty(next)
    setAdv(DIFFICULTY_PRESETS[next])
  }

  const randomizeCompanyName = () => {
    let next = labName
    for (let attempt = 0; attempt < 4 && next === labName; attempt += 1) {
      const prefix = COMPANY_NAME_PREFIXES[Math.floor(Math.random() * COMPANY_NAME_PREFIXES.length)]
      const suffix = COMPANY_NAME_SUFFIXES[Math.floor(Math.random() * COMPANY_NAME_SUFFIXES.length)]
      next = `${prefix} ${suffix}`
    }
    setLabName(next)
  }

  const randomizeCompanyMark = () => {
    const candidates = COMPANY_MARKS.filter((mark) => mark.id !== companyMark)
    const next = candidates[Math.floor(Math.random() * candidates.length)]
    if (next) setCompanyMark(next.id)
  }

  const onContinue = async () => {
    clearLifecycleError()
    setStatus(null)
    const r = await continueGame()
    if (!r.ok) setStatus(r.error)
  }

  const onLoad = async (slotId: SaveSlotId) => {
    clearLifecycleError()
    setStatus(null)
    const r = await loadGame(slotId)
    if (!r.ok) setStatus(r.error)
  }

  return (
    <LablineMenuShell
      variant="title"
      titleId="labline-main-title"
      contentClassName={`main-menu-console max-h-[calc(100dvh-11.5rem)] ${tab === 'new' ? 'main-menu-console--setup max-w-[64rem]' : 'max-w-[48rem]'}`}
      utilityNav={showNewsFeed ? (
        <aside className={`main-menu-news-feed overflow-hidden border bg-void/90 shadow-[0_22px_70px_rgba(0,8,12,.58)] backdrop-blur-xl ${tab === 'news' ? 'border-mint/55' : 'border-line/90'}`}>
          <header className="flex items-center gap-2.5 border-b border-line/70 px-3 py-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full border border-mint/45 bg-mint/10 font-mono text-xs font-semibold text-mint">L</span>
            <span className="min-w-0 flex-1"><strong className="block truncate text-[0.8125rem] text-bone">Labline News</strong><span className="block truncate font-mono text-[0.625rem] text-muted">@LablineOps · changelog</span></span>
            <span className="size-2 rounded-full bg-mint shadow-[0_0_10px_rgba(72,215,209,.7)]" title="Live feed" />
          </header>
          <div className="main-menu-news-posts">
            {MENU_NEWS_POSTS.slice(0, 3).map((post) => (
              <FeedPost
                key={post.title}
                source={post.source}
                timeLabel={post.timeLabel}
                tone={post.tone}
                className="main-menu-news-post"
                body={<><strong className="text-bone">{post.title}</strong><span className="mt-1 block text-muted">{post.detail}</span></>}
              />
            ))}
          </div>
          <button type="button" aria-current={tab === 'news' ? 'page' : undefined} onClick={() => selectTab('news')} className="group flex min-h-10 w-full items-center justify-between border-t border-line/70 px-3 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-mint hover:bg-mint/8">
            View full feed <ArrowRight size="0.9rem" className="transition-transform group-hover:translate-x-1" />
          </button>
        </aside>
      ) : undefined}
    >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-mint/80 via-mint/20 to-transparent" />
          <div className="main-menu-console-head border-b border-line/70 px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
            <div className="flex items-start justify-between gap-5">
              <div>
                <p className="font-mono text-[0.625rem] uppercase tracking-[0.22em] text-mint">
                  {tab === 'new'
                    ? 'New Sandbox'
                    : tab === 'load'
                      ? 'Saved Sandboxes'
                      : tab === 'news'
                        ? 'News / Changelog'
                        : tab === 'settings'
                          ? 'Settings'
                          : 'Command'}
                </p>
                <h2 className="mt-2 text-[2rem] font-semibold leading-none tracking-[-0.045em] text-bone">
                  {tab === 'new'
                    ? newGameStep === 0
                      ? 'Name your company'
                      : newGameStep === 1
                        ? 'Shape the market'
                        : 'Review your launch'
                    : tab === 'load'
                      ? 'Choose a save'
                      : tab === 'news'
                        ? 'What changed'
                        : tab === 'settings'
                          ? 'Preferences'
                          : 'Build the frontier'}
                </h2>
              </div>
              {tab === 'new' ? (
                <button
                  type="button"
                  onClick={() => newGameStep > 0 ? setNewGameStep((newGameStep - 1) as NewGameStep) : selectTab('home')}
                  aria-label={newGameStep > 0 ? 'Previous setup step' : 'Back to command'}
                  className="mt-0.5 grid size-11 shrink-0 place-items-center border border-line bg-void/65 text-mint transition-colors hover:border-mint/40 hover:text-bone"
                >
                  <ArrowLeft size="1.2rem" />
                </button>
              ) : (
                <span className="mt-0.5 grid size-11 shrink-0 place-items-center border border-line bg-void/65 text-mint">
                  {tab === 'load'
                    ? <Database size="1.35rem" weight="duotone" />
                    : tab === 'news'
                      ? <Newspaper size="1.35rem" weight="duotone" />
                      : tab === 'settings'
                        ? <GearSix size="1.35rem" weight="duotone" />
                        : <Play size="1.35rem" weight="duotone" />}
                </span>
              )}
            </div>
            <p className="mt-3 max-w-[58ch] text-[0.8125rem] leading-5 text-muted">
              {tab === 'home' && 'Continue, start fresh, or manage saves.'}
              {tab === 'new' && (
                newGameStep === 0
                  ? 'Choose the identity players and rivals will see.'
                  : newGameStep === 1
                    ? 'Select a scenario, then tune the world if needed.'
                    : 'Confirm the operation and begin on day one.'
              )}
              {tab === 'load' && 'Autosave plus eight manual slots.'}
              {tab === 'news' && 'Changelog posts and simulation notes.'}
              {tab === 'settings' && 'Interface, video, and audio preferences.'}
            </p>
          </div>

          <div className="main-menu-console-body px-5 pb-6 pt-4 sm:px-7 sm:pb-7">

        {(status ?? lifecycleError) && (
          <div role="alert" className="mb-4 flex gap-2.5 border border-danger/45 bg-danger/10 px-3 py-2.5 text-[0.8125rem] text-danger">
            <WarningCircle size="1rem" weight="fill" className="mt-0.5 shrink-0" />
            <span>
              <strong className="block font-semibold">Sandbox could not be opened</strong>
              <span className="mt-0.5 block text-bone/80">{status ?? lifecycleError}</span>
            </span>
          </div>
        )}

        {!storageReady && (
          <p className="mb-4 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            Reading saves…
          </p>
        )}

        {tab !== 'new' && (
          <nav
            aria-label="Main menu sections"
            className="grid grid-cols-3 border border-line/80 bg-void/50 p-1"
          >
            <TabChip active={tab === 'home'} onClick={() => selectTab('home')}>
              Command
            </TabChip>
            <TabChip active={tab === 'load'} onClick={() => selectTab('load')}>
              Saves
            </TabChip>
            <TabChip active={tab === 'settings'} onClick={() => selectTab('settings')}>
              Settings
            </TabChip>
          </nav>
        )}

        {tab === 'home' && (
          <div className="main-menu-actions mt-5 space-y-2.5">
            {canContinue && (
              <button type="button" className="main-menu-action main-menu-action--primary" onClick={() => void onContinue()}>
                <span className="grid size-10 shrink-0 place-items-center border border-mint/30 bg-void/30 text-mint">
                  <Play size="1.1rem" />
                </span>
                <span>
                  <strong>Continue Sandbox</strong>
                  <small>
                    Last played {latestSave ? formatLastPlayed(latestSave.savedAt) : 'recently'}
                    {latestSave ? ` · saved Day ${latestSave.day}${latestSave.campaignDate ? ` (${latestSave.campaignDate})` : ''}` : ''}
                  </small>
                </span>
                <ArrowRight size="1.1rem" />
              </button>
            )}
            <button
              type="button"
              className="main-menu-action"
              onClick={() => selectTab('new')}
            >
              <span className="grid size-10 shrink-0 place-items-center border border-line bg-void/30 text-mint">
                <Plus size="1.1rem" />
              </span>
              <span>
                <strong>New Sandbox</strong>
                <small>Create a company and fresh market</small>
              </span>
              <ArrowRight size="1.1rem" />
            </button>
            <button
              type="button"
              className="main-menu-action"
              onClick={() => selectTab('load')}
            >
              <span className="grid size-10 shrink-0 place-items-center border border-line bg-void/30 text-mint">
                <Database size="1.1rem" />
              </span>
              <span>
                <strong>Saves</strong>
                <small>Autosave and eight manual slots</small>
              </span>
              <ArrowRight size="1.1rem" />
            </button>
            <div className="main-menu-action cursor-not-allowed opacity-45" aria-disabled="true">
              <span className="grid size-10 shrink-0 place-items-center border border-line bg-void/30 text-muted">
                <Lock size="1.05rem" />
              </span>
              <span>
                <strong>Campaign</strong>
                <small>Coming soon</small>
              </span>
            </div>
          </div>
        )}

        {tab === 'news' && (
          <div className="anim-stagger mt-5 space-y-2">
            {MENU_NEWS_POSTS.map((post) => (
              <FeedPost key={post.title} source={post.source} timeLabel={post.timeLabel} tone={post.tone} body={<><strong className="text-bone">{post.title}</strong> — {post.detail}</>} />
            ))}
          </div>
        )}

        {tab === 'settings' && <SettingsPanel />}

        {tab === 'load' && (
          <div className="mt-5 space-y-1.5">
            {(['auto', ...MANUAL_SLOTS] as SaveSlotId[]).map((id) => {
              const m = bySlot[id]
              return (
                <div
                  key={id}
                  className="flex min-h-14 flex-wrap items-center justify-between gap-3 border border-line bg-panel-2/75 px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="text-[0.8125rem] font-medium text-bone">
                      {id === 'auto' ? 'Autosave' : `Slot ${id}`}
                    </div>
                    {m ? (
                      <>
                        <div className="truncate font-mono text-[0.75rem] text-muted">
                          {m.labName} · Day {m.day}{m.campaignDate ? ` · ${m.campaignDate}` : ''} · {money(m.cash)}
                        </div>
                        <div className={`mt-0.5 text-[0.6875rem] ${m.compatible ? 'text-muted' : 'text-danger'}`}>
                          {m.compatible ? `Last played ${formatLastPlayed(m.savedAt)}` : 'Save needs attention'}
                        </div>
                      </>
                    ) : (
                      <div className="text-[0.75rem] text-muted">Empty</div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {m && (
                      <>
                        <button
                          type="button"
                          className={`min-h-8 border px-3 py-1 text-[0.75rem] font-semibold ${
                            m.compatible
                              ? 'border-mint/30 bg-mint/15 text-mint'
                              : 'border-amber/30 bg-amber/10 text-amber'
                          }`}
                          onClick={() => {
                            if (m.compatible) void onLoad(id)
                            else {
                              setStatus(null)
                              setProblemSlot((current) => (current === id ? null : id))
                            }
                          }}
                        >
                          {m.compatible ? 'Open' : 'Why?'}
                        </button>
                        <button
                          type="button"
                          className="min-h-8 border border-line px-2.5 py-1 text-[0.75rem] text-danger"
                          onClick={() => {
                            requestConfirm({
                              title: `Delete ${id === 'auto' ? 'autosave' : `slot ${id}`}?`,
                              body: 'This save cannot be recovered after deletion.',
                              actionLabel: 'Delete save',
                              tone: 'danger',
                              onConfirm: () => {
                                void deleteSave(id).then(() => {
                                  setStatus(null)
                                  setProblemSlot(null)
                                  setSavesTick((n) => n + 1)
                                })
                              },
                            })
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                  {m && !m.compatible && problemSlot === id && (
                    <div role="alert" className="mt-2 flex w-full basis-full gap-2 border border-danger/45 bg-danger/10 px-3 py-2 text-[0.75rem] text-danger">
                      <WarningCircle size="1rem" weight="fill" className="mt-0.5 shrink-0" />
                      <span>
                        <strong className="block">Save incompatible</strong>
                        <span className="mt-0.5 block text-bone/80">
                          {m.incompatibilityReason ?? `Save format v${m.version} cannot be validated.`}
                        </span>
                        <span className="mt-1 block text-muted">Keep it for a future build, or delete this slot and start a New Sandbox.</span>
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
            {!canContinue && (
              <p className="pt-2 text-center text-[0.8125rem] text-muted">No compatible saves — start a New Sandbox.</p>
            )}
          </div>
        )}

        {tab === 'new' && (
          <div className="main-menu-setup">
            <nav aria-label="New sandbox steps" className="grid grid-cols-3 border border-line/80 bg-void/45 p-1">
              {(['Identity', 'Market & world', 'Launch'] as const).map((label, index) => (
                <button
                  key={label}
                  type="button"
                  aria-current={newGameStep === index ? 'step' : undefined}
                  onClick={() => setNewGameStep(index as NewGameStep)}
                  className={`flex min-h-10 items-center justify-center gap-2 px-2 text-[0.6875rem] font-semibold transition ${
                    newGameStep === index ? 'bg-panel-2 text-mint shadow-[inset_0_-2px_0_#48d7d1]' : 'text-muted hover:bg-panel-2/60 hover:text-bone'
                  }`}
                >
                  <span className="font-mono text-[0.5625rem] opacity-70">0{index + 1}</span>
                  {label}
                </button>
              ))}
            </nav>

            {newGameStep === 0 && (
              <section className="main-menu-setup-step mt-4 grid gap-4 lg:grid-cols-[minmax(15rem,.8fr)_minmax(30rem,1.4fr)]">
                <div className="main-menu-identity border border-line/70 bg-void/45 p-4 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted">
                  <label htmlFor="new-game-company-name">Company name</label>
                  <span className="relative mt-2 block">
                    <input
                      id="new-game-company-name"
                      value={labName}
                      onChange={(e) => setLabName(e.target.value.slice(0, 32))}
                      maxLength={32}
                      className="w-full border border-line bg-void/85 py-3 pl-3.5 pr-12 font-sans text-[0.9375rem] font-medium normal-case tracking-normal text-bone outline-none transition-colors focus:border-mint/50"
                      placeholder="Labline"
                      autoFocus
                    />
                    <button type="button" onClick={randomizeCompanyName} aria-label="Generate a company name" title="Generate a company name" className="absolute inset-y-1.5 right-1.5 grid aspect-square place-items-center border border-line bg-panel-2 text-muted transition-colors hover:border-mint/45 hover:text-mint">
                      <DiceFive size="1.05rem" weight="duotone" />
                    </button>
                  </span>
                  <div className="mt-4 flex items-center gap-3 border-t border-line/60 pt-4 normal-case tracking-normal">
                    <span className="grid size-14 shrink-0 place-items-center border border-mint/40 bg-mint/10 text-mint"><CompanyMark mark={companyMark} /></span>
                    <span><strong className="block text-sm text-bone">{labName.trim() || 'Labline'}</strong><small className="mt-1 block text-[0.6875rem] font-normal text-muted">Your identity across the world feed and market.</small></span>
                  </div>
                </div>

                <fieldset className="border border-line/70 bg-panel-2/60 p-4">
                  <legend className="sr-only">Logo maker</legend>
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted">Logo maker</p><p className="mt-1 text-[0.6875rem] text-muted">Selected · {COMPANY_MARKS.find((mark) => mark.id === companyMark)?.label}</p></div>
                    <button type="button" onClick={randomizeCompanyMark} className="flex min-h-8 items-center gap-2 border border-line bg-void/65 px-2.5 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted hover:border-mint/40 hover:text-mint"><DiceFive size="0.95rem" weight="duotone" /> Random</button>
                  </div>
                  <div className="mt-3 grid grid-cols-9 gap-2">
                    {COMPANY_MARKS.map((mark) => {
                      const selected = companyMark === mark.id
                      return <button key={mark.id} type="button" aria-label={`${mark.label} company mark`} aria-pressed={selected} title={mark.label} onClick={() => setCompanyMark(mark.id)} className={`company-mark-button grid aspect-square place-items-center border transition-colors ${selected ? 'border-mint bg-mint/10 text-mint' : 'border-line bg-void/65 text-muted hover:border-mint/40 hover:text-bone'}`}><CompanyMark mark={mark.id} /></button>
                    })}
                  </div>
                </fieldset>
              </section>
            )}

            {newGameStep === 1 && !showAdvanced && (
              <section className="main-menu-setup-step mt-4">
                <div className="flex items-center justify-between gap-3"><p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted">Market pressure</p><span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">Choose one scenario</span></div>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {SCENARIOS.map((d, index) => {
                    const on = scenario === d.id
                    return <button key={d.id} type="button" onClick={() => applyScenario(d.id)} aria-pressed={on} className={`main-menu-difficulty group min-h-[7rem] border px-3 py-3 text-left transition ${on ? 'border-mint/55 bg-mint/10' : 'border-line bg-panel-2/80 hover:border-mint/30'}`}><span className="flex items-center justify-between gap-2"><span className={`text-sm font-semibold ${on ? 'text-mint' : 'text-bone'}`}>{d.label}</span><span className="font-mono text-[0.625rem] text-muted">0{index + 1}</span></span><span className="mt-2 block text-[0.6875rem] leading-[1.4] text-muted">{d.blurb}</span></button>
                  })}
                </div>
                <button type="button" onClick={() => { if (scenario !== 'custom') setAdv(DIFFICULTY_PRESETS[difficulty]); setShowAdvanced(true) }} className="mt-3 flex min-h-10 w-full items-center justify-between border border-line bg-void/55 px-3.5 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-mint hover:border-mint/40"><span>World controls</span><span>Open +</span></button>
              </section>
            )}

            {newGameStep === 1 && showAdvanced && (
              <section className="main-menu-setup-step mt-4">
                <div className="flex items-center justify-between"><div><p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-mint">Custom world</p><p className="mt-1 text-[0.6875rem] text-muted">Compact controls · changes apply immediately</p></div><button type="button" onClick={() => setShowAdvanced(false)} className="min-h-9 border border-line px-3 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted hover:text-bone">Back to scenarios</button></div>
                <div className="main-menu-world-controls mt-3 grid grid-cols-4 gap-3 border border-line bg-panel-2/80 p-3.5">
                  <NumField label="Map width" hint="Horizontal tile count." value={adv.mapWidth ?? preview.mapWidth} min={MIN_MAP_DIMENSION} max={MAX_MAP_DIMENSION} onChange={(v) => setAdvField('mapWidth', v)} />
                  <NumField label="Map height" hint="Vertical tile count." value={adv.mapHeight ?? preview.mapHeight} min={MIN_MAP_DIMENSION} max={MAX_MAP_DIMENSION} onChange={(v) => setAdvField('mapHeight', v)} />
                  <NumField label="Metro regions" hint="Major metro anchors and derived towns." value={adv.cityCount ?? preview.cityCount} min={MIN_CITY_COUNT} max={MAX_CITY_COUNT} onChange={(v) => setAdvField('cityCount', v)} />
                  <NumField label="Rivals" hint="Competing AI labs in the market." value={adv.rivalCount ?? preview.rivalCount} min={1} max={5} onChange={(v) => setAdvField('rivalCount', v)} />
                  <SliderField label="Economy" hint="Construction and infrastructure costs." value={adv.economyMult ?? preview.economyMult} min={0.4} max={2.5} step={0.05} onChange={(v) => setAdvField('economyMult', v)} format={(v) => `×${v.toFixed(2)}`} />
                  <SliderField label="Research" hint="Compute-days required for research." value={adv.researchCostMult ?? preview.researchCostMult} min={0.4} max={2.5} step={0.05} onChange={(v) => setAdvField('researchCostMult', v)} format={(v) => `×${v.toFixed(2)}`} />
                  <SliderField label="Starting capital" hint="Cash available on day one." value={adv.startingCashMult ?? preview.startingCashMult} min={0.3} max={3} step={0.05} onChange={(v) => setAdvField('startingCashMult', v)} format={(v) => money(ECONOMY.startingCash * v)} />
                  <div className="text-[0.8125rem] text-muted"><label htmlFor="new-game-seed">Seed</label><div className="mt-1 flex gap-2"><input id="new-game-seed" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} className="w-full border border-line bg-void px-2 py-1.5 font-mono text-xs text-bone outline-none" /><button type="button" className="border border-line px-2 text-xs hover:text-bone" onClick={() => setSeed(Math.floor(Math.random() * 99999))}>Roll</button></div></div>
                  <fieldset className="col-span-2 border border-line/70 bg-void/45 px-3 py-2"><legend className="px-1 text-[0.75rem] font-semibold text-bone">Driving side</legend><div className="grid grid-cols-2 gap-1.5">{(['left', 'right'] as const).map((side) => { const selected = (adv.drivingSide ?? preview.drivingSide) === side; return <button key={side} type="button" aria-pressed={selected} onClick={() => setAdvField('drivingSide', side)} className={`min-h-8 border px-3 text-[0.75rem] font-semibold ${selected ? 'border-mint/50 bg-mint/15 text-mint' : 'border-line text-muted'}`}>{side === 'left' ? 'Left-hand' : 'Right-hand'}</button> })}</div></fieldset>
                  <label htmlFor="new-game-governance" className="col-span-2 flex cursor-pointer items-center gap-3 border border-line/70 bg-void/45 px-3 py-2 text-[0.75rem] text-muted"><input id="new-game-governance" type="checkbox" checked={adv.campaignRules?.externalityMode === 'advanced'} onChange={(event) => setAdvField('campaignRules', defaultCampaignRules({ externalityMode: event.target.checked ? 'advanced' : 'standard' }))} className="accent-mint" /><span><strong className="block text-bone">Advanced governance</strong><span>Carbon, water, rights, and audit systems.</span></span></label>
                </div>
              </section>
            )}

            {newGameStep === 2 && (
              <section className="main-menu-setup-step mt-4 grid gap-4 lg:grid-cols-[1fr_.72fr]">
                <div className="main-menu-briefing border border-line/70 bg-void/55"><div className="flex items-center justify-between border-b border-line/60 px-3.5 py-2.5"><span className="flex items-center gap-2 text-[0.75rem] font-semibold text-bone"><GlobeHemisphereWest size="1rem" className="text-mint" /> World briefing</span><span className="font-mono text-[0.5625rem] uppercase tracking-[0.15em] text-muted">Seed {seed}</span></div><div className="grid grid-cols-3 divide-x divide-line/60"><BriefingStat label="Territory" value={`${preview.mapWidth}×${preview.mapHeight}`} detail={`${preview.mapWidth * preview.mapHeight} tiles`} /><BriefingStat label="Opposition" value={`${preview.rivalCount} rivals`} detail={`${preview.cityCount} metros + towns`} /><BriefingStat label="Capital" value={money(ECONOMY.startingCash * preview.startingCashMult)} detail="Day-one runway" /></div></div>
                <div className="flex items-center gap-3 border border-mint/30 bg-mint/8 p-4"><span className="grid size-14 shrink-0 place-items-center border border-mint/40 bg-void/45 text-mint"><CompanyMark mark={companyMark} /></span><span><strong className="block text-base text-bone">{labName.trim() || 'Labline'}</strong><small className="mt-1 block text-[0.6875rem] text-muted">{SCENARIOS.find((item) => item.id === scenario)?.label} market · {preview.drivingSide}-hand traffic</small></span></div>
                <button type="button" className="main-menu-launch flex w-full items-center justify-between px-4 py-3.5 text-sm lg:col-span-2" onClick={() => { clearLifecycleError(); setStatus(null); void startGame({ labName: labName.trim() || 'Labline', companyMark, difficulty, seed, advanced: scenario === 'custom' ? adv : undefined }) }}><span><strong className="block text-[0.875rem]">Launch Sandbox</strong><small className="mt-0.5 block font-mono text-[0.5625rem] uppercase tracking-[0.12em] opacity-70">Generate the market · begin on day one</small></span><ArrowRight size="1.25rem" weight="bold" /></button>
              </section>
            )}

            <div className="mt-4 flex items-center justify-between border-t border-line/70 pt-3">
              <button type="button" disabled={newGameStep === 0} onClick={() => setNewGameStep((newGameStep - 1) as NewGameStep)} className="min-h-9 border border-line px-4 text-[0.75rem] text-muted disabled:invisible hover:text-bone"><ArrowLeft size="0.95rem" className="mr-2 inline" /> Previous</button>
              {newGameStep < 2 && <button type="button" onClick={() => setNewGameStep((newGameStep + 1) as NewGameStep)} className="min-h-9 border border-mint/50 bg-mint/10 px-4 text-[0.75rem] font-semibold text-mint hover:bg-mint/15">{newGameStep === 0 ? 'Market & world' : 'Review launch'} <ArrowRight size="0.95rem" className="ml-2 inline" /></button>}
            </div>
          </div>
        )}
          </div>
    </LablineMenuShell>
  )
}

function CompanyMark({ mark }: { mark: CompanyMarkId }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="size-7">
      {mark === 'orbit' && (
        <>
          <path {...common} d="M6 10 10 6l6 6 6-6 4 4-6 6 6 6-4 4-6-6-6 6-4-4 6-6-6-6Z" />
          <circle {...common} cx="16" cy="16" r="2.5" />
        </>
      )}
      {mark === 'delta' && <path {...common} d="m5 25 11-20 11 20H5Zm6-3 5-9 5 9H11Z" />}
      {mark === 'prism' && (
        <>
          <path {...common} d="m16 4 10 12-10 12L6 16 16 4Z" />
          <path {...common} d="m12 16 4-7 4 7-4 7-4-7Z" />
        </>
      )}
      {mark === 'hex' && <path {...common} d="m16 4 10 6v12l-10 6-10-6V10l10-6Z" />}
      {mark === 'spire' && (
        <>
          <path {...common} d="m6 26 10-22 10 22-10-7-10 7Z" />
          <path {...common} d="m10 20 6-8 6 8" />
        </>
      )}
      {mark === 'grid' && (
        <>
          <rect {...common} x="5" y="5" width="9" height="9" />
          <rect {...common} x="18" y="5" width="9" height="9" />
          <rect {...common} x="5" y="18" width="9" height="9" />
          <rect {...common} x="18" y="18" width="9" height="9" />
        </>
      )}
      {mark === 'nexus' && (
        <>
          <circle {...common} cx="8" cy="16" r="3" />
          <circle {...common} cx="24" cy="9" r="3" />
          <circle {...common} cx="24" cy="23" r="3" />
          <path {...common} d="m11 15 10-5M11 17l10 5M24 12v8" />
        </>
      )}
      {mark === 'wave' && (
        <>
          <path {...common} d="M5 12c4-7 8 7 12 0s7 5 10 0" />
          <path {...common} d="M5 20c4-7 8 7 12 0s7 5 10 0" />
        </>
      )}
      {mark === 'core' && (
        <>
          <circle {...common} cx="16" cy="16" r="10" />
          <circle {...common} cx="16" cy="16" r="4" />
          <path {...common} d="M16 3v6M16 23v6M3 16h6M23 16h6" />
        </>
      )}
    </svg>
  )
}

function BriefingStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 px-3 py-3">
      <span className="block font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-muted">{label}</span>
      <strong className="mt-1 block truncate font-mono text-[0.75rem] font-medium text-bone">{value}</strong>
      <span className="mt-0.5 block truncate text-[0.625rem] text-muted">{detail}</span>
    </div>
  )
}

function TabChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-9 px-2 text-[0.75rem] font-semibold transition ${
        active ? 'bg-panel-2 text-mint shadow-[inset_0_-2px_0_#48d7d1]' : 'text-muted hover:bg-panel-2/60 hover:text-bone'
      }`}
    >
      {children}
    </button>
  )
}

function NumField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  const inputId = useId()
  const hintId = useId()
  return (
    <div className="block text-[0.8125rem] text-muted">
      <span className="flex items-center gap-1.5">
        <label htmlFor={inputId}>{label}</label>
        <FieldHint id={hintId} text={hint} />
      </span>
      <input
        id={inputId}
        type="number"
        min={min}
        max={max}
        value={value}
        aria-describedby={hintId}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        className="mt-1 w-full rounded-lg border border-line bg-void px-2 py-1.5 font-mono text-xs text-bone outline-none"
      />
    </div>
  )
}

function SliderField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format: (v: number) => string
}) {
  const inputId = useId()
  const hintId = useId()
  return (
    <div className="block text-[0.8125rem] text-muted">
      <span className="flex justify-between">
        <span className="flex items-center gap-1.5">
          <label htmlFor={inputId}>{label}</label>
          <FieldHint id={hintId} text={hint} />
        </span>
        <span className="font-mono text-bone">{format(value)}</span>
      </span>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-describedby={hintId}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full"
      />
    </div>
  )
}

function FieldHint({ id, text }: { id?: string; text: string }) {
  return (
    <span
      className="group relative inline-grid size-4 shrink-0 place-items-center align-middle text-muted"
      title={text}
      tabIndex={0}
      aria-label={text}
    >
      <Question size="0.75rem" weight="bold" aria-hidden="true" />
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+0.4rem)] left-1/2 z-40 w-56 -translate-x-1/2 border border-line bg-void px-2.5 py-2 text-left font-sans text-[0.6875rem] font-normal leading-relaxed normal-case tracking-normal text-bone opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus:opacity-100"
      >
        {text}
      </span>
    </span>
  )
}
