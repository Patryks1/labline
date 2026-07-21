# Labline UI Revamp - Design System Contract

Every panel rework MUST follow this contract. It exists so 6+ contributors produce
one coherent, gamified UI. If something here conflicts with your instinct, the
contract wins.

## North Star

Labline is a strategy GAME, not an analytics dashboard. The UI should feel like a
sci-fi command console: high contrast, generous type, glowing live states, animated
feedback for every action, and ZERO walls of tiny text. If a screen needs scrolling
on a 1080p viewport, it has too much on it; cut, group, or paginate with tabs.

## Hard Rules

1. KEEP every existing feature and store action working. Reorganize freely; do not
   delete capability.
2. NO duplicated info within a screen. Each fact lives in exactly one place.
3. NO dead "explanatory" paragraphs. One short hint line max per section.
4. Buttons that cannot be used are `disabled` AND show the reason why (tooltip or
   inline reason row). Never silently inactive.
5. All numbers use `font-mono tabular-nums`.
6. Letter-spacing is 0 on headings/body. Uppercase micro-labels may keep
   `tracking-[0.12em]`.
7. Border radius: 8px (`rounded-lg`) for cards/panels, 6px (`rounded-md`) for
   controls. Nothing bigger than 8px except full-round chips.
8. Text must fit its container: use `truncate`, `min-w-0`, and `tabular-nums`.
9. Animations are mandatory but subtle: 150-250ms, ease-out. Respect
   `data-reduced-motion` (global CSS already handles it).

## Palette (Tailwind theme tokens, see src/index.css)

| Token | Use |
| --- | --- |
| `void` | deepest background |
| `panel` / `panel-2` / `panel-3` | surface elevations (0/1/2) |
| `line` | borders, always at 60-80% opacity |
| `bone` | primary text |
| `muted` | secondary text |
| `mint` | primary action, positive, income, "you" |
| `amber` / `train` | training, warnings, upfront costs |
| `infer` | serving/inference, speed |
| `research` | research/safety |
| `danger` | losses, blockers, destructive |
| `gold` | celebrations, releases, achievements |

Accent usage: one accent per card. A card about training uses `train`; do not mix
three accent colors in one widget.

## Type Scale

- Panel title: `text-lg font-semibold` (h2)
- Section title: `text-sm font-semibold` + optional `hud-eyebrow` over it
- Body: `text-[0.8125rem]` (13px)
- Micro labels: `text-[0.6875rem] uppercase tracking-[0.12em] text-muted`
- Big game numbers: `font-mono text-xl font-semibold`
- NEVER below 0.625rem, and 0.625rem only for axis ticks.

## Shared Components (import from these, do not restyle)

`src/view/hud/ui/HudPrimitives.tsx` - PanelScaffold, MetricTile, StatusChip,
ProgressBar, EmptyState, HudButton.

`src/view/hud/ui/kit.tsx` - NEW kit. Use these everywhere:
- `GameCard` - the ONE card primitive (title eyebrow + actions + children).
- `SegmentedTabs` - fixed-height animated tab strip. Tabs NEVER change size.
- `StatRow` - label/value/deficit row for ledger-style data.
- `MeterBar` - labeled progress with tone + optional shimmer when live.
- `BlockerList` - "why can't I do this" reason rows (danger/amber with icons).
- `LiveDot` - pulsing dot for live activity (training, construction).
- `CardGrid` - responsive grid for repeated cards.

CSS utility classes in index.css you should use:
- `.panel-swap` - wrap tab/page content so switches animate (fade+rise 200ms).
- `.anim-stagger` - children cascade in (cards, list rows).
- `.live-glow` - soft pulsing glow for in-progress work.
- `.hover-lift` - micro-interaction for clickable cards.
- `.release-burst` - model release celebration overlay pieces.

## Layout Per Panel

1. **Header row** (PanelScaffold or GameCard header): title + ONE line description
   + primary action on the right.
2. **Key stats strip**: 3-5 MetricTiles, the numbers a player checks every visit.
3. **Tabbed or sectioned body** using SegmentedTabs for >1 logical view.
4. **Primary action bar** pinned at the bottom of the flow it belongs to, full
   width, `HudButton variant="primary"`, with cost and BlockerList right above it.
5. Workbenches use 2-3 column grids (`xl:grid-cols-3`) with the PRIMARY workflow
   in the left 2 columns and supporting lists in the right rail column.

## Shell Behavior (already implemented - do not change)

- Left rail shows EVERY panel as its own icon tab (grouped by thin dividers).
- Build lives as a floating action button on the map, not in the rail.
- Panel content animates on switch via `.panel-swap`.
- Right dock = Command (P&L), Rivals, World feed - same SegmentedTabs pattern.

## Release Celebration Contract

When a model is released to production, fire:
`useUiStore.getState().announceRelease({ name: string, capability: number })`
The global `<ReleaseCelebration />` overlay (mounted in App) renders the
animation. Panels only announce; they do not render their own confetti.

## Definition of Done (per panel)

- `npx tsc -b` passes.
- No new oxlint errors in touched files.
- Every interactive element has hover + active + disabled states.
- Every list/feed animates in with `.anim-stagger`.
- No inline `style={{}}` for things a token/class expresses (dynamic widths OK).
