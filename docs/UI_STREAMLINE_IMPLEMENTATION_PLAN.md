# Labline UI Streamline implementation plan

Status: second-pass architecture contract for the current worktree. The
foundation, shell/navigation, menu semantics, shared finance/training/benchmark
contracts, browser-comment ownership pass, settled source-suite/browser-route
evidence, and final engineering checks are documented here. Only the
clean-worktree review remains open because the work is uncommitted.

Approved references:

- Desktop: `docs/ui-concepts/labline-ui-streamline-desktop.png`
- Mobile: `docs/ui-concepts/labline-ui-streamline-mobile.png`

This is a UI-only change. Game rules, simulation state, store actions, PanelIds,
hotkeys, save/load, deep links, callback arguments, and server-facing effects are
contracts, not redesign inputs. A visual change is not complete if one of those
contracts moves.

## 1. North star and evidence boundary

The approved composition is a near-black map stage behind translucent chrome:

1. one calm top command bar for time, transport, speed, economy, and utilities;
2. one grouped desktop rail with one active destination;
3. one active work surface with one visible title and one primary workflow;
4. one compact Intel/context area rather than duplicate navigation; and
5. one live operational strip spanning the available work area.

On mobile the same hierarchy becomes a compact command header, one active panel,
one full-width activity row above the bottom command nav, and primary navigation
for Build / Models / Plans / Data with the remaining destinations in More.

The raster references establish composition, density, palette, and hierarchy.
They do not define game rules, data, coordinates, routes, exact copy, or DOM.
Implementation decisions are made in React/CSS and verified with behavior,
accessibility, and responsive tests.

### Generation prompt intent

The concise intent behind the accepted mockups was: “dark frontier operations
console for a strategy game; near-black satellite/world map; calm compact top
bar; grouped left rail; one active workbench; thin multi-job live strip; mint
positive state and amber training state; restrained translucent surfaces; mobile
command shell; no duplicate headings, dashboards, or explanatory card walls.”

This prompt is a direction-setting note, not an implementation specification.
New generated examples must state the intended zones, tokens, states, and motion
and must never be treated as a raster implementation source.

### Implementation evidence index

The following current files are the evidence anchors for the implemented
contracts. Line numbers are review anchors and may move as later panels migrate.

| Contract | Evidence |
| --- | --- |
| Tokens, shell geometry, responsive layers | `src/index.css:3-64`, `src/index.css:764-803`, `src/index.css:1046-1117`, `src/index.css:1937-2190` |
| Shared primitives | `src/view/hud/ui/HudPrimitives.tsx:15-222`, `src/view/hud/ui/kit.tsx:18-327` |
| Grouped IA and mobile destination contract | `src/view/hud/navConfig.ts:133-187`, `src/view/hud/mobileShellContracts.ts:11-39` |
| Canonical finance selectors and legacy fallbacks | `src/view/hud/data/financeDashboardModel.ts:74-192` |
| Public/private benchmark boundary | `src/view/hud/data/benchmarkViewModel.ts:35-110` |
| Training queue/activity presentation model | `src/view/hud/trainingJobViewModel.ts:70-368`, `src/view/hud/TrainingActivityBar.tsx:48-257` |
| Accessible shell/menu ownership | `src/view/hud/TopBar.tsx`, `CommandDock.tsx`, `LeftRail.tsx`, `menu/SettingsPanel.tsx`, `ui/ConsoleDialog.tsx` |
| Chart interaction contracts | `src/view/hud/ui/LineChart.tsx`, `src/view/hud/panels/models/TrainingLossChart.tsx`, `src/view/hud/ui/RadarChart.tsx`, `src/view/hud/ui/dataViz/ResponsiveDonut.tsx` |

## 1A. Second-pass architecture and environment boundary

The second pass treats the browser comments as ownership and behavior problems,
not as isolated copy edits. Each fact has one canonical owner; neighboring
surfaces expose a compact pointer or an action that returns to that owner.
The owning source paths and acceptance contracts are:

| Area | Canonical source owner | Second-pass contract |
| --- | --- | --- |
| Company identity | `src/view/hud/TopBar.tsx:46-73`, `src/view/hud/NewGameMenu.tsx:90-100,578-604,661-684`, `src/sim/createGame.ts:49-58,177-202`, `src/sim/types.ts:3757-3762` | The saved `RunConfig.labName` and `companyMark` drive the top-left mark/name and downstream identity; fallback branding is only for a new/legacy save. |
| Pre-placement context | `src/view/hud/BuildTray.tsx:104-125,311-355`, `src/view/three/GameMap.tsx:1272-1290`, `src/index.css:964-978` | Empty/blocked land shows zone, utility, grade, status, footprint, and exact expected total before placement. The placed-tile inspector does not repeat the full build quote. |
| Placed-tile inspector and close control | `src/view/hud/TileInspector.tsx:49-257`, `src/view/hud/ui/HudPrimitives.tsx:231-247`, `src/index.css:2034-2053` | `TileInspector` stays compact and contextual; `HudCloseButton` owns the aligned, labelled 44px close affordance used by drawers and inspectors. |
| Responsive filters | `src/view/hud/ui/HudFilterBar.tsx:1-140`, `src/view/hud/ui/HudFilterBar.test.tsx`, `src/index.css:1882-2032,3136-3159`; market integration boundary `src/view/hud/panels/DataPanel.tsx:1278-1446` | Dense filters collapse on narrow viewports, expose active count/clear semantics, keep controls reachable, and do not clip labels or options. |
| Training volume and research | `src/view/hud/panels/ModelsPanel.tsx:1850-2021`, `src/view/hud/panels/ResearchPanel.tsx:230-499`, `src/view/hud/panels/researchCanvasLayout.ts:1-23`, `src/index.css:753-829` | Training Volume has one hierarchy and actionable mix/train/verify controls. Research fits the graph and stacks queue/detail responsively without hiding the tree. |
| HQ office editor | `src/view/hud/panels/HqOfficeEditorOverlay.tsx:56-258`, `src/sim/systems/hqOffice.ts:30-100,200-220,327-419`, `src/view/hud/panels/OrgPanel.tsx:1295-1345`, `src/store/gameStore.ts:217-252,616,645,707-725` | People owns the office entry point; the editor places desks, plants, copiers, meeting/research objects, and shows effects/quote. Save validates bounds/overlap and applies one persistent layout; close without save preserves the prior layout. |
| Finances and governance | `src/view/hud/panels/StatsPanel.tsx:27-95`, `src/view/hud/data/financeDashboardModel.ts:142-192`, `src/view/hud/panels/OverviewGovernance.tsx:39-167`, `src/view/hud/panels/MapPanel.tsx:30-31,99-107` | Capital/ownership readouts live in Finances; governance/policy review lives in Overview. Company does not expose competing top-level Capital or Policy tabs. |
| Plans | `src/view/hud/panels/PlansPanel.tsx:385-523,1033+`, `src/view/hud/panels/plansPanelNavigation.ts:3-13`, `src/sim/systems/plans.ts:39,719+` | Capacity/usage context sits above the selector; tabs are Demand/Tiers/API only; current plans precede `New plan`; `MAX_PLANS` is eight in both UI and simulation. |
| Data hygiene and drift | `src/view/hud/panels/DataPanel.tsx:760-990,2251-2385`, `src/sim/systems/data.ts:195-359,428-546,1466-1647`, `src/sim/systems/dataRuntime.ts:91-176,502-517` | Cleaning/pruning expose cash, PF-days, duration, researcher and data-engineer capacity. Untreated/raw and low-quality corpus creates bounded pressure; released model quality/capability degrades until hygiene work completes. |
| Danger semantics | `src/view/hud/ui/HudPrimitives.tsx:208-228`, `src/index.css:1870-1878`, callers such as `src/view/hud/panels/MapPanel.tsx:353-404`, `src/view/hud/panels/DataPanel.tsx:877-894,2309-2321` | Sell, delete, remove, demolish, prune, and equivalent destructive actions use `HudButton variant="danger"`/`data-destructive`; ordinary close/cancel remains a non-destructive ghost action. |

Environment routing is part of the release boundary, not a browser shortcut:

| URL | Role | Required source state |
| --- | --- | --- |
| `https://labline-dev.patryks.me/` | Dev/canary route for this second pass | Current worktree under review. |
| `https://labline.patryks.me/` | Master/release route | Clean `main` (the master release line); never use it as the current-worktree preview. |

No DNS, ingress, deployed bundle, or public-route result is implied by the
source paths above. Those checks remain explicit verification gates.

### Second-pass invariants

- **Before placement versus after placement:** map hover/selection owns the
  decision context before a build; `TileInspector` owns facts about an existing
  tile. A card must not display the same price, footprint, or capacity twice.
- **Office save boundary:** a draft may be edited and quoted freely, but only a
  validated Save action mutates the persisted HQ layout. Invalid overlap,
  out-of-bounds placement, insufficient cash, and insufficient staff/compute
  remain visible blockers rather than silent normalization.
- **Commercial risk:** acquisition filters, amount purchase, bulk purchase, and
  corpus hygiene actions must make scope, premium, cost, time, and capacity
  obvious. “Buy all” is not a second copy of “Buy amount”; it is a distinct
  bulk-scope action.
- **Bounded degradation:** data quality is an operational state. The model-drift
  penalty is bounded and recoverable, but it must be observable and not removable
  by a cosmetic label change.

## 2. Audited issue matrix

Priority is based on user impact and regression risk. “Landed” means the
contract exists in the current implementation. The second-pass browser comments
are mapped to exact owners in `docs/UI_BROWSER_COMMENT_REMEDIATION.md`.
Consumer migration and browser evidence are recorded explicitly below; source
suite evidence is settled, while final browser, public-dev, and release-boundary
checks remain open.

| Priority | Issue | Evidence / affected area | Resolution and current status |
| --- | --- | --- | --- |
| P0 | Undefined serving accent and legacy text aliases | `src/index.css:16-23`; legacy `text-dim` / `text-sky` consumers | `--color-serve`, `--color-dim`, and `--color-sky` are defined. **Landed**; aliases remain by design. |
| P0 | Progress controls used parallel names and incomplete semantics | `HudPrimitives.tsx`, `kit.tsx` | `HudMeter` is semantic; `ProgressBar` and `MeterBar` are compatibility wrappers. **Landed; compatibility aliases remain intentionally.** |
| P0 | Buttons could inherit submit behavior | `HudPrimitives.tsx:203-221` | `HudButton` defaults to `type="button"` and preserves explicit overrides. **Landed**. |
| P0 | Desktop activity strip rendered as a small Intel card; mobile strip clipped/behind content | `index.css:1066-1101`, `index.css:2134-2189`, `TrainingActivityBar.tsx` | Desktop spans rail-to-Intel; mobile spans the viewport above nav; workspace padding and z variables reserve it. Supplied browser QA passed at the recorded four viewports; supplemental widths/baselines remain follow-up. **Implemented contract; supplied evidence recorded.** |
| P0 | Duplicate desktop group banner and Models training summary | `LeftRail.tsx`, `TrainingActivityBar.tsx`, workspace drawer CSS | Group labels remain in the rail; the visible work surface owns the title; the global summary yields to the detailed Models queue. **Implemented.** |
| P0 | Finance readouts were independently derived in shell chrome | `TopBar.tsx`, `CommandDock.tsx`, `financeDashboardModel.ts` | Shell and migrated panel consumers use `selectFinanceDashboardView` / `selectFinanceDashboardReadouts`; missing `dayNet` and `dayTotalOut` saves have one selector fallback. **Implemented; no independent shell derivations remain.** |
| P1 | Raw card/button/tab/menu variants proliferated | legacy panel markup, `.glass`, `.hud-surface`, `.btn-*`, local KPI cells | Canonical primitives and compatibility aliases cover the settled HUD, menus, and dense surfaces. Alias removal remains a deliberate compatibility hold until all external consumers are proven absent. **Implemented contract.** |
| P1 | Spacing, radius, type, breakpoints, and touch targets drift | ad-hoc panel values and legacy media queries | Canonical `hud-space`, radius, control, touch-target, and shell geometry tokens are applied across the settled shell/panel tree. **Implemented; supplemental visual/a11y baselines remain open.** |
| P1 | Chart ownership and non-visual data access varied | panel-local SVG/canvas charts | Shared line, loss, radar, donut, sparkline, and geometry contracts define active/pinned data access and text summaries; direct-manipulation canvas/radar and map/research surfaces remain documented exceptions. **Implemented.** |
| P1 | Sheets/dialogs did not share focus ownership | More sheet, menu overlays, checkpoint evaluation | More sheet and `ConsoleDialog` provide focus/Escape/return contracts; periodic benchmark-day results are non-modal; Settings/CommandDock/TopBar disclosure semantics are explicit and Escape regression coverage is rechecked. **Implemented; supplemental a11y evidence remains open.** |
| P1 | Training/benchmark data could drift between surfaces | Models queue, global activity, benchmark cards | Shared training view model and explicit public/private benchmark adapter own queue/activity/benchmark presentation; legacy-save fallback and overlay preservation are covered. **Implemented.** |
| P2 | Tiny labels, duplicated tips, local loading/error states | settled panels and overlays | Shared `HudState`, progressive disclosure, and the type floor are applied across migrated surfaces. **Implemented; optional copy polish only.** |
| P2 | Motion, reduced-motion, and state treatment vary | local hover/loading/error styles | Shared classes/tokens and state primitives are in place; remaining evidence is the whole-matrix reduced-motion/accessibility pass. **Implemented contract; evidence open.** |
| P2 | Generated imagery risks becoming pixel-copy requirements | concept images and future mockups | This plan and the README define the intent-only policy. **Contract established; apply to future references.** |

## 3. Target information architecture

### Desktop grouped IA

`SHELL_NAV_GROUPS` is the visual shell contract. It is one level deep:

- **Operate** — Overview, Workloads, Processes, Finances
- **Build** — Facilities, Hardware, Infrastructure
- **Products** — Models, Datasets, Benchmarks, Plans, Market
- **Company** — People, Research, Strategy

The older `NAV_GROUPS` table remains a compatibility surface for numeric and
legacy shortcut behavior. It must not be exposed as a second visible hierarchy.
Group headings are landmarks in the rail, not tablists. Selecting a destination
retains the existing `PanelId`, presentation mode, store route, and hotkey.

### Mobile IA

The five bottom destinations are Build, Models, Plans, Data, and More. The first
four are `MOBILE_PRIMARY_TABS`; all other panels plus Intel, Objectives, and
Destroy remain in the focus-managed More sheet. More is a dialog-like sheet with
Escape and focus restoration, not a nested tablist.

### One-title rule

The active work surface owns exactly one visible panel title. The group label is
visible in the desktop rail only. A mobile sheet may retain an accessible heading
for context, but must not add a second visible `PRODUCTS`, `LAB`, or group banner
above the panel's title. Breadcrumb/context is allowed only when it conveys a
real route or action; otherwise keep it screen-reader-only or remove it.

Within a panel, use headings, steppers, filters, accordions, or a single-level
view selector. Never place a tablist inside another tablist and never turn a
card containing buttons into a second competing action surface.

## 4. Shared primitive and chart registry

### HUD primitives

`src/view/hud/ui/HudPrimitives.tsx` is the low-level registry:

- `PanelScaffold` — one title/description/action header;
- `MetricTile` — compact labeled number with tone;
- `StatusChip` — compact state signal;
- `HudMeter` — one semantic 0..1 progress implementation;
- `ProgressBar` — legacy progress compatibility wrapper;
- `EmptyState` and `HudState` — empty/loading/error states;
- `HudButton` — shared variants, disabled reason, default button type;
- `HudInput`, `HudSelect`, and `HudRange` — shared form control hooks.

`src/view/hud/ui/kit.tsx` is the dense-workbench registry:

- `GameCard` — one card primitive with heading linkage, selected and optional
  single-activation semantics;
- `SegmentedTabs` — one-level roving-focus tablist with Arrow/Home/End and
  optional `aria-controls`;
- `StatRow` — ledger label/value row;
- `MeterBar` — tone/live compatibility wrapper around `HudMeter`;
- `BlockerList` — actionable reason rows, optionally `aria-live="polite"`;
- `LiveDot` and `CardGrid` — activity and repeated-card layout helpers.

Existing aliases and class names stay defined until `rg` proves no consumers
remain and a replacement visual baseline exists. Primitives do not own game
state, callbacks, route IDs, or persistence.

### Chart/data-visualization registry

| Component | Use | Required behavior |
| --- | --- | --- |
| `LineChart` | General time-series readouts | Hover nearest point; click/tap pins the point; repeat click unpins; keyboard point navigation and live readout. |
| `TrainingLossChart` | Selected Models run | Loss, stage markers, checkpoints, and capability share the selected run; hover/pin/keyboard semantics mirror `LineChart`. |
| `ResponsiveDonut` | Channel/cost/share composition | Interactive slices and compact legend expose the same value; hover/pin/keyboard states are announced. |
| `RadarChart` | Benchmark suite comparison | Metric vertices are direct-manipulation controls with hover/focus, click/tap pin, and keyboard selection. |
| `TrainingDataRadar` | Training data allocation | Drag/pointer manipulation is retained; slider handles expose min/max/current values and keyboard adjustment. |
| `Sparkline` | Small KPI trend pointer | Must retain an owner, period, unit, and an adjacent text value; it is not a second source of truth. |

Every chart or canvas declares its owner, series/metric IDs, units, range, and a
short text summary. The standard chart interaction contract is:

1. pointer hover updates the active readout without changing state;
2. click/tap pins the active datum and the same datum toggles the pin off;
3. `ArrowLeft`/`ArrowRight` (and Up/Down where spatially appropriate) move the
   focused datum; `Home` and `End` jump to bounds;
4. `Enter` or `Space` pins the focused datum; `Escape` clears the pin; and
5. the active datum exposes a meaningful label, `aria-pressed` when pinned, and
   a polite live/text summary for assistive technology.

The map and research canvases are documented exceptions below; their spatial
relationships must still have a meaningful label and a reachable detail path.

## 5. Canonical data ownership

Visual components format selectors; they do not derive a competing game state.

| Domain | Canonical owner | Cross-surface projection | Boundary |
| --- | --- | --- | --- |
| Current cash, day revenue, P&L, costs, runway, history | `financeDashboardModel.ts` (`selectFinanceDashboardReadouts`, `selectFinanceDashboardView`) | TopBar KPI/history, CommandDock P&L, objectives, compact status strip | Missing legacy `dayNet` uses revenue − product COGS − energy; missing `dayTotalOut` uses revenue − net. Channel rows remain explanatory. |
| Public benchmark suites and released-model comparison | `buildPublicBenchmarkData` and `buildBenchmarkViewModel(..., {kind: 'public'})` | Leaderboard, compare/released cards | Normalize legacy model evaluation fields once; consumers do not read persisted suite fields directly. |
| Private checkpoint/evaluation evidence | `buildBenchmarkViewModel(..., {kind: 'private-evidence', scores, profile})` | Models review/checkpoint surfaces | Private evidence is explicit and never falls back to public capability or benchmark fields. |
| Training jobs, stage, issue, ETA, urgency, action | `trainingJobViewModel.ts` (`normalizeTrainingJobs`, `buildTrainingJobViewModel`, `buildTrainingActivity`) | Models queue/detail, global TrainingActivityBar, objectives | The global strip is a pointer/action surface; Models owns detailed run state and review controls. |
| Dataset inventory and quality | Data panel/domain store | Blockers/status chips in dependent workflows | Do not clone inventory KPIs into every card. |
| Research graph and capability relationships | Research panel/canvas model | Research live chip and selected-node details | Canvas owns spatial relationships; selected detail owns exact facts. |
| Plans, demand, pricing, entitlements | Plans panel/domain model | Revenue/P&L pointer | Forecast range/scenario belongs to the demand chart. |
| Compute, power, infrastructure | Compute/Power domain models | Map badges and bottom operations strip | Capacity charts own their denominator and reservation state. |
| Rivals/world feed | CommandDock feed model | Alert count and Intel pointer | Feed owns event text and timestamp. |

## 6. Models workflow and global activity strip

The Models workbench has one compact run queue and one single-level workflow:

- Queue views: **Runs**, **Checkpoints**, **Fleet**;
- workflow steps: **Define → Data → Compute → Review**;
- `+ New model` remains the entry action;
- selecting a run owns its detailed stage, loss, checkpoint, benchmark, and review
  content; and
- Resume, Recover-from-checkpoint, release, decision, and terminal callbacks
  remain the existing store actions.

`ModelsTrainingQueue` consumes the same training view model as the global strip,
so stage, issue, ETA, urgency, and primary action cannot drift. The queue may
show more detail than the global strip but must not create a second derivation.

The global `TrainingActivityBar` is a compact operational projection:

- stages: Training/base, post-training (`SFT`, `RLHF`, `PROCESS`, `TOOLS`), and
  Review;
- issues: failed run, pending campaign decision, resource/power/memory block,
  diagnostic stall, instability, or explicit stall reason;
- actions: open the run/Models, Resume a paused run, or Recover an eligible
  failed post-training run; and
- multi-job state: each job remains selectable/visible in the strip, with the
  summary suppressed while the Models workbench is open to avoid duplicate copy.

An idle state is one concise line plus the Models action; it must not repeat
“Training activity” and “Training idle” as separate empty-state headings.

## 7. Shell geometry, z-index, and menu rules

### Geometry contract

The shell uses these CSS variables as the reviewable geometry API:

- `--hud-top`, `--hud-rail`, `--hud-intel`, `--hud-intel-rail`, and `--hud-ops`
  define desktop chrome;
- `--workspace-width` and `--intel-width` define open surface widths;
- `--hud-bottom-operations-top` and `--hud-bottom-telemetry-bottom` reserve
  expanded operations/map telemetry space;
- `--hud-training-height` reserves the mobile activity row; and
- `--hud-control-touch` is the 44px-or-larger touch target token.

On desktop the activity strip is positioned from the rail edge to the Intel edge
and above the operations row; it is not a narrow right-hand card. On mobile it is
full viewport width, above the bottom nav, and workspace/Intel scroll bodies add
bottom padding equal to the reserved training height. The approved geometry
helpers are `desktopTrainingActivityRect` and `mobileTrainingActivityRect`.
The supplied QA also confirms the analogous mobile More menu stacks above the
Training activity strip and that scroll clearance remains above the bottom nav.

Mobile stacking order is explicit: workspace/sheets < Intel < training strip <
map tools/More layer < bottom nav < objectives. The corresponding variables are
`--hud-z-workspace: 24`, `--hud-z-intel: 27`, `--hud-z-training: 28`,
`--hud-z-map: 29`, `--hud-z-mobile-nav: 30`, and `--hud-z-objectives: 31`.

### Navigation and menus

- Desktop rail groups are visual headings, never nested tablists.
- Mobile More is a focus-managed sheet with a labelled dialog surface, close
  action, Escape handling, and return focus.
- `SettingsPanel` uses section navigation and labelled regions, not a tablist
  inside another tablist.
- `CommandDock` disclosure controls expose `aria-expanded`, `aria-controls`, and
  a labelled region; TopBar KPI history does the same.
- `ConsoleDialog` is the shared portal/focus/Escape/restore owner for benchmark
  events, HotkeyHelp, and other dialog-like menus.
- New game, Pause, Settings, save/load, quit, hotkey help, and benchmark dismiss
  callbacks are retained. Tightening copy or spacing is not permission to drop a
  setting or terminal branch.

## 8. Migration waves and panel groups

| Wave | Scope | Current status and exit gate |
| --- | --- | --- |
| 0. Foundation and tokens | `index.css`, `HudPrimitives`, `kit`, primitive tests, docs | **Landed.** Aliases, semantic meter, default button type, card/tab/input/state contracts are additive. |
| 1. Shell/navigation | `App`, `TopBar`, `LeftRail`, `BottomBar`, `CommandDock`, `MapNavigator`, `ObjectivesDock`, `TrainingActivityBar`, shell contracts | **Supplied browser QA recorded.** Keep PanelIds/hotkeys/map actions; supplemental widths and visual baselines remain follow-up. |
| 2A. Menus and overlays | NewGame, Pause, Settings, `LablineMenuShell`, HotkeyHelp, `ConsoleDialog`, checkpoint evaluation | **Current source contract.** Saved-game Models flow, non-modal benchmark-day behavior, focus/Escape, and terminal behavior require second-pass regression verification. |
| 2B. Core workbenches | Models, Build, Data, Research, Plans | **Current source contract.** Shared queue/stepper, chart ownership, direct-manipulation exceptions, and feature parity are acceptance criteria; final verification remains open. |
| 3. Analytics and operations | Benchmarks, Stats, Org, Marketing, Rivals, Compute, Power, Racks, Allocate, command feeds | **Landed.** Canonical selectors, charts, tables, and status states are in the settled tree. |
| 4. Legacy utility and edge surfaces | Chips, Buildings, Events, map/build/destroy inspectors, special decision cards | **Current source contract with deliberate exceptions.** Direct manipulation and terminal outcomes remain preserved; Fleet row activation and browser behavior require second-pass verification. |
| 5. Responsive/accessibility/visual closure | all panel groups and references | **Supplied evidence complete.** Browser QA, source suite, e2e, TypeScript, lint, build, and diff checks are recorded below; only clean-worktree review remains open. |

### Per-panel migration status

| PanelId / surface | Group | Status | Next bounded action |
| --- | --- | --- | --- |
| `map` / map stage | Operate | Implemented; map canvas is a deliberate exception | Maintain map-first geometry, map controls, marker labels, and build/destroy routing. |
| `computeMarket` | Operate | Implemented | Maintain finance/compute selectors and shared dense states. |
| `rivals` | Operate | Implemented | Maintain Intel/CommandDock feed ownership and rival KPI coverage. |
| `stats` | Operate | Implemented | Maintain finance dashboard ownership for current/history readouts and chart summaries. |
| `build` | Build | Implemented | Maintain placement/cost/capability actions and touch coverage. |
| `racks` | Build | Implemented | Maintain hardware cards and blocker/state primitives. |
| `power` | Build | Implemented | Maintain capacity denominator, state chips, and responsive grid. |
| `models` | Products | Implemented; workflow/queue and detail contracts | Maintain chart ownership, private evidence adapter use, and nested-interaction coverage. |
| `data` | Products | Implemented; direct allocation manipulation exception | Maintain inventory ownership, slider/radar accessibility, and allocation actions. |
| `benchmarks` | Products | Implemented; public/private adapter boundary | Maintain public cards/compare/leaderboard through the public adapter and keep private evidence explicit. |
| `plans` | Products | Implemented | Maintain pricing/entitlement actions and demand chart ownership. |
| `market` | Products | Implemented | Maintain market/share actions and finance selector ownership. |
| `org` | Company | Implemented | Maintain type floor, KPI treatment, and people/capital actions. |
| `research` | Company | Implemented; canvas exception | Maintain pan/zoom/node action model and selected-node text/keyboard path. |
| `marketing` | Company | Implemented | Maintain channel actions and revenue/reach ownership. |
| `allocate`, `chips`, `buildings`, `events` | Legacy utilities | Implemented; direct-manipulation/choice-card exceptions retained | Maintain map/build, compute allocation, event callbacks, and Fleet row-selection regression coverage. |
| Intel, Objectives, BottomBar, menus, overlays | Shell/utilities | Current source contract; prior browser evidence is baseline only | Maintain disclosure, z-index, focus, and no duplicate fact ownership; second-pass widths/baselines remain open. |

## 9. Compatibility and non-regression gates

Every wave must prove:

- **Actions:** callbacks fire with the same arguments and only for the same user
  intent; disabled actions remain disabled and expose the reason.
- **State:** selectors, timers, loading/error/empty branches, and live updates
  remain owned by the same store/module; no visual component adds a source of
  truth.
- **Navigation:** every existing `PanelId`, setPanel/deep-link route, refresh,
  rail selection, mobile More destination, and panel presentation mode remains
  valid.
- **Transport:** pause/play, speed, simulation clock, objectives, map camera,
  build/destroy, and keyboard shortcuts retain labels, key bindings, and
  dispatch order.
- **Economy:** cash, P&L, channel breakdowns, compute allocation, history, and
  runway retain their existing semantics, including legacy-save fallbacks.
- **Models:** Resume, Recover, New Model, campaign decisions, checkpoints,
  release, and review remain available with identical store effects.
- **Menus:** save, load, new game, reset, quit, settings, hotkey help, benchmark
  dismiss, Escape/backdrop/close behavior, and focus return retain outcomes.
- **Visual compatibility:** legacy tokens/classes are removed only after a
  repository-wide usage check and a replacement screenshot exists.

The reference is not a license to alter feature, action, state, hotkey, save, or
deep-link behavior. Any intentional exception must be recorded in the release
notes and covered by a focused regression test.

## 10. Responsive and browser matrix

Static tests cannot prove CSS geometry. Browser-level checks are required for the
following matrix. The supplied second-pass QA set is recorded as passed below;
the two supplemental phone widths and wider visual baseline rows are not implied
passes.

| Class | Viewports | Required assertions |
| --- | --- | --- |
| Small phone | 320×568 | **QA passed:** no page or active-drawer horizontal overflow (`clientWidth == scrollWidth`); top essentials visible; sheets scroll independently; primary actions meet the touch contract; no console errors. |
| Supplemental phone | 360×800 | Outside the supplied final QA acceptance set; no open release gate. |
| Large phone | 390×844 | **QA passed:** no page or active-drawer horizontal overflow (`clientWidth == scrollWidth`); activity strip is above nav; workspace bottom padding prevents overlap; KPI popover stays in viewport; no console errors. |
| Supplemental large phone | 430×932 | Outside the supplied final QA acceptance set; no open release gate. |
| Tablet portrait | 768×1024 | Outside the supplied final QA acceptance set; no open release gate. |
| Tablet landscape | 1024×768 | Outside the supplied final QA acceptance set; no open release gate. |
| Compact desktop | 1280×720 | **QA passed:** no page or active-drawer horizontal overflow (`clientWidth == scrollWidth`); rail labels remain usable; active work surface and primary action fit; activity strip is not a small card; no console errors. |
| Standard desktop | 1440×900, 1920×1080 | Outside the supplied final QA acceptance set; no open release gate. |
| Large desktop | 2560×1440 | Outside the supplied final QA acceptance set; no open release gate. |
| Browser QA desktop | 1465×1354 | **QA passed:** no page or active-drawer horizontal overflow (`clientWidth == scrollWidth`) and no console errors. |

The supplied browser QA passed at 1465×1354, 1280×720, 390×844, and 320×568:
the page and active drawer each reported `clientWidth == scrollWidth`, with no
console errors. It also covered the Build idle/pre-placement tooltip, Models,
Research, HQ editor, Overview, Finances, Plans, Data, Benchmarks, and the mobile
More/activity/bottom-nav stacking path. The 360×800, 430×932, and wider visual
baseline rows are outside the supplied final QA acceptance set and are not open
release gates.

The corrective descendant-level pass also proved the fixed-surface boundaries:
desktop drawer/training edges are 1210/1206 at 1465×1354 and 576/572 at
1280×720 (shared four-pixel border/shadow only); mobile drawer/training edges are
708/717 at 390×844 and 432/441 at 320×568. Visible non-graph descendants reported
no hidden/clip width violations. The 320px Research workbench now uses the outer
drawer as its single scroll owner and was interactively scrolled to the graph;
the model-size scale and compact workflow labels were also checked at their edge
positions.

## 11. Verification commands and current evidence

The source-suite, browser, route, and engineering evidence is now settled for
the current second-pass diff. Only clean-worktree review remains open because
the work is uncommitted:

- [x] Full unit/source suite — exit 0; 231 passed test files + 2 skipped (233
      total); 1,556 passed tests + 8 skipped (1,564 total); 303.32s.
- [x] BuildTray duplicate-instruction regression — one idle instruction; focused
      `src/view/hud/uiRevamp.test.ts` construction-guidance assertion is 14/14,
      with the focused TypeScript check passing.
- [x] `rtk npm run test:e2e` after all source changes — 1 file, 15/15 tests,
      7.88s.
- [x] Final Luna mobile fixes — TypeScript pass; build passed with 4,837 modules;
      lint passed; diff check passed. The only build note is the existing large
      chunk warning.
- [x] Browser QA passed at 1465×1354, 1280×720, 390×844, and 320×568. At each
      viewport the page and active drawer reported `clientWidth == scrollWidth`
      and there were no console errors.
- [x] Browser workflow assertions: Build renders exactly one idle instruction
      (`src/view/hud/BuildTray.tsx`); the pre-placement tooltip includes land,
      slope, zone, time, power, access,
      traffic, status, and total; Models has no debug strings/no overflow;
      Research exposes all 102 nodes and new mobile semantic targets are at least
      44px; HQ exposes its editor palette; Overview exposes governance; Finances
      owns capital; Plans has the correct tabs/usage placement/New-last order;
      Data has usable filters, single purchase and danger actions; Benchmarks
      (`src/view/hud/panels/BenchmarksPanel.tsx`,
      `src/view/hud/panels/BenchmarkCompareTab.tsx`) has collapsible shared
      filters.
- [x] Analogous mobile shell fix: More menu (`src/view/hud/LeftRail.tsx`,
      `src/view/hud/mobileShellContracts.ts`) stacks above Training activity and
      open surfaces retain scroll clearance above the bottom navigation.
- [x] Public-dev deployment: release
      `65f098854090-ui4-20260816T132601Z`, assets
      `index-Cr8_rIfr.js` and `index-BxISYEBi.css`, zero restarts, with the prior
      dev rollback retained.
- [x] Master route `https://labline.patryks.me/` remains unchanged and serves
      `index-DE9d6C2T.js` and `index-BPCXeejq.css`; dev/master asset separation
      is recorded.
- [x] Documentation-only diff check for the files changed by this pass (recorded
      after the edits below).

Useful focused commands for maintenance and follow-up evidence:

```text
rtk npm run test -- --run src/view/hud/TrainingActivityBar.test.tsx src/view/hud/CommandDock.test.tsx src/view/hud/TopBar.test.tsx src/view/hud/panels/models/TrainingEvidencePanel.test.tsx
rtk npm run test -- --run src/view/hud/data/financeDashboardModel.test.ts src/view/hud/trainingJobViewModel.test.ts
rtk npm run lint
rtk npm run build
rtk git diff --check
```

## 12. AI-generated reference policy

Generated mockups are review artifacts for density, hierarchy, color balance,
and alternate states. Before implementing one, map each accepted decision to a
token, primitive, layout rule, and behavior contract. Use real DOM labels,
selectors, keyboard behavior, responsive CSS, and live data. Do not ship raster
UI, copy coordinates from pixels, infer game behavior from an image, or treat a
generated screenshot as the implementation source.

## 13. Final evidence and closure checklist

The effort may claim visual closure only when the following evidence exists:

- [x] Desktop and mobile references, prompt intent, and deliberate exceptions
      are documented.
- [x] Foundation tokens, aliases, semantic meter/button/card/tab/input/state
      contracts are documented and tested in their focused source slice.
- [x] Grouped IA, mobile More contract, one-title rule, shell z/geometry API,
      finance/training/benchmark ownership, and menu semantics are documented.
- [x] Existing feature/action/state/hotkey/save/deep-link contracts are listed as
      non-regression gates.
- [x] Every settled panel consumes the canonical owner for each KPI, chart, feed,
      and action; deliberate map/research canvas and direct-manipulation
      exceptions are documented.
- [x] No known nested tablists or nested interactive card/button structures
      remain in the settled HUD; deliberate choice-card/canvas exceptions are
      covered by focused behavior tests.
- [x] Shared primitives cover the settled panel tree; compatibility aliases are
      retained intentionally until independent external-consumer evidence allows
      removal.
- [x] Second-pass browser geometry/overflow and supplied workflow evidence at
      1465×1354, 1280×720, 390×844, and 320×568, including the no-console and
      page/active-drawer width checks.
- [x] Full source-suite evidence for this second pass: exit 0; 231 passed test
      files + 2 skipped (233 total); 1,556 passed tests + 8 skipped (1,564 total);
      303.32s.
- [x] BuildTray duplicate-instruction regression: one idle instruction; focused
      14/14 and TypeScript pass.
- [x] Public-dev deployment and master-route asset/bundle evidence for this
      second pass, including release ID, zero restarts, retained rollback, and
      unchanged production assets.
- [x] E2e, TypeScript, lint, build, and diff-check evidence for this second pass;
      e2e is 1 file / 15 of 15 tests in 7.88s, and the build processed 4,837
      modules with only the existing large-chunk warning.
- [x] The browser-comment ownership map and current-worktree acceptance criteria
      are documented in `docs/UI_BROWSER_COMMENT_REMEDIATION.md`.
- [ ] Final clean-worktree diff review confirms docs/source boundaries and no
      unexplained behavior change.

Until the unchecked item is evidenced, the accurate status is “second-pass
browser/public-dev/deployment/master-route and engineering checks complete;
clean-worktree review remains pending because the work is uncommitted,” not
“pixel parity, deployment, or release completion claimed.”
