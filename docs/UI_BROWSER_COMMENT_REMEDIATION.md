# Browser comment remediation map

Status: second-pass ownership, acceptance criteria, supplied browser/public-route
verification, and final engineering checks are recorded against the current
worktree. Only clean-worktree review remains open because the work is uncommitted.

The comments below are treated as behavior/ownership defects. “Pending” means
the source contract or focused test may already exist, but the final second-pass
browser and release-boundary evidence is still required.

## Settled source verification

- [x] Full unit/source suite — exit 0; 231 passed test files + 2 skipped (233
      total); 1,556 passed tests + 8 skipped (1,564 total); 303.32s.
- [x] BuildTray duplicate-instruction regression — one idle instruction; focused
      `src/view/hud/uiRevamp.test.ts` construction-guidance assertion is 14/14,
      with the focused TypeScript check passing.

## Settled browser and route verification

- [x] Browser QA passed at 1465×1354, 1280×720, 390×844, and 320×568. At every
      viewport the page and active drawer reported `clientWidth == scrollWidth`,
      with no console errors.
- [x] Corrective overflow geometry: at 1465×1354 the drawer ends at y=1210,
      Training activity begins at y=1206, and Live operations begins at y=1266;
      at 1280×720 the corresponding drawer/training edges are y=576/y=572. The
      four-pixel contact is the shared border/shadow, not content interception.
      At 390×844 the drawer ends at y=708 before Training activity at y=717; at
      320×568 it ends at y=432 before Training activity at y=441 and the primary
      nav at y=500.
- [x] Build QA: exactly one idle instruction; pre-placement tooltip includes
      land, slope, zone, time, power, access, traffic, status, and total.
- [x] Models QA: debug strings removed; model-scale end labels remain inside the
      track; 390px workflow names remain whole and 320px uses intentional
      `Def`/`Data`/`CPU`/`Rev` labels; the workflow entry scrolls above the fixed
      activity strip instead of being intercepted.
- [x] Research QA: all 102 nodes visible/reachable; default/reset is 62%, explicit
      Fit is 28%, and mobile semantic targets are at least 44px. At 320×568 the
      outer workspace body is the single scroll owner (`scrollTop` verified from
      0 to 708), so pods and the graph no longer overlap in the former nested
      67px viewport.
- [x] HQ editor palette, Overview governance, Finances capital, Plans tabs /
      usage placement / New-last ordering, Data filters / single purchase /
      danger actions, and Benchmarks collapsible shared filters verified.
- [x] Mobile shell QA: More stacks above Training activity and open surfaces
      retain scroll clearance above the bottom navigation.
- [x] Dev deployment: release `65f098854090-ui4-20260816T132601Z`; public assets
      `index-Cr8_rIfr.js` and `index-BxISYEBi.css`; zero restarts; prior dev
      rollback retained.
- [x] Master route: `https://labline.patryks.me/` remains unchanged with assets
      `index-DE9d6C2T.js` and `index-BPCXeejq.css`.

The browser/public-dev/deployment/master-route gates are complete for this
supplied QA set. Additional widths are outside the supplied final QA scope.

## Final engineering verification

- [x] `rtk npm run test:e2e` after all source changes — 1 file, 15/15 tests,
      7.88s.
- [x] Final Luna mobile fixes — TypeScript pass; build passed with 4,837 modules;
      lint passed; diff check passed. The only build note is the existing large
      chunk warning.
- [ ] Clean-worktree review remains intentionally open because the work is
      uncommitted.

## Comment map

Per-row pending notes now refer only to supplemental widths, deeper state
transitions, or separate release review; the supplied browser/public-dev/
deployment/master-route gates are complete in the evidence above.

| # | Issue | Owning component/source | Behavior contract and verification criterion | Status |
| ---: | --- | --- | --- | --- |
| 1 | Useful site facts are hidden in the placed inspector; show context before construction. | `src/view/hud/BuildTray.tsx:104-125,311-355`; `src/view/three/GameMap.tsx:1272-1290`; placed context `src/view/hud/TileInspector.tsx:49-257`; tooltip styles `src/index.css:964-978` | Hover an empty/blocked parcel while Build is active. The tooltip exposes zone, grade/utility/status, footprint and expected total before placement; the placed inspector stays compact and does not repeat the full blueprint quote. Verify desktop and 320/360/390/430px layouts without clipping. | Current worktree contract present; final browser/public-dev verification pending. |
| 2 | Close/X control looks awkward. | Shared `src/view/hud/ui/HudPrimitives.tsx:231-247` (`HudCloseButton`); `src/index.css:2034-2053`; consumers include `TileInspector.tsx:214-218`, `LeftRail.tsx:382-387`, `MapNavigator.tsx:560-565` | All drawers/inspectors use one aligned, labelled close control with visible hover/focus state, a 44px touch target, and no overlap with the title or viewport edge. Verify keyboard focus, Escape, and mobile safe-area placement. | Shared close contract present; final visual sweep pending. |
| 3 | Build drawer leaves too much empty space on the right. | `src/view/hud/BuildTray.tsx:132-169`; `src/view/hud/LeftRail.tsx:367-409`; shell-reserved CSS `src/index.css:1230-1245,1368-1372` | The build drawer reclaims reserved shell space, uses the available width for the card grid, and keeps the close/utility gutter intentional rather than blank. Verify at compact desktop, tablet, and phone widths. | Responsive reclaim contract present; final browser geometry pending. |
| 4 | Build cards and bottom controls overflow/cut off. | `src/view/hud/BuildTray.tsx:232-355`; `src/index.css:1230-1245,2509-2514,2568-2571` | The drawer body scrolls to the final blueprint; the last row is not hidden behind the activity/operations strip; card borders do not bleed into the footer. Check 320, 360, 390, 430, 768 and 1024px widths. | Scroll/reserved-space contract present; final overflow run pending. |
| 5 | Facility facts are duplicated across the UI. | Canonical facility surfaces `src/view/hud/panels/FleetBuildingsPanel.tsx:94-371`, `src/view/hud/TileInspector.tsx:108-174`, and `src/view/hud/panels/MapPanel.tsx:55-180`; row semantics `src/view/hud/panels/FleetBuildingsPanelRowSemantics.ts` | Select the same facility from map, fleet/buildings, and overview. Name, level, Opex, capacity and status must match the canonical owner; secondary surfaces show compact pointers/actions instead of a second full fact block. Verify no competing KPI derivation. | Ownership contract documented; focused row test exists; final cross-surface browser check pending. |
| 6 | Remove the tiny “days since start” label. | Visible date path `src/view/hud/TopBar.tsx:29-73`; compatibility formatter `src/sim/campaign.ts:216-220`; regression `src/view/hud/TopBar.test.tsx:12` | TopBar shows the current campaign date/day once and contains no visible “days since start” label. Keep the simulation formatter only where compatibility requires it. Verify new and loaded games. | Visible removal represented in current source/test; final browser verification pending. |
| 7 | Top-left identity should use the current company logo/name. | `src/view/hud/TopBar.tsx:46-73`; identity selection/preview `src/view/hud/NewGameMenu.tsx:90-100,578-604,661-684`; persistence `src/sim/createGame.ts:49-58,177-202`, `src/sim/types.ts:3757-3762` | Create a named/marked company, launch/load it, and confirm TopBar, world/market identity and any company surfaces use the same saved `labName`/`companyMark`. Fallback Labline/orbit is only for missing legacy identity. | Canonical identity path present; launch/load and public-dev verification pending. |
| 8 | Map-right controls overflow. | `src/view/hud/MapNavigator.tsx:536-674`; responsive rules `src/index.css:1301-1447,2935-2977`; geometry tests `src/view/hud/mapNavigatorData.test.ts`, `MapNavigator.test.ts` | Launcher, close, zoom and map-action controls remain inside the viewport. At narrow widths the command row scrolls or wraps intentionally rather than clipping icons or labels. Verify touch targets and focus order. | Responsive control contract/tests present; final visual matrix pending. |
| 9 | Gradient/slider text is unreadable. | `src/view/hud/ui/SizeSlider.tsx:8-159`; gradient CSS `src/index.css:1666-1695`; consumer `src/view/hud/panels/ModelsPanel.tsx` | Selected size, major marks and units maintain contrast against the model-size gradient at every supported width. Verify keyboard range changes, selected-label visibility, and no collision with neighboring controls. | Readable label contract present; final visual verification pending. |
| 10 | Remove the “Raw strong target … effective 0.00:1” line. | Training volume `src/view/hud/panels/ModelsPanel.tsx:1850-2021`; regression `src/view/hud/panels/ModelsPanel.test.tsx:23` | The raw-target sentence is absent from rendered Models/Training Volume UI while useful corpus totals and actionable guidance remain. Run the focused test and inspect the rendered card. | Current source/test remove the line; final browser/public-dev verification pending. |
| 11 | Remove the duplicated quality/diversity/verification-holdout line. | `src/view/hud/panels/ModelsPanel.tsx:1850-2021`; regression `src/view/hud/panels/ModelsPanel.test.tsx:24-25` | No standalone “Quality ×… diversity ×… verification holdout…” sentence appears. Train/verify controls retain the necessary state without repeating a technical summary. | Current source/test remove the line; final visual/browser verification pending. |
| 12 | Training Volume section needs a clearer redesign. | `src/view/hud/panels/ModelsPanel.tsx:1850-2021`; `TrainingDataRadar` follows the card; `src/view/hud/panels/ModelsPanel.test.tsx:9-28` | One header establishes total/real/synthetic volume; the metric hierarchy, mix, train/verify controls, and research unlock actions read in order; no duplicate guidance block or tablist appears. Verify card height and readable wrapping on phone/tablet/desktop. | Current hierarchy/test contract present; final responsive browser verification pending. |
| 13 | Research tree/canvas cuts off and overflows. | `src/view/hud/panels/ResearchPanel.tsx:230-499,939-999`; fit math `src/view/hud/panels/researchCanvasLayout.ts:1-23`; layout CSS `src/index.css:753-829`; tests `ResearchPanel.test.ts:12-64` | Initial graph fits the available stage, queue/canvas/detail regions stack at narrow widths, selected-node details remain reachable, and no page-level horizontal overflow is introduced. Verify drag/zoom, touch scroll and selected-node reveal. | Fit/stack/scroll contract and tests present; final browser geometry pending. |
| 14 | Remove the dense FP32/TF32 technical summary. | Compute controls `src/view/hud/panels/ModelsPanel.tsx:2110-2266` | Do not render a duplicate “FP32/TF32 · quality … HBM …” sentence. Keep actionable compute-format/weights choices and expose tradeoffs in the selected control/tooltip. Verify the compact workbench stays legible. | Current source retains actionable controls without the old summary; final visual/browser verification pending. |
| 15 | Compute format/native weights controls are uninteresting and hard to parse. | `src/view/hud/panels/ModelsPanel.tsx:2128-2230`; authoritative profiles `src/sim/balance/trainingPrecision.ts` | Render format and weight choices as distinct, labelled controls with a concise precision/baseline/packed context, locked/inherited reason where applicable, and a readable tradeoff tooltip. Verify keyboard selection and no dense duplicate paragraph. | Current hierarchy/tooltip contract present; final visual/a11y verification pending. |
| 16 | Research tree is not visible in the workbench. | Same research owner `src/view/hud/panels/ResearchPanel.tsx:265-499,939-999`; fit helper `researchCanvasLayout.ts:1-23`; CSS `src/index.css:753-829` | Opening Research immediately reveals the graph at a usable fit scale; queue and selected detail do not cover it; mobile can reach the graph without manual page-level horizontal scrolling. Verify initial render and selected-node transitions. | Responsive research architecture present; final browser verification pending. |
| 17 | Team area should become an HQ floor editor with desks/plants/copiers and productivity effects; remove the tab. | Overlay `src/view/hud/panels/HqOfficeEditorOverlay.tsx:56-258`; catalog/analysis/save quote `src/sim/systems/hqOffice.ts:30-100,200-220,327-419`; entry/summary `src/view/hud/panels/OrgPanel.tsx:1295-1345`; persistence `src/store/gameStore.ts:217-252,616,645,707-725`; hall-editor analogue `src/view/hud/panels/hardware/DataHallEditorOverlay.tsx` | Open the HQ floor from People, place/rotate/remove catalog objects, see productivity/capacity effects and a quote, and Save only valid bounds/non-overlap plans. Closing without Save preserves the prior layout. Company must not expose a competing Team/Capital/Policy nested tablist. Verify persistence after a day/save-load cycle. | HQ editor and no-nested-tab contracts present; end-to-end placement/save/load verification pending. |
| 18 | Capital belongs in Finances. | Nav `src/view/hud/navConfig.ts:139-150`; canonical panel `src/view/hud/panels/StatsPanel.tsx:27-95`; finance selectors `src/view/hud/data/financeDashboardModel.ts:142-192`; compatibility action surface `src/view/hud/panels/OrgPanel.tsx:74-107` | Finances owns capital/ownership/runway and history readouts. Company may retain an embedded action implementation only as a compatibility path; it must not display a second capital KPI dashboard. Verify route, labels and action dispatch. | Finance ownership documented/current source; final route/browser verification pending. |
| 19 | Policy belongs in Overview. | `src/view/hud/panels/OverviewGovernance.tsx:39-167`; mount `src/view/hud/panels/MapPanel.tsx:30-31,99-107`; focused test `OverviewGovernance.test.tsx` | Opening Overview presents policy/governance and externalities with the infrastructure overview. There is no separate visible Policy tab in the primary Company surface. Verify the governance controls remain actionable and accessible. | Current Overview ownership/test path present; final browser verification pending. |
| 20 | Remove the duplicate Cash/Value/P&L/Share/Brand box. | Canonical finance `src/view/hud/data/financeDashboardModel.ts:142-192`, `src/view/hud/panels/StatsPanel.tsx:27-95`; legacy compatibility export in `src/view/hud/panels/OrgPanel.tsx` | People/Company must not render the old duplicate pulse/history card. Finance owns the KPI history; TopBar may point to it. Verify no visible duplicate cash/value/P&L/share/brand block after switching People/Finances. | Old rendered surface removed while compatibility export remains; final visual/browser verification pending. |
| 21 | Put New plan after the last plan and cap the list at eight. | `src/view/hud/panels/plansPanelNavigation.ts:3-13`; `src/view/hud/panels/PlansPanel.tsx:287-299,461-523`; `src/sim/systems/plans.ts:39,719+`; store guard `src/store/gameStore.ts:1189-1198`; test `PlansPanel.test.ts:112-152` | Current plans render first, then one New plan sentinel. At eight plans New plan is disabled with a reason and the simulation/store reject over-cap creation. Verify order after create/delete and a loaded save. | UI/navigation/sim cap contract and focused test present; final browser/save verification pending. |
| 22 | Move Usage content above the Plans tabs. | `src/view/hud/panels/PlansPanel.tsx:385-445` (`PlansCapacitySummary`); test `src/view/hud/panels/PlansPanel.test.ts:112-146` | Capacity/usage context is visible in the Plans header area without selecting a Usage tab. The only local tabs are Demand, Tiers and API. Verify no Usage tab or duplicate capacity panel is rendered. | Current source/test remove Usage tab; final visual/browser verification pending. |
| 23 | Collect/clean workflow should feel risky. | `src/view/hud/panels/DataPanel.tsx:760-869`; hygiene model `src/sim/systems/dataRuntime.ts:91-176`; shared meter/state primitives | Show hygiene pressure, exposed/backlog volume, model drift, queue capacity and amber/danger states. “Process backlog” is not a free instant action; verify blockers, disabled reasons and live state transitions when collection is high. | Risk readout/current source contract present; final simulation/browser verification pending. |
| 24 | Cleaning/pruning must cost more time, compute, data engineers, and degrade models when bad data remains. | UI `src/view/hud/panels/DataPanel.tsx:871-990,2251-2385`; estimates/capacity `src/sim/systems/data.ts:195-359,428-546,1466-1571`; drift `src/sim/systems/data.ts:1574-1647`, snapshot `src/sim/systems/dataRuntime.ts:99-167` | Audit/prune quotes include cash, PF-days, duration, researcher/data-engineer requirements and queue/compute blockers. Raw, low-quality processed, and low-quality synthetic stock contribute bounded pressure; released models lose bounded capability/quality until hygiene recovers. Verify sim tests, stalled queues, alerts, and recovery—not just labels. | Cost/capacity/drift architecture present; final simulation/browser/public-dev verification pending. |
| 25 | Add a Buy action to each domain stock card, including Math. | `src/view/hud/panels/DataPanel.tsx:940-990,2251-2385` (`DomainStockCard`); market purchase flow `DataPanel.tsx:1240-1507,2123-2249` | Domain stock card exposes Buy, routes to the matching market domain, and keeps amount/price coherent with the acquisition row. Verify Math and every domain, including no-stock/disabled states. | Current card has a Buy route; final browser/purchase verification pending. |
| 26 | Remove standalone “Watch: Teacher can go stale” warnings. | Teacher/data workflow in `src/view/hud/panels/DataPanel.tsx`; model/training presentation `src/view/hud/panels/ModelsPanel.tsx`; focused `src/view/hud/panels/DataPanel.test.ts` | Do not repeat a generic stale-teacher warning as a detached label. Retain freshness/risk only beside the teacher/synthetic decision that it affects, with one concise actionable state. Verify no old phrase appears in rendered panels or source assertions. | Current visible copy is condensed/removed; final browser/public-dev verification pending. |
| 27 | Acquisition filters are unusable. | Shared filter contract `src/view/hud/ui/HudFilterBar.tsx:1-140`, `HudFilterBar.test.tsx`, CSS `src/index.css:1882-2032,3136-3159`; current market surface `src/view/hud/panels/DataPanel.tsx:1278-1446` | Desktop exposes readable labelled groups; mobile collapses with active count, `aria-expanded`, Clear and reachable controls. Domain/capability chips wrap and use `aria-pressed`; no clipped native-select text or tiny targets. Verify filter state changes the offer count and Clear restores all lots. | Shared responsive contract exists; Data market integration and final browser verification pending. |
| 28 | Buy amount and Buy all look like the same janky action. | `src/view/hud/panels/DataPanel.tsx:2123-2249` (`MarketLotRow`); bulk summary `DataPanel.tsx:1448-1488` | The slider/current amount controls the primary selected purchase and shows its exact total. Bulk Buy all is visually and semantically distinct, states scope/lots/premium/final total, and is not a duplicate of the selected-amount button. Verify cash blockers and amount changes. | Current purchase/bulk separation and cost copy present; final browser/purchase verification pending. |
| 29 | Remove the separate “Buy all matching” action. | Acquisition/bulk owner `src/view/hud/panels/DataPanel.tsx:1448-1507` | There is one clearly scoped bulk action for the active filtered result set, not a second matching button with the same outcome. Verify no “Buy all matching” label remains and bulk scope/price are shown before dispatch. | Current source uses one filtered bulk action; final source/browser sweep pending. |
| 30 | All destructive actions need consistent red treatment. | Primitive semantics `src/view/hud/ui/HudPrimitives.tsx:208-228`; CSS `src/index.css:1870-1878`; examples `src/view/hud/panels/MapPanel.tsx:353-404`, `src/view/hud/panels/DataPanel.tsx:877-894,2309-2321`, `src/view/hud/panels/PlansPanel.tsx:3153+`, `src/view/hud/TileInspector.tsx:247-255` | Sell/delete/remove/demolish/prune/exit-equivalent destructive actions use `variant="danger"` and `data-destructive="true"`, with red confirmation treatment. A non-destructive close/cancel remains ghost/secondary. Verify source sweep, focus/disabled reasons and every major panel. | Shared danger contract/callers present; final cross-UI sweep pending. |
| 31 | Capability/data filter strip is visually messy. | Acquisition/filter surface `src/view/hud/panels/DataPanel.tsx:1278-1446`; shared `src/view/hud/ui/HudFilterBar.tsx:1-140`; CSS `src/index.css:1882-2032,3136-3159` | Group acquisition/quality/license/seller/price/sort controls separately from domain/capability chips; active state, counts and Clear are legible; chips wrap without overflow and no selected state is duplicated in multiple styles. Verify desktop/mobile and keyboard operation. | Shared filter architecture present; final Data market integration/browser verification pending. |

## Verification gates

The source-suite and supplied browser/route results above are recorded evidence;
do not infer any remaining release property from a local build alone.

1. **Source assertions:** run the focused tests named above; search for removed
   strings (`Raw strong target`, the quality/holdout summary, `Watch: Teacher can
   go stale`, `Buy all matching`, and visible `days since start`) and audit
   destructive callers for `variant="danger"`/`data-destructive`.
2. **Simulation invariants:** exercise HQ draft/save/cancel, invalid placement,
   eight-plan cap/order, data audit/prune capacity blockers, bounded model drift,
   and recovery after hygiene work. A rendered quote is not proof of state
   mutation.
3. **Browser matrix — [x] complete for supplied QA set:** supplied QA passed at
   320×568, 390×844, 1280×720, and
   1465×1354, including page/active-drawer width equality and no console errors.
   The 360×800, 430×932, 768×1024, 1024×768, 1440×900, 1920×1080, and 2560×1440
   rows remain follow-up baselines. Covered workflows include map/build,
   inspector, research, HQ editor, Plans, Data filters/purchase, close controls,
   danger actions, Overview, Finances and Benchmarks.
4. **Public-dev route — [x] complete:** `labline-dev.patryks.me` serves release
   `65f098854090-ui4-20260816T132601Z` with assets `index-Cr8_rIfr.js` /
   `index-BxISYEBi.css`, zero restarts and the prior rollback retained;
   `labline.patryks.me` remains clean master with unchanged assets
   `index-DE9d6C2T.js` / `index-BPCXeejq.css`.
5. **Deployment/master-route — [x] complete for recorded release evidence:**
   dev had zero restarts and retained the prior rollback; production assets were
   unchanged. E2e, TypeScript, lint, build and diff-check are also `[x]` in the
   final engineering verification above. Only clean-worktree review remains
   open because the work is uncommitted.

## Additional similar issues identified

The comments reveal a few cross-cutting checks beyond the marked rectangles:

- Run a one-source-of-truth sweep for facility, finance, training, plan capacity,
  and data inventory facts; compact projections should link back to the owner.
- Run the same responsive overflow matrix on every drawer with a footer or live
  strip. In particular, check shell-reserved padding, not just panel height.
- Audit every nested `tablist` and interactive card wrapper after moving Capital,
  Policy, Usage and Team content. The absence of a tab label is not enough if a
  second navigation level remains in the DOM.
- Check that disabled actions expose the blocker that caused the state, while
  danger actions retain a red semantic affordance and ordinary close actions do
  not become alarming by accident.
- Treat public origin, deployed bundle identity, and the `labline`/`labline-dev`
  split as separate evidence from source tests and local browser screenshots.

## Corrective pass: wide shell, office ownership, and concurrent training

The 2026-08-16 follow-up comments added ten acceptance checks. Their durable
contracts are:

1. `TrainingActivityBar` is below active workspaces, inspectors, and editors.
   Its surface becomes non-interactive while another context owns the
   foreground. At 320×568 the workspace ends at y=432 and the strip begins at
   y=441.
2. The workspace no longer reserves a right-side close-button gutter. The
   drawer margin is the only desktop reservation for operations/training, so
   panel bodies do not also pay a second 130px bottom inset.
3. Visible X close glyphs are removed. Persistent navigation closes by
   re-selecting its destination/Escape; modal surfaces use labelled Done,
   Resume, Back, or collapse affordances.
4. HQ fit-out uses three deterministic automatic layouts. They call the same
   catalogue, placement validator, quote, persistence, and effect functions as
   manual placement. Procedural desk, chair, screen, plant, copier, meeting,
   and research-wall models remain selectable scene objects.
5. `BuildingNameField` keeps one stable full-width box in both display and edit
   states, with the same 48px phone target and 36px desktop height.
6. Research is a true flex-height workbench. At 2384×1354 its stage ends at
   y=1193 inside a y=1209 drawer body, and its icon toolbar remains inside the
   stage without a second label row.
7. Player hiring capacity comes from saved floor objects. The starter grant is
   furnished with twelve real desks; old saves grandfather occupied seats but
   gain no new open seats until the fit-out exceeds headcount. Rival AI keeps
   its non-editable building capacity.
8. Team composition, local hiring, and specialist poaching live in the clicked
   HQ editor. People provides the office list/entry point and does not render a
   duplicate talent market.
9. Active training cards use a static boundary plus live dot/meter. Removing
   the pulsing card shadow prevents hover/inspection from appearing to resize
   the surface; stable scrollbar gutters and inline-size containment prevent
   adjacent reflow.
10. Models exposes `Train another` beside the selected run and `Train model` in
    the shared queue. Starting a job appends to the existing jobs collection;
    concurrency, compute sharing, cancellation, and lineage-specific safety
    gates remain simulation-tested.

Corrective verification: 231 passed source files + 2 skipped, 1,556 passed
tests + 8 skipped; 15/15 simulation e2e; focused corrective files 39/39 plus
the six compatibility failures rerun 38/38; build, lint, and diff check pass.
Browser geometry was rechecked at 2384×1354, 390×844, and 320×568 with
`document.body.scrollWidth === clientWidth`.

## Corrective pass: stable telemetry and commercial balance

The 2026-08-16 economy/telemetry follow-up establishes these additional
contracts:

1. Training chart inspection is layout-neutral. The plot owns a fixed-height
   positioning context and its hover card is absolutely positioned inside it;
   showing or moving the tooltip must produce a zero-pixel card-height delta.
2. Corpus hygiene capability loss is a global 20-day cycle. On days divisible
   by 20, every player model can lose bounded capability when unsafe inventory
   remains; intermediate days do not decay and the same cycle cannot apply
   twice after a reload.
3. Continuous player-facing quantities use the shared two-decimal formatters.
   Shell, plans, model telemetry, money, token, power, capacity, ratios, and
   chart readouts must not override the shared contract with one- or
   three-decimal variants. Discrete day/count/priority inputs remain integers.
   Tiny per-seat compute is humanized to GF/TF/PF rather than scientific
   notation.
4. Each newly created rival starts with a $100.00M liquid reserve in addition
   to any residual operating cash after its opening hardware fleet is valued.
5. Subscription choice considers both willingness to pay and workload fit.
   Heavy enterprise/legal/healthcare cohorts prefer plans whose allowances can
   carry their monthly usage; progressively larger, acceptably valued paid
   tiers retain meaningful high-usage cohorts. Cheap tiers still lead, but Plus
   may not absorb nearly all paid demand while viable Pro and Max tiers exist.

Regression owners: `TrainingLossChart.test.tsx`, `dataPruning.test.ts`,
`frontierBalance.test.ts`, `plansMarket.balance.test.ts`, shared formatter
tests, and the full simulation/source suite. Browser evidence for the local
corrective build measured the training card at `812.09375px` both before and
after hover (delta `0`) and confirmed two-decimal Plans/operations readouts,
including readable `5.01 GF` per served user.

Final corrective verification: 231 test files passed + 2 skipped; 1,559 tests
passed + 8 skipped; simulation e2e 15/15; focused Plans/economy 59/59; build,
lint and diff check passed. Dev release
`65f098854090-ui5-20260816T150417Z` serves `index-CdebRXPG.js` and
`index-C5j6GfuT.css` with zero restarts. The master route remains on
`index-DE9d6C2T.js` and `index-BPCXeejq.css`.

## Corrective pass: model creation modal and direct capacity controls

The next six browser comments establish these contracts:

1. `+ Train model` is the single prominent creation action. It explicitly opens
   the shared viewport dialog; an empty queue does not auto-open the workflow.
2. Training Activity uses compact navigation rows with list/current-page
   semantics for Runs, Checkpoints, and Fleet. It is not a tablist and does not
   repeat a second empty-state creation button.
3. Define, Data, Compute, and Review live entirely inside the training dialog.
   The persistent bottom footer owns the stepper, Back/Continue, Cancel, and
   final Start action while the form body scrolls independently.
4. The dialog has labelled Done/Cancel and Escape behavior, no X glyph, no
   document overflow, and returns focus to `+ Train model` when closed.
5. Model numerics, precision, native weights, and model-stack controls are
   always expanded; Configure/Edit disclosure states are removed.
6. Plans serving-compute allocation, chart, routing slider, and overload policy
   are always visible below Capacity at a glance; the Capacity routing details
   disclosure and its duplicate summary line are removed.

Local browser evidence at 1280×720 confirmed one creation action, no inline or
auto-opened workflow, a scrollable 351.27px dialog body, a fully visible footer
ending at y=690.19, zero X-glyph buttons, zero document overflow, Done/Escape
focus restoration, direct numerics/model-stack controls, and direct Plans
allocation with no ancestor `details`. A configured run launched successfully,
closed the dialog, selected the new job, and left the creation action available
for a second concurrent run.

Final verification: 232 test files passed + 2 skipped; 1,561 tests passed + 8
skipped; focused correction suite 17/17; simulation e2e 15/15; TypeScript,
build, lint, and diff check passed. Dev release
`65f098854090-ui6-20260816T153459Z` serves `index-C8KuXcLI.js` and
`index-ILiFPqbK.css` with zero restarts. Local, release, and public JavaScript
checksums match (`146ee901d142a37f635b7bed07fc1bb20ef18abff0b35e889ce34b0492c0b72b`).
The master route remains on `index-DE9d6C2T.js` and `index-BPCXeejq.css`.
Post-cutover browser smoke against the public dev hostname repeated the key
checks: one train action, no auto/inline workflow, modal workflow in the visible
footer, scrolling body, no X glyph or page overflow, and Plans allocation
visible outside any `details` element.

## Corrective pass: checkpoint branches

The checkpoint follow-up replaces the ambiguous inline fork form with a real
parent/child training flow:

1. An eligible live run exposes `Branch model`; the action snapshots its exact
   weights and opens the shared checkpoint branch dialog.
2. Archived checkpoints expose one primary `Branch new model` action. Starting
   it appends an independent child job through the canonical training system;
   the source run and immutable checkpoint are not edited or paused.
3. The branch dialog names the child, shows its lineage, and offers General,
   Code, Cyber, Chat, Agents, Reasoning, Safety, and Custom data biases. Cyber
   increases Code, Law, and Chat weighting.
4. Child jobs remain visible in Training Activity with a branch-lineage label
   and have their own progress, compute share, pause/cancel, benchmark, and
   release lifecycle.
5. Checkpoints are grouped by source run behind a compact semantic history
   selector. Only the selected run's checkpoint rail is mounted, eliminating
   the previous stack of full archived workspaces and duplicate graph markers.
6. Evaluation, promotion, restart, rollback, and discard remain available. A
   failed child start keeps the dialog open and shows the canonical data,
   compute, cash, or staffing constraint in context.

Local browser evidence at 1280x720 found three archived run-history controls,
one mounted checkpoint rail, one branch action, and no page-level horizontal
overflow. The branch dialog stayed inside the viewport, exposed all eight
specialisations, updated the generated name when Cyber was selected, and used
Done/Cancel rather than an X glyph. A deliberately invalid archived image-model
branch remained open and displayed its real-data validation error instead of
creating a partial job.

Final verification: 233 test files passed + 2 skipped; 1,565 tests passed + 8
skipped; checkpoint-focused regressions 53/53; simulation e2e 15/15; TypeScript,
production build, lint, and diff check passed. Dev release
`65f098854090-ui7-20260816T160745Z` serves `index-d3cuReqI.js` and
`index-DD4pMrTe.css` with zero restarts. Local, release, and public asset
checksums match. The master route remains on `index-DE9d6C2T.js` and
`index-BPCXeejq.css`. A post-cutover public smoke created a fresh sandbox,
opened Models, confirmed one Train model action and the checkpoint destination,
and found no page-level horizontal overflow.

## Corrective pass: stable research and inline benchmark evidence

The next browser comments establish four additional ownership rules:

1. Selecting or collapsing a research method only changes its detail state. It
   preserves the exact canvas translate and zoom; only explicit camera controls,
   relationship navigation, or an external research-focus request may move it.
2. A completed player data hall or HQ selected on the map exposes `Open hall
   editor`. Data halls open the rack-layout editor, HQs open the office-layout
   editor, and unrelated player buildings no longer detour through Fleet.
3. Periodic benchmark-day results no longer mount a blocking modal or require
   `Continue ops`. Simulation evidence can update while map and workbench input
   remain available.
4. Benchmarking a live run first captures or reuses its immutable current-weight
   checkpoint. The active run renders pending timing plus completed benchmark
   intervals, confidence, review verdict, strength, and risk in one compact
   `Benchmarks & reviews` section; the full checkpoint archive remains available
   through a direct history action.

Local browser evidence at 1280x720 opened the complete 102-node research tree,
selected Frontier Dense Stack, and measured the canvas transform as
`translate3d(-596.644px, -635.6px, 0px) scale(0.62)` both before and after the
selection, with no page-level horizontal overflow. Focused research, facility
routing, checkpoint, run-evidence, and Models tests passed 25/25 before the full
regression run.

Final verification: 234 test files passed + 2 skipped; 1,570 tests passed + 8
skipped; simulation e2e 15/15; TypeScript, production build, lint, and diff
check passed. Dev release `65f098854090-ui8-20260816T171847Z` serves
`index-DzvsU1Yl.js` and `index-DD4pMrTe.css` with zero restarts and matching
local, release, and public checksums. The master route remains on
`index-DE9d6C2T.js` and `index-BPCXeejq.css`.

Post-cutover browser smoke reopened a saved public-dev game at 1280x720. The
deployed 102-node Research tree kept
`translate3d(-831.644px, -635.6px, 0px) scale(0.62)` before and after selecting
Frontier Dense Stack. Models rendered one inline checkpoint-evidence surface
for the active run, showed four retained checkpoints, mounted no benchmark-day
popup, and introduced no document overflow.
