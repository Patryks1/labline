import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  buildGameConfig,
  MAX_CITY_COUNT,
  MAX_MAP_DIMENSION,
  MIN_CITY_COUNT,
  MIN_MAP_DIMENSION,
  defaultCompanyLogoSpec,
  type AdvancedOverrides,
  type CompanyLogoSpec,
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
import { HudButton, HudInput, HudRange } from './ui/HudPrimitives'
import { CompanyMark, CompanyMarkBadge, companyLogoInk } from './ui/CompanyMark'
import {
  encodeCompanyLogoRecipe,
  parseCompanyLogoRecipe,
  pickDistinctCompanyName,
  randomizeCompanyLogo,
  readSavedLogoRecipes,
  removeSavedLogoRecipe,
  saveLogoRecipe,
} from './ui/companyIdentity'
import { LablineMenuShell } from './menu/LablineMenuShell'
import { SettingsPanel } from './menu/SettingsPanel'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Database,
  DiceFive,
  FloppyDisk,
  GearSix,
  GlobeHemisphereWest,
  Lock,
  Newspaper,
  Play,
  Plus,
  Question,
  WarningCircle,
  X,
} from '@phosphor-icons/react'

type ScenarioId = DifficultyId

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
  const [companyLogo, setCompanyLogo] = useState<CompanyLogoSpec>(() => defaultCompanyLogoSpec('orbit'))
  const [logoSeedDraft, setLogoSeedDraft] = useState(() => encodeCompanyLogoRecipe('orbit', defaultCompanyLogoSpec('orbit')))
  const [logoSeedCopied, setLogoSeedCopied] = useState(false)
  const [savedLogoRecipes, setSavedLogoRecipes] = useState<string[]>(() => readSavedLogoRecipes())
  const [difficulty, setDifficulty] = useState<DifficultyId>('normal')
  const [scenario, setScenario] = useState<ScenarioId>('normal')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [newGameStep, setNewGameStep] = useState<NewGameStep>(0)
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 99999))
  // Advanced values are explicit overrides against the selected preset. Keep
  // them when the disclosure closes or the base difficulty changes; the reset
  // action is the only deliberate way to discard a player's tuning.
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
        companyLogo,
        difficulty,
        seed,
        advanced: adv,
      }),
    [labName, companyMark, companyLogo, difficulty, seed, adv],
  )

  const setAdvField = <K extends keyof AdvancedOverrides>(k: K, v: AdvancedOverrides[K]) => {
    setAdv((a) => ({ ...a, [k]: v }))
  }

  const applyScenario = (next: ScenarioId) => {
    setScenario(next)
    setDifficulty(next)
  }

  const resetAdvanced = () => setAdv({})

  const advancedCustomized = Object.keys(adv).length > 0

  const logoRecipe = encodeCompanyLogoRecipe(companyMark, companyLogo)
  const logoInk = companyLogoInk(companyLogo)
  const logoSeedCopiedAt = useRef<number>(0)

  useEffect(() => {
    setLogoSeedDraft(logoRecipe)
  }, [logoRecipe])

  const randomizeCompanyName = () => {
    setLabName(pickDistinctCompanyName(labName))
  }

  const randomizeCompanyMark = () => {
    const next = randomizeCompanyLogo(companyMark, companyLogo)
    setCompanyMark(next.mark)
    setCompanyLogo(next.spec)
  }

  const setLogoField = <K extends keyof CompanyLogoSpec>(key: K, value: CompanyLogoSpec[K]) => {
    setCompanyLogo((current) => ({ ...current, [key]: value }))
  }

  const applyLogoSeedDraft = (raw: string = logoSeedDraft) => {
    const parsed = parseCompanyLogoRecipe(raw)
    if (!parsed) {
      setLogoSeedDraft(logoRecipe)
      return
    }
    if (parsed.kind === 'seed') {
      setLogoField('seed', parsed.seed)
      return
    }
    setCompanyMark(parsed.mark)
    setCompanyLogo(parsed.spec)
  }

  const copyLogoRecipe = async () => {
    try {
      await navigator.clipboard.writeText(logoRecipe)
      logoSeedCopiedAt.current = Date.now()
      setLogoSeedCopied(true)
      window.setTimeout(() => {
        if (Date.now() - logoSeedCopiedAt.current >= 900) setLogoSeedCopied(false)
      }, 1200)
    } catch {
      setLogoSeedDraft(logoRecipe)
    }
  }

  const pinLogoRecipe = () => {
    setSavedLogoRecipes(saveLogoRecipe(logoRecipe))
  }

  const loadSavedLogo = (recipe: string) => {
    applyLogoSeedDraft(recipe)
  }

  const forgetSavedLogo = (recipe: string) => {
    setSavedLogoRecipes(removeSavedLogoRecipe(recipe))
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
                        <HudButton
                          type="button"
                          variant="secondary"
                          className={`min-h-11 min-w-11 border px-3 py-1 text-[0.75rem] font-semibold sm:min-h-8 ${
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
                        </HudButton>
                        <HudButton
                          type="button"
                          variant="danger"
                          className="min-h-11 min-w-11 border-line px-2.5 py-1 text-[0.75rem] sm:min-h-8"
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
                        </HudButton>
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
                  className={`flex min-h-11 items-center justify-center gap-2 px-2 text-[0.6875rem] font-semibold transition ${
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
                  <div className="main-menu-name-random mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-2">
                    <HudInput
                      id="new-game-company-name"
                      value={labName}
                      onChange={(e) => setLabName(e.target.value.slice(0, 32))}
                      maxLength={32}
                      className="min-h-11 w-full bg-void/85 px-3.5 py-2 font-sans text-[0.9375rem] font-medium normal-case tracking-normal"
                      placeholder="Labline"
                      autoFocus
                    />
                    <HudButton type="button" variant="ghost" onClick={randomizeCompanyName} aria-label="Randomize company name" title="Randomize company name" className="main-menu-random-button flex min-h-11 items-center gap-2 border border-line bg-panel-2 px-3 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted transition-colors hover:border-mint/45 hover:text-mint">
                      <DiceFive size="1rem" weight="duotone" /> Randomize
                    </HudButton>
                  </div>
                  <div className="mt-4 flex items-center gap-3 border-t border-line/60 pt-4 normal-case tracking-normal">
                    <CompanyMarkBadge mark={companyMark} logo={companyLogo} className="size-14 shrink-0 border border-line/70" markClassName="size-8" />
                    <span><strong className="block text-sm text-bone">{labName.trim() || 'Labline'}</strong><small className="mt-1 block text-[0.6875rem] font-normal text-muted">Your identity across the world feed and market.</small></span>
                  </div>
                </div>

                <fieldset className="main-menu-logo-maker border border-line/70 bg-panel-2/60 p-4">
                  <legend className="sr-only">Logo maker</legend>
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted">Procedural logo maker</p><p className="mt-1 text-[0.6875rem] text-muted">Tune a filled mark, then copy or save the seed.</p></div>
                    <HudButton type="button" variant="ghost" onClick={randomizeCompanyMark} aria-label="Randomize procedural logo" className="main-menu-random-button flex min-h-11 items-center gap-2 border border-line bg-void/65 px-3 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted hover:border-mint/40 hover:text-mint"><DiceFive size="0.95rem" weight="duotone" /> Randomize</HudButton>
                  </div>
                  <div className="main-menu-logo-workbench mt-3 grid gap-3 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
                    <div className="main-menu-logo-preview grid min-h-40 place-items-center border border-line/70" data-logo-ink={logoInk}>
                      <CompanyMark mark={companyMark} logo={companyLogo} className="size-28" />
                      <span className="border-t border-line/50 px-2 py-1.5 text-center font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-muted">{COMPANY_MARKS.find((mark) => mark.id === companyMark)?.label} structure</span>
                    </div>
                    <div className="grid content-start gap-2 sm:grid-cols-2">
                      <LogoSlider label="Symmetry" value={companyLogo.symmetry} min={3} max={10} step={1} display={`${companyLogo.symmetry}-way`} onChange={(value) => setLogoField('symmetry', Math.round(value))} />
                      <LogoSlider label="Complexity" value={companyLogo.complexity} min={1} max={5} step={1} display={`${companyLogo.complexity}/5`} onChange={(value) => setLogoField('complexity', Math.round(value))} />
                      <LogoSlider label="Spread" value={companyLogo.spread} min={0.35} max={1} step={0.01} display={`${Math.round(companyLogo.spread * 100)}%`} onChange={(value) => setLogoField('spread', value)} />
                      <LogoSlider label="Rotation" value={companyLogo.rotation} min={0} max={359} step={1} display={`${Math.round(companyLogo.rotation)}°`} onChange={(value) => setLogoField('rotation', Math.round(value))} />
                      <div className="sm:col-span-2">
                        <p className="mb-1.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-muted">Ink</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          {(['black', 'white'] as const).map((ink) => {
                            const selected = logoInk === ink
                            return (
                              <button
                                key={ink}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => setLogoField('ink', ink)}
                                className={`flex min-h-11 items-center justify-center gap-2 border px-3 text-[0.75rem] font-semibold capitalize ${selected ? 'border-mint/55 bg-mint/12 text-mint' : 'border-line bg-void/45 text-muted hover:border-mint/35 hover:text-bone'}`}
                              >
                                <span className={`size-3.5 border ${ink === 'black' ? 'border-line bg-[#14191c]' : 'border-line bg-[#e8f2f2]'}`} />
                                {ink}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-muted">Base structure</span>
                      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:max-w-[22rem]">
                        <label htmlFor="company-logo-seed" className="sr-only">Logo seed</label>
                        <HudInput
                          id="company-logo-seed"
                          value={logoSeedDraft}
                          spellCheck={false}
                          onChange={(event) => setLogoSeedDraft(event.target.value)}
                          onBlur={(event) => applyLogoSeedDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              applyLogoSeedDraft(event.currentTarget.value)
                              event.currentTarget.blur()
                            }
                          }}
                          className="min-h-9 min-w-0 flex-1 bg-void/85 px-2 py-1 font-mono text-[0.625rem] text-bone"
                          aria-describedby="company-logo-seed-hint"
                        />
                        <HudButton type="button" variant="ghost" onClick={() => void copyLogoRecipe()} aria-label={logoSeedCopied ? 'Logo seed copied' : 'Copy logo seed'} className="min-h-9 min-w-9 border border-line px-2 text-muted hover:text-mint">
                          {logoSeedCopied ? <Check size="0.9rem" /> : <Copy size="0.9rem" />}
                        </HudButton>
                        <HudButton type="button" variant="ghost" onClick={pinLogoRecipe} aria-label="Save logo seed" className="min-h-9 min-w-9 border border-line px-2 text-muted hover:text-mint">
                          <FloppyDisk size="0.9rem" />
                        </HudButton>
                      </div>
                    </div>
                    <p id="company-logo-seed-hint" className="mb-2 font-mono text-[0.5rem] uppercase tracking-[0.12em] text-muted">Paste a saved seed or type a number, then leave the field.</p>
                    <div className="grid grid-cols-5 gap-2 sm:grid-cols-9">
                    {COMPANY_MARKS.map((mark) => {
                      const selected = companyMark === mark.id
                      return (
                        <button
                          key={mark.id}
                          type="button"
                          aria-label={`${mark.label} logo structure`}
                          aria-pressed={selected}
                          title={mark.label}
                          onClick={() => { setCompanyMark(mark.id); setCompanyLogo((current) => ({ ...current, seed: defaultCompanyLogoSpec(mark.id).seed })) }}
                          className={`company-mark-button grid min-h-11 min-w-11 aspect-square place-items-center border p-1 transition-colors ${selected ? 'border-mint bg-mint/10' : 'border-line bg-void/65 hover:border-mint/40'}`}
                        >
                          <span className={`company-mark-thumb company-mark-thumb--${logoInk} grid size-full place-items-center`}>
                            <CompanyMark mark={mark.id} logo={{ ...companyLogo, seed: defaultCompanyLogoSpec(mark.id).seed }} className="size-7" />
                          </span>
                        </button>
                      )
                    })}
                    </div>
                    {savedLogoRecipes.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {savedLogoRecipes.map((recipe) => {
                          const parsed = parseCompanyLogoRecipe(recipe)
                          if (parsed?.kind !== 'recipe') return null
                          const selected = recipe === logoRecipe
                          return (
                            <span key={recipe} className="flex items-center gap-0.5">
                              <button
                                type="button"
                                title={recipe}
                                aria-label={`Load saved seed ${recipe}`}
                                aria-pressed={selected}
                                onClick={() => loadSavedLogo(recipe)}
                                className={`company-mark-button grid size-10 place-items-center border ${selected ? 'border-mint' : 'border-line hover:border-mint/40'}`}
                              >
                                <CompanyMarkBadge mark={parsed.mark} logo={parsed.spec} className="size-full border-0" markClassName="size-6" />
                              </button>
                              <button type="button" aria-label={`Remove saved seed ${recipe}`} onClick={() => forgetSavedLogo(recipe)} className="grid size-6 place-items-center text-muted hover:text-bone">
                                <X size="0.7rem" />
                              </button>
                            </span>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                </fieldset>
              </section>
            )}

            {newGameStep === 1 && (
              <section className="main-menu-setup-step mt-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted">Market pressure</p>
                    <p className="mt-1 text-[0.6875rem] text-muted">Choose a base difficulty, then tune optional controls below.</p>
                  </div>
                  <span className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">Base scenario</span>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {SCENARIOS.map((d, index) => {
                    const on = scenario === d.id
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => applyScenario(d.id)}
                        aria-pressed={on}
                        data-difficulty={d.id}
                        className={`main-menu-difficulty main-menu-difficulty--${d.id} group min-h-[10.5rem] border px-3.5 py-3.5 text-left transition ${on ? 'border-mint/65 bg-mint/12' : 'border-line bg-panel-2/80 hover:border-mint/35'}`}
                      >
                        <span className="relative z-[1] flex items-center justify-between gap-2">
                          <span className={`text-sm font-semibold ${on ? 'text-mint' : 'text-bone'}`}>{d.label}</span>
                          <span className="font-mono text-[0.625rem] text-muted">0{index + 1}</span>
                        </span>
                        <span className="relative z-[1] mt-3 block max-w-[28ch] text-[0.6875rem] leading-[1.5] text-muted">{d.blurb}</span>
                        {on ? <span className="relative z-[1] mt-4 block font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-mint">Selected</span> : null}
                      </button>
                    )
                  })}
                </div>

                <div className="main-menu-advanced-toggle mt-3 flex items-center justify-between gap-3 border border-line bg-void/55 px-3.5 py-2.5">
                  <div>
                    <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-mint">Advanced controls</p>
                    <p className="mt-1 text-[0.6875rem] text-muted">World size, costs, research, capital, seed and governance.</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {advancedCustomized ? <span className="font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-amber">Customized</span> : null}
                    <HudButton
                      id="new-game-advanced-toggle"
                      type="button"
                      variant="ghost"
                      aria-expanded={showAdvanced}
                      aria-controls="new-game-advanced-panel"
                      onClick={() => setShowAdvanced((open) => !open)}
                      className="min-h-11 border border-line px-3 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-mint hover:border-mint/40"
                    >
                      {showAdvanced ? 'Hide' : 'Open'}
                    </HudButton>
                  </div>
                </div>

                {showAdvanced && (
                  <div id="new-game-advanced-panel" role="region" aria-labelledby="new-game-advanced-toggle" className="main-menu-world-controls mt-2 border border-line bg-panel-2/80 p-3.5">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-mint">World controls</p>
                        <p className="mt-1 text-[0.6875rem] text-muted">Overrides stay in place when you close this panel or switch difficulty.</p>
                      </div>
                      <HudButton type="button" variant="ghost" onClick={resetAdvanced} disabled={!advancedCustomized} className="min-h-11 border border-line px-3 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted hover:text-bone disabled:opacity-40">Reset to {scenario}</HudButton>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <NumField label="Map width" hint="Horizontal tile count." value={adv.mapWidth ?? preview.mapWidth} min={MIN_MAP_DIMENSION} max={MAX_MAP_DIMENSION} onChange={(v) => setAdvField('mapWidth', v)} />
                      <NumField label="Map height" hint="Vertical tile count." value={adv.mapHeight ?? preview.mapHeight} min={MIN_MAP_DIMENSION} max={MAX_MAP_DIMENSION} onChange={(v) => setAdvField('mapHeight', v)} />
                      <NumField label="Metro regions" hint="Major metro anchors and derived towns." value={adv.cityCount ?? preview.cityCount} min={MIN_CITY_COUNT} max={MAX_CITY_COUNT} onChange={(v) => setAdvField('cityCount', v)} />
                      <NumField label="Rivals" hint="Competing AI labs in the market." value={adv.rivalCount ?? preview.rivalCount} min={1} max={5} onChange={(v) => setAdvField('rivalCount', v)} />
                      <SliderField label="Economy" hint="Construction and infrastructure costs." value={adv.economyMult ?? preview.economyMult} min={0.4} max={2.5} step={0.05} onChange={(v) => setAdvField('economyMult', v)} format={(v) => `×${v.toFixed(2)}`} />
                      <SliderField label="Research" hint="Compute-days required for research." value={adv.researchCostMult ?? preview.researchCostMult} min={0.4} max={2.5} step={0.05} onChange={(v) => setAdvField('researchCostMult', v)} format={(v) => `×${v.toFixed(2)}`} />
                      <SliderField label="Starting capital" hint="Cash available on day one." value={adv.startingCashMult ?? preview.startingCashMult} min={0.3} max={3} step={0.05} onChange={(v) => setAdvField('startingCashMult', v)} format={(v) => money(ECONOMY.startingCash * v)} />
                      <div className="text-[0.8125rem] text-muted"><label htmlFor="new-game-seed">Seed</label><div className="mt-1 flex gap-2"><HudInput id="new-game-seed" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} className="w-full bg-void px-2 py-1.5 font-mono text-xs" /><HudButton type="button" variant="ghost" className="min-h-11 min-w-11 border border-line px-2 text-xs hover:text-bone" onClick={() => setSeed(Math.floor(Math.random() * 99999))}>Roll</HudButton></div></div>
                      <fieldset className="sm:col-span-2 border border-line/70 bg-void/45 px-3 py-2"><legend className="px-1 text-[0.75rem] font-semibold text-bone">Driving side</legend><div className="grid grid-cols-2 gap-1.5">{(['left', 'right'] as const).map((side) => { const selected = (adv.drivingSide ?? preview.drivingSide) === side; return <button key={side} type="button" aria-pressed={selected} onClick={() => setAdvField('drivingSide', side)} className={`min-h-11 border px-3 text-[0.75rem] font-semibold ${selected ? 'border-mint/50 bg-mint/15 text-mint' : 'border-line text-muted'}`}>{side === 'left' ? 'Left-hand' : 'Right-hand'}</button> })}</div></fieldset>
                      <label htmlFor="new-game-governance" className="sm:col-span-2 flex cursor-pointer items-center gap-3 border border-line/70 bg-void/45 px-3 py-2 text-[0.75rem] text-muted"><input id="new-game-governance" type="checkbox" checked={adv.campaignRules?.externalityMode === 'advanced'} onChange={(event) => setAdvField('campaignRules', defaultCampaignRules({ externalityMode: event.target.checked ? 'advanced' : 'standard' }))} className="accent-mint" /><span><strong className="block text-bone">Advanced governance</strong><span>Carbon, water, rights, and audit systems.</span></span></label>
                    </div>
                  </div>
                )}
              </section>
            )}

            {newGameStep === 2 && (
              <section className="main-menu-setup-step mt-4 grid gap-4 lg:grid-cols-[1fr_.72fr]">
                <div className="main-menu-briefing flex flex-col border border-line/70 bg-void/55"><div className="flex items-center justify-between border-b border-line/60 px-3.5 py-2.5"><span className="flex items-center gap-2 text-[0.75rem] font-semibold text-bone"><GlobeHemisphereWest size="1rem" className="text-mint" /> World briefing</span><span className="font-mono text-[0.5625rem] uppercase tracking-[0.15em] text-muted">Seed {seed}</span></div><div className="grid grid-cols-3 divide-x divide-line/60"><BriefingStat label="Territory" value={`${preview.mapWidth}×${preview.mapHeight}`} detail={`${preview.mapWidth * preview.mapHeight} tiles`} /><BriefingStat label="Opposition" value={`${preview.rivalCount} rivals`} detail={`${preview.cityCount} metros + towns`} /><BriefingStat label="Capital" value={money(ECONOMY.startingCash * preview.startingCashMult)} detail="Day-one runway" /></div><div className="main-menu-briefing-envelope mt-auto border-t border-line/60 p-3.5"><div className="flex items-center justify-between gap-3"><div><p className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-mint">Operating envelope</p><p className="mt-1 text-[0.6875rem] text-muted">The rules that shape expansion after launch.</p></div><span className="border border-line/70 bg-panel-2/70 px-2 py-1 font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-bone">{SCENARIOS.find((item) => item.id === scenario)?.label}</span></div><div className="mt-3 grid grid-cols-2 gap-px overflow-hidden border border-line/60 bg-line/60 sm:grid-cols-4"><BriefingDatum label="Build cost" value={`×${preview.economyMult.toFixed(2)}`} /><BriefingDatum label="Research" value={`×${preview.researchCostMult.toFixed(2)}`} /><BriefingDatum label="Traffic" value={`${preview.drivingSide}-hand`} /><BriefingDatum label="Governance" value={preview.campaignRules?.externalityMode === 'advanced' ? 'Advanced' : 'Standard'} /></div></div></div>
                <div className="flex items-center gap-3 border border-mint/30 bg-mint/8 p-4"><CompanyMarkBadge mark={companyMark} logo={companyLogo} className="size-14 shrink-0 border border-line/70" markClassName="size-8" /><span><strong className="block text-base text-bone">{labName.trim() || 'Labline'}</strong><small className="mt-1 block text-[0.6875rem] text-muted">{SCENARIOS.find((item) => item.id === scenario)?.label} market · {preview.drivingSide}-hand traffic</small></span></div>
              </section>
            )}

            <div className="main-menu-setup-footer mt-4 flex items-center justify-between gap-3 border-t border-line/70 pt-3">
              <HudButton type="button" variant="ghost" disabled={newGameStep === 0} onClick={() => setNewGameStep((newGameStep - 1) as NewGameStep)} className="min-h-11 border border-line px-4 text-[0.75rem] text-muted disabled:invisible hover:text-bone"><ArrowLeft size="0.95rem" className="mr-2 inline" /> Previous</HudButton>
              {newGameStep < 2 ? (
                <HudButton type="button" variant="primary" onClick={() => setNewGameStep((newGameStep + 1) as NewGameStep)} className="main-menu-step-cta border border-mint/50 bg-mint/10 px-4 text-[0.75rem] font-semibold text-mint hover:bg-mint/15">{newGameStep === 0 ? 'Market & world' : 'Review launch'} <ArrowRight size="0.95rem" className="ml-2 inline" /></HudButton>
              ) : (
                <button type="button" className="main-menu-launch main-menu-step-cta flex flex-1 items-center justify-between px-4 py-2.5 text-sm sm:flex-initial" onClick={() => { clearLifecycleError(); setStatus(null); void startGame({ labName: labName.trim() || 'Labline', companyMark, companyLogo, difficulty, seed, advanced: adv }) }}><span><strong className="block text-[0.8125rem]">Launch Sandbox</strong><small className="mt-0.5 block font-mono text-[0.5625rem] uppercase tracking-[0.12em] opacity-70">Begin day one</small></span><ArrowRight size="1.15rem" weight="bold" /></button>
              )}
            </div>
          </div>
        )}
          </div>
    </LablineMenuShell>
  )
}

// Keep the historical import path used by the top bar and existing consumers.
export { CompanyMark } from './ui/CompanyMark'

function BriefingStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 px-3 py-3">
      <span className="block font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-muted">{label}</span>
      <strong className="mt-1 block truncate font-mono text-[0.75rem] font-medium text-bone">{value}</strong>
      <span className="mt-0.5 block truncate text-[0.625rem] text-muted">{detail}</span>
    </div>
  )
}

function BriefingDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-void/75 px-2.5 py-2">
      <span className="block font-mono text-[0.5rem] uppercase tracking-[0.12em] text-muted">{label}</span>
      <strong className="mt-1 block truncate font-mono text-[0.6875rem] font-medium text-bone">{value}</strong>
    </div>
  )
}

function LogoSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <label htmlFor={id} className="block border border-line/60 bg-void/35 px-2.5 py-2">
      <span className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted">
        <span>{label}</span>
        <strong className="font-mono text-[0.625rem] font-medium text-mint">{display}</strong>
      </span>
      <HudRange id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="mt-2" />
    </label>
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
    <HudButton
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`min-h-11 px-2 text-[0.75rem] font-semibold transition ${
        active ? 'bg-panel-2 text-mint shadow-[inset_0_-2px_0_#48d7d1]' : 'text-muted hover:bg-panel-2/60 hover:text-bone'
      }`}
    >
      {children}
    </HudButton>
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
      <HudInput
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
      <HudRange
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
