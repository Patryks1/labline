# Labline UI Revamp — Design System Contract

Status: second-pass design-system contract for the current worktree. The
token/primitive foundation, grouped shell, activity strip, shared
finance/training/benchmark adapters, disclosure semantics, panel ownership,
settled source-suite/browser-route evidence, and final engineering checks are
recorded here. Only clean-worktree review remains open because the work is
uncommitted.

This is a visual and interaction contract for a strategy game. It never replaces
the simulation, store, route, hotkey, persistence, or callback contracts.

## North star

The approved references are:

- desktop: `docs/ui-concepts/labline-ui-streamline-desktop.png`;
- mobile: `docs/ui-concepts/labline-ui-streamline-mobile.png`.

The target is a near-black map stage with translucent, restrained chrome: one
compact top command bar, one grouped left rail, one active work surface, a compact
Intel/context surface, and a thin live operational strip. Mobile preserves that
hierarchy with a compact header, one panel title, a full-width activity row, and
Build / Models / Plans / Data / More navigation.

The images are composition and density references, not DOM, copy, data, or
behavior sources. The accepted generation intent was “dark frontier strategy-game
operations console; near-black world map; calm compact top bar; grouped rail; one
active workbench; thin multi-job status strip; mint positive state; amber
training/attention state; restrained translucent surfaces; no duplicate headings
or dashboard card walls.”

## Non-negotiable rules

1. Keep every existing feature and store action. Reorganize presentation without
   deleting capability.
2. Each fact, KPI, chart, feed, and action has one owner. Cross-surface copies are
   compact pointers, not competing derivations.
3. The active work surface has one visible title. Group labels belong in the rail;
   a redundant `PRODUCTS`/`LAB` banner above a panel is not allowed.
4. Use one desktop navigation level and one local panel view selector at most.
   Never nest tablists. Use headings, steppers, accordions, filters, or dialogs for
   deeper structure.
5. A card is not an interactive wrapper around other buttons. Use `GameCard` for
   presentation, or an explicit single-activation card with no competing child
   actions.
6. Disabled controls remain disabled and expose the reason. Empty/loading/error
   states are concise and actionable; do not repeat the same idle explanation in
   shell and panel.
7. Numbers use IBM Plex Mono and tabular figures. Interface text uses Space
   Grotesk. Never use text smaller than 0.625rem except axis ticks.
8. Cards use an 8px radius; controls use 6px; pills are the only fully round
   shape. Motion is subtle (150–250ms ease-out) and respects reduced motion.
9. Touch actions are at least 44px tall/wide on mobile. Text uses `min-w-0`,
   truncation, and safe-area-aware layout where needed.
10. Existing aliases remain until all consumers migrate and a repository-wide
    usage check plus replacement visual evidence justifies removal.

## Second-pass architecture addendum

The browser-comment pass is governed by the following ownership map. These are
behavior and layout contracts for the current source tree; the verification
section records the supplied route and viewport evidence without expanding it
into an untested full matrix.

| Surface | Owner | Design rule |
| --- | --- | --- |
| Company identity | `src/view/hud/TopBar.tsx:46-73`; `src/view/hud/NewGameMenu.tsx:90-100,578-604,661-684`; `src/sim/createGame.ts:49-58,177-202` | Render the saved `RunConfig.labName` and `companyMark` everywhere identity is shown. A fallback is valid only for a new or legacy save; hardcoded visible Labline branding is not. |
| Placement context | `src/view/hud/BuildTray.tsx:104-125,311-355`; `src/view/three/GameMap.tsx:1272-1290` | Before placement, show the land/zone/utility/status/footprint and exact total in the map tooltip or selected blueprint. Do not make the placed inspector repeat the build quote. |
| Compact inspector | `src/view/hud/TileInspector.tsx:49-257` | The inspector is a short context card for an existing tile. Keep the close affordance shared through `HudCloseButton` and keep detailed facility facts in the owning fleet/facility surface. |
| Responsive filters | `src/view/hud/ui/HudFilterBar.tsx:1-140`; `src/index.css:1882-2032,3136-3159`; market integration boundary `src/view/hud/panels/DataPanel.tsx:1278-1446` | Filters have a labelled group, active count, clear behavior, 44px controls, and a narrow-screen disclosure. Chips wrap; select labels never clip or become unreadable. |
| Training and research | `src/view/hud/panels/ModelsPanel.tsx:1850-2021`; `src/view/hud/panels/ResearchPanel.tsx:230-499`; `src/view/hud/panels/researchCanvasLayout.ts:1-23` | Training Volume has one hierarchy and no duplicated raw/quality microcopy. Research uses fit-to-graph plus responsive queue/canvas/detail regions; no edge or selected-node detail may be stranded off-screen. |
| HQ office | `src/view/hud/panels/HqOfficeEditorOverlay.tsx:56-258`; `src/sim/systems/hqOffice.ts:30-100,200-220,327-419`; `src/view/hud/panels/OrgPanel.tsx:1295-1345` | People opens a floor editor modeled on the existing hall-editor pattern. Desks, plants, copiers, meeting and research objects have catalog effects. Draft edits are reversible; only validated Save persists the layout and effects. |
| Finances and Overview | `src/view/hud/panels/StatsPanel.tsx:27-95`; `src/view/hud/data/financeDashboardModel.ts:142-192`; `src/view/hud/panels/OverviewGovernance.tsx:39-167`; `src/view/hud/panels/MapPanel.tsx:99-107` | Capital/ownership is a Finance concern. Governance/policy is part of the main Overview. Avoid top-level Capital/Policy tabs and duplicate KPI cards. |
| Plans | `src/view/hud/panels/PlansPanel.tsx:385-523,1033+`; `src/view/hud/panels/plansPanelNavigation.ts:3-13`; `src/sim/systems/plans.ts:39,719+` | Usage/capacity context sits above the selector; only Demand/Tiers/API are tabs; `New plan` is last; eight plans is the UI and sim limit. |
| Data risk | `src/view/hud/panels/DataPanel.tsx:760-990,2251-2385`; `src/sim/systems/data.ts:195-359,428-546,1466-1647`; `src/sim/systems/dataRuntime.ts:91-176,502-517` | Hygiene work exposes cash, compute/PF-days, elapsed time, researchers, and data engineers. Untreated and low-quality corpus creates bounded, recoverable model drift; it is not cosmetic copy. |
| Danger actions | `src/view/hud/ui/HudPrimitives.tsx:208-247`; `src/index.css:1870-1878` | Destructive actions consistently use the danger variant and `data-destructive`; a normal close/cancel that only dismisses a surface remains ghost/secondary. |

### Environment policy

The current-worktree preview and the master route have separate responsibilities:

- `https://labline-dev.patryks.me/` is the dev/canary route and may point to the
  current worktree during this pass.
- `https://labline.patryks.me/` is the master/release route and must point only
  to a clean `main` checkout.

DNS, ingress, bundle identity, and public-route behavior are explicit release
checks. The supplied dev release and unchanged master assets are recorded in the
verification section; a local source read or private service is not a substitute
for that route evidence.

### Interaction invariants

- Pre-placement context and post-placement inspection are separate states. A
  tooltip may answer “can I build here?”; the inspector answers “what is here?”
  and should not replay the whole construction card.
- The HQ editor owns a draft until Save. Invalid overlap/out-of-bounds/capacity or
  budget states are blockers; closing without Save leaves the persisted plan
  unchanged.
- Bulk purchase is a distinct scope and price action, not a duplicated label for
  a selected-amount purchase. Acquisition filters must make scope and active
  state obvious at desktop and mobile widths.
- Data hygiene is bounded simulation state: raw/backlog and low-quality stock can
  degrade released models, while cleaning/pruning consumes real capacity and
  time. The UI must expose the tradeoff at the decision point.

## Token contract

The canonical aliases live in `src/index.css` (`@theme` and `:root`). Existing
names remain valid during migration.

| Family | Tokens | Contract |
| --- | --- | --- |
| Font | `--font-sans`, `--font-mono` | Space Grotesk for UI; IBM Plex Mono for numeric/technical readouts. |
| Surface | `--color-void`, `--color-panel`, `--color-panel-2`, `--color-panel-3`, `--color-line` | Near-black elevations and quiet borders. |
| Text | `--color-bone`, `--color-muted`, `--color-dim` | Primary, secondary, and legacy muted aliases. |
| Accents | `--color-mint`, `--color-amber`, `--color-train`, `--color-infer`, `--color-serve`, `--color-research`, `--color-danger`, `--color-gold` | One accent per card; `serve` is defined and remains compatible with inference blue. |
| Spacing | `--hud-space-1` … `--hud-space-6` | 0.25rem through 1.5rem in 0.25rem steps, scaled by `--ui-scale`. |
| Radius | `--hud-radius-card`, `--hud-radius-control`, `--hud-radius-pill`, legacy `--hud-radius` | 0.5rem / 0.375rem / full round; legacy radius aliases the card radius. |
| Controls | `--hud-control-compact`, `--hud-control-default`, `--hud-control-touch`, `--hud-control-icon` | 2rem / 2.5rem / max(2.75rem, 44px) / 2.25rem. |
| Shell | `--hud-top`, `--hud-rail`, `--hud-intel`, `--hud-intel-rail`, `--hud-ops`, `--workspace-width`, `--intel-width` | Reviewable desktop/mobile geometry API. |

Do not introduce a local spacing/radius scale when a token expresses the intent.
Dynamic chart widths and map coordinates may remain inline because they are data,
not visual constants.

## Shared component registry

### Foundation: `src/view/hud/ui/HudPrimitives.tsx`

- `PanelScaffold` — one panel title, optional eyebrow/description, and actions;
- `MetricTile` — labeled KPI with a single tone;
- `StatusChip` — concise state label;
- `HudMeter` — semantic `progressbar`, 0..1 input, bounded values, accessible
  name/value text, and optional live treatment;
- `ProgressBar` — compatibility wrapper around `HudMeter`;
- `EmptyState` / `HudState` — empty, loading, and error states;
- `HudButton` — primary/secondary/ghost/danger variants, disabled reason, and
  default `type="button"`;
- `HudInput`, `HudSelect`, and `HudRange` — shared form control styling and
  `aria-invalid`/range affordances.

### Dense workbench kit: `src/view/hud/ui/kit.tsx`

- `GameCard` — the one card primitive, with heading linkage, selected state, and
  opt-in single activation;
- `SegmentedTabs` — the one-level tablist primitive, with roving focus,
  Arrow/Home/End navigation, `aria-selected`, and optional `aria-controls`;
- `StatRow` — ledger label/value row;
- `MeterBar` — compatibility wrapper around `HudMeter` for tone/live consumers;
- `BlockerList` — explicit danger/warning reason rows, with opt-in polite live
  announcements;
- `LiveDot` and `CardGrid` — live indicator and repeated-card layout helpers.

The primitive layer formats values and exposes semantics; it does not select game
state, invoke stores on its own, or change caller-provided IDs/callbacks.

## Chart and interaction contract

The chart registry is:

| Component | Owner/use |
| --- | --- |
| `LineChart` | General time-series data. |
| `TrainingLossChart` | The selected Models run, including stage/checkpoint context. |
| `ResponsiveDonut` | Channel/cost/share composition with a compact legend. |
| `RadarChart` | Benchmark suite comparison. |
| `TrainingDataRadar` | Direct training-data allocation and slider handles. |
| `Sparkline` | Compact KPI trend pointer, never a second owner. |

Every chart declares an accessible name, owner, series/metric IDs, units, period
or range, visible legend/labels, and a short text summary. The shared point
interaction is:

- hover updates a readout only;
- click/tap pins the point/metric and a repeat click/tap unpins it;
- Arrow keys move the focused datum, Home/End jump to the first/last datum;
- Enter/Space pins the focused datum and Escape clears the pin; and
- focused points expose a meaningful label and `aria-pressed` when pinned, with a
  polite live readout for assistive technology.

The chart visual is never the only way to obtain the value. Tables or text
summaries remain the exact-value path where appropriate.

## Data ownership contract

| Domain | Owner | Permitted projections |
| --- | --- | --- |
| Cash, revenue, costs, P&L, runway, history | `src/view/hud/data/financeDashboardModel.ts` | TopBar KPI/history, CommandDock P&L, objectives, and compact strip. Missing legacy `dayNet`/`dayTotalOut` use the single adapter fallbacks. |
| Public benchmark data | `buildPublicBenchmarkData` / public `buildBenchmarkViewModel` context | Released-model cards, leaderboard, and compare surfaces. Normalize legacy evaluations once. |
| Private benchmark evidence | Explicit `private-evidence` benchmark context | Checkpoint/review views only. It never falls back to public capability or persisted public benchmark fields. |
| Training jobs, stage, issue, ETA, urgency, action | `trainingJobViewModel.ts` | Models queue/detail, global TrainingActivityBar, objectives. Models owns the full run workflow. |
| Dataset, research, plan, compute/power, and rival facts | Their domain panel/store | Compact status pointers in shell; no copied competing KPI/chart owner. |

The migration is not complete while a panel recomputes a value already provided by
one of these owners.

## Shell and navigation contract

### Desktop

`SHELL_NAV_GROUPS` provides one-level visual groups:

- Operate: Overview, Workloads, Processes, Finances;
- Build: Facilities, Hardware, Infrastructure;
- Products: Models, Datasets, Benchmarks, Plans, Market; and
- Company: People, Research, Strategy.

The compatibility `NAV_GROUPS` table and existing numeric/function shortcuts stay
stable. A visual group heading is not a `tablist`; each destination still resolves
to its existing `PanelId` and store route.

### Mobile

`MOBILE_PRIMARY_TABS` is Build / Models / Plans / Data. All other panels plus Intel,
Objectives, and Destroy are in the More sheet. More is focus-managed, labelled,
Escape-closeable, and returns focus to its trigger. It is not a nested tablist.

### Work surface

The map remains the contextual stage. TopBar owns global time, transport, speed,
economy, and utility actions. The rail owns navigation. The active work surface
owns its one visible title, metrics, workflow, and at most one local selector.
The bottom activity/operations strip owns live operational pointers and links back
to the owning workflow. Intel is contextual and must not become duplicate
navigation.

### Geometry and stacking

- Desktop `TrainingActivityBar` spans from `--hud-rail` to `--intel-width` above
  the operations row; it is not a small right-hand card.
- Mobile it spans the viewport above the bottom nav; open workspace/Intel scroll
  bodies reserve `--hud-training-height` as bottom padding.
- Expanded operations adjust `--hud-bottom-operations-top` and telemetry bottom
  offsets rather than covering the active work surface.
- Mobile z layers are workspace 24, Intel 27, training 28, map/More 29, bottom
  nav 30, and objectives 31 (`--hud-z-*` variables in `index.css`).

The geometry helpers `desktopTrainingActivityRect` and
`mobileTrainingActivityRect` are static contracts. Supplied QA passed at
1465×1354, 1280×720, 390×844, and 320×568 with page and active-drawer
`clientWidth == scrollWidth` and no console errors. The analogous mobile More
menu stacks above Training activity and open surfaces retain clearance above the
bottom nav. Other matrix widths remain follow-up evidence.

## Models and training contract

Models presents one compact semantic queue navigator for Runs / Checkpoints /
Fleet. These destinations are not tabs. `+ Train model` is the single prominent
creation entry point and opens the viewport-level training dialog; the creation
form must never auto-open simply because the queue is empty or reappear inline
inside the workbench.

The dialog owns Define → Data → Compute → Review. Its scrollable body owns the
current step while the persistent bottom footer owns the stepper, Back/Continue,
Cancel, and final Start action. `ConsoleDialog` supplies focus entry/trapping,
Escape, labelled Done, and focus restoration; there is no X glyph. The selected
run remains in the Models workbench and owns detailed loss, stage, checkpoint,
benchmark, review, Resume, Recover, release, and decision actions. Starting a
run closes the dialog, selects the new job, and leaves `+ Train model` available
for another concurrent configuration.

The global activity strip uses the same training view model and exposes stage,
progress, ETA, issue, and primary action. It supports Training/base,
post-training stages, Review, paused/stalled/failed/ready issues, Resume,
Recover, and Open Models. Multi-job detail remains visible; the summary is
suppressed while Models is open to avoid duplicate training copy. Idle is one
concise state plus a Models action.

### Checkpoint branching

A checkpoint is an immutable snapshot of one run's weights and progress, not a
second copy of the live model. `Branch model` on an eligible live run first
saves that exact point, then opens the same branch dialog used by checkpoint
history. Starting the branch creates a separate child training job while the
source run continues unchanged. The child inherits the saved weights and
lineage, starts its own progress at 0%, and owns independent data, compute,
pause/cancel, benchmark, and release decisions.

Checkpoint history renders one source run at a time. A compact semantic run
navigator switches histories; it must not mount several complete checkpoint
workspaces in one scrolling column. The selected checkpoint owns one primary
`Branch new model` action and lists any existing children beneath it. Evaluation,
promotion, restart, discard, and rollback controls remain available without a
nested tablist or duplicate timeline.

The branch dialog uses the shared `ConsoleDialog` contract and offers General,
Code, Cyber, Chat, Agents, Reasoning, Safety, and Custom specialisations. Cyber
weights Code, Law, and Chat more heavily. Validation still passes through the
canonical training start path, so insufficient fresh data, compute, cash, or
staff appears as an in-dialog error and never mutates the parent checkpoint.

### Training evidence ownership

Benchmarking a live run is checkpoint-first. The action captures or reuses the
exact current weights, then opens evaluation setup for that immutable checkpoint;
the source run keeps training. Pending work and completed score intervals,
confidence, verdict, strength, and risk render in the selected run's always
visible `Benchmarks & reviews` surface. Checkpoint history retains the complete
archive, but it is not the only place a player can see active-run evidence.

Periodic public benchmark days update simulation evidence without mounting a
blocking overlay. Play, map input, and model operations continue without a
required acknowledgement.

Research-node selection changes detail state only. It must not modify the
canvas translate or zoom transform; explicit Fit, Reset, zoom, external focus,
and keyboard relationship actions remain the camera-changing controls. A
completed player data hall or HQ selected on the map exposes one `Open hall
editor` action routed to its data-hall or office spatial editor. Unrelated
buildings do not route through Fleet.

## Menus, dialogs, and disclosure

- Settings section navigation uses labelled regions and `aria-current`, not a
  nested tablist.
- CommandDock disclosure controls expose `aria-expanded`, `aria-controls`, and a
  labelled region even when the region is collapsed.
- TopBar KPI history exposes `aria-pressed`, `aria-expanded`, and
  `aria-controls`.
- `ConsoleDialog` owns portal, focus entry, Escape, close, and focus restoration
  for model creation, checkpoint evaluation setup, HotkeyHelp, and dialog-like
  menu flows. Completed benchmark-day results never interrupt play with a modal.
- Primary controls are never hidden behind a disclosure. Model numerics/model
  stack and Plans serving-compute allocation are always expanded. Disclosures
  remain valid only for secondary optional evidence whose collapsed state does
  not block the main decision or obscure the current operating state.
- NewGameMenu, PauseMenu, Settings, save/load/new game/quit, and every existing
  setting remain feature-equivalent. Copy/spacing changes cannot remove a branch.

## Deliberate exceptions

These surfaces are not forced into a generic static card/chart pattern:

- `RadarChart` metric vertices are direct-manipulation controls; they still have
  hover/focus/pin/keyboard/readout semantics.
- `TrainingDataRadar` allocation is direct manipulation with keyboard-accessible
  slider handles; its drag behavior is part of the feature.
- `MapNavigator` and the main map are canvas/spatial surfaces; marker controls and
  zoom/rotation/map actions remain spatial and must retain labels and reachable
  detail.
- `ResearchPanel` is a pan/zoom prerequisite graph; the canvas owns spatial
  relationships while the selected-node detail owns exact facts and actions.
- Model campaign/special choice cards in `ActiveTrainingCard` present mutually
  exclusive decisions as direct action buttons. They are not generic clickable
  cards wrapping nested buttons.

An exception preserves a feature interaction; it does not exempt the surface
from focus visibility, accessible names, reduced-motion, touch targets, or
non-regression coverage.

## Migration and definition of done

Migrate in this order:

1. foundation tokens/primitives and aliases;
2. shell/navigation/activity geometry and focus ownership;
3. menu/dialog/overlay semantics and feature parity;
4. Models, Build, Data, Research, and Plans workbenches;
5. Benchmarks, Stats, Org, Marketing, Rivals, Compute, Power, Racks, Allocate,
   and command feeds; then
6. legacy utilities, edge surfaces, responsive/a11y/visual closure, and alias
   removal.

For every panel, completion requires:

- canonical owner for each KPI/chart/feed/action;
- no nested tablist or nested interactive card/button structure;
- shared primitives for controls, cards, meters, inputs, selects, ranges, and
  states, with old aliases retained where consumers remain;
- hover/active/focus/disabled/loading/error/empty/reduced-motion states;
- keyboard and touch behavior at the responsive matrix; and
- focused tests proving callbacks, selected state, labels, and feature parity.

The final release additionally requires clean typecheck/lint/build, HUD and
simulation regression coverage, browser computed geometry, accessibility smoke
checks, and visual baselines against the approved references.

## Verification and evidence status

The source-suite, supplied browser/public-route evidence, and final engineering
checks are settled for the current browser-comment diff. Only clean-worktree
review remains open because the work is uncommitted:

- [x] Full unit/source suite — exit 0; 232 passed test files + 2 skipped (234
      total); 1,561 passed tests + 8 skipped (1,569 total); 325.32s.
- [x] BuildTray duplicate-instruction regression — one idle instruction; focused
      `src/view/hud/uiRevamp.test.ts` construction-guidance assertion is 14/14,
      with the focused TypeScript check passing.
- [x] `rtk npm run test:e2e` after all source changes — 1 file, 15/15 tests,
      7.88s.
- [x] Final Luna mobile fixes — TypeScript pass; build passed with 4,838 modules;
      lint passed; diff check passed. The only build note is the existing large
      chunk warning.
- [x] Browser QA passed at 1465×1354, 1280×720, 390×844, and 320×568. At each
      viewport the page and active drawer reported `clientWidth == scrollWidth`
      and there were no console errors.
- [x] Workflow QA passed: Build (`src/view/hud/BuildTray.tsx`) has exactly one
      idle instruction and a
      pre-placement tooltip with land/slope/zone/time/power/access/traffic/status/
      total; Models has no debug strings/no overflow; Research exposes all 102
      nodes and mobile semantic targets are at least 44px; HQ exposes its editor
      palette; Overview exposes governance; Finances owns capital; Plans has the
      correct tabs/usage placement/New-last order; Data has filters, single
      purchase and danger actions; Benchmarks
      (`src/view/hud/panels/BenchmarksPanel.tsx`,
      `src/view/hud/panels/BenchmarkCompareTab.tsx`) has collapsible shared
      filters.
- [x] Mobile shell QA passed: More (`src/view/hud/LeftRail.tsx`,
      `src/view/hud/mobileShellContracts.ts`) stacks above Training activity and
      open surfaces retain scroll clearance above bottom navigation.
- [x] Corrective overflow QA passed: desktop drawer/training edges are
      1210/1206 at 1465×1354 and 576/572 at 1280×720; mobile drawer/training
      edges are 708/717 at 390×844 and 432/441 at 320×568. The visible descendant
      clip scan is empty, model scale endpoints remain inside their track, and
      the 320px Research graph scrolls after the pod queue with no overlap.
- [x] Public-dev deployment QA passed: release
      `65f098854090-ui4-20260816T132601Z`, assets `index-Cr8_rIfr.js` and
      `index-BxISYEBi.css`, zero restarts, prior dev rollback retained.
- [x] Master route QA passed: `https://labline.patryks.me/` remains unchanged
      with assets `index-DE9d6C2T.js` and `index-BPCXeejq.css`.
- [x] Browser QA acceptance set is complete at 1465×1354, 1280×720, 390×844,
      and 320×568; other widths are outside the supplied final QA scope and do
      not remain open release gates.
- [x] Documentation-only diff check for the files changed by this pass (recorded
      after the edits below).

The settled panel tree's canonical owners, shared primitives, and deliberate
map/research/direct-manipulation exceptions remain the design baseline. The
browser/public-dev/deployment/master-route gates above are complete for the
supplied QA evidence. The browser-comment remediation map is maintained in
`docs/UI_BROWSER_COMMENT_REMEDIATION.md`; it is the source of truth for the
per-comment acceptance criteria and current verification status.

## AI mockup policy

AI-generated images may explore hierarchy, density, color balance, or a state. For
each accepted image record the intended zones, tokens, states, and motion, then
translate them into real React/CSS and live selectors. Raster output is a review
artifact only: never ship it as UI, copy its coordinates, or infer behavior from
pixels. The two approved Labline references and their prompt intent are the
current visual north star.

## Office and shell ownership addendum

- A workspace drawer has no shell-owned visible close button or reserved close
  gutter. Active rail destination, Escape, and direct navigation own collapse.
- The training activity strip is persistent status, never foreground chrome.
  Any open workspace, inspector, popover, or editor must outrank it and disable
  its pointer surface.
- HQ seats are spatial objects, not a building-number bonus. Starter capacity
  is represented by starter furniture; later capacity is represented only by
  saved desks/meeting seats. Hiring UI therefore belongs to the clicked office.
- Automatic floor layouts are recipes over canonical catalogue objects. They
  must never bypass collision validation, quoting, persistence, or simulation
  effects.
- Live state should animate a dot, meter, or graph datum. Do not animate the
  outer size/shadow of a dense work surface where pointer inspection could be
  perceived as expansion or layout shift.
- Graph tooltips belong to a fixed-size plot positioning context. They may
  track pointer/focus state but must never enter normal document flow or change
  their containing card's measured height.
- Continuous display values use two decimal places through the shared HUD
  formatters. Keep authored discrete counts, days, ordinal stages and slider
  priorities integral; humanize very small/large magnitudes with the nearest
  useful unit instead of scientific notation.
- Commercial tiers must differentiate on workload fit as well as price. A
  cheaper tier can own the mass-market majority, while viable higher-allowance
  tiers must remain attractive to heavier customer segments.
