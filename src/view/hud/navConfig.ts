import type { PanelId } from '../../sim/types'

/** Top-level workspaces. */
export type NavGroupId =
  | 'strategy'
  | 'lab'
  | 'infrastructure'
  | 'market'
  | 'company'

export interface NavItem {
  id: PanelId
  label: string
  /** One-line purpose for subnav / tooltips */
  hint: string
  /** Digit key within group (1–4) */
  key?: string
  presentation?: WorkspacePresentation
}

export type WorkspacePresentation = 'drawer' | 'workbench' | 'immersive'

export interface NavGroup {
  id: NavGroupId
  label: string
  /** Short rail label under icon */
  short: string
  description: string
  /** Digit for group jump */
  key: string
  /** Letter hotkey (shown in tooltips) */
  letter: string
  items: NavItem[]
}

/** Five job-based workspaces; individual simulation panels remain independently routable. */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'strategy',
    label: 'Strategy',
    short: 'Strategy',
    description: 'P&L, rivals, forecasts & world signals',
    key: '1',
    letter: 'Q',
    items: [
      { id: 'stats', label: 'Command', hint: 'P&L · compute · trends', key: '1', presentation: 'workbench' },
      { id: 'rivals', label: 'Rivals', hint: 'Intentions, capacity & launches', key: '2' },
      { id: 'events', label: 'World', hint: 'Events, reports & industry wire', key: '3' },
    ],
  },
  {
    id: 'lab',
    label: 'Lab',
    short: 'Lab',
    description: 'Models, datasets, research pods & evaluation',
    key: '2',
    letter: 'E',
    items: [
      { id: 'models', label: 'Models', hint: 'Train · intervene · release', key: '1', presentation: 'workbench' },
      { id: 'data', label: 'Data', hint: 'Assets, rights, manifests & synth', key: '2', presentation: 'workbench' },
      { id: 'research', label: 'Research', hint: 'Leads, pods, evidence & methods', key: '3', presentation: 'immersive' },
      { id: 'benchmarks', label: 'Evals', hint: 'Seasons, audits & field reviews', key: '4', presentation: 'workbench' },
    ],
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    short: 'Infra',
    description: 'Cloud, sites, fleet, grid & silicon',
    key: '3',
    letter: 'F',
    items: [
      { id: 'map', label: 'Sites', hint: 'Place halls, plants, interconnect', key: '1' },
      { id: 'build', label: 'Build', hint: 'Facilities, people, power & silicon', key: '2' },
      { id: 'computeMarket', label: 'Compute', hint: 'Cloud, reserved, spot & rival PF', key: '3' },
      { id: 'racks', label: 'Racks', hint: 'Design and order fleet batches', key: '4', presentation: 'workbench' },
      { id: 'power', label: 'Power', hint: 'Grid MW, utility contracts & export', key: '5' },
      { id: 'buildings', label: 'Buildings', hint: 'HQs, labs, halls & plants', key: '6' },
      { id: 'chips', label: 'Silicon', hint: 'Custom fab campaigns', key: '7' },
    ],
  },
  {
    id: 'market',
    label: 'Market',
    short: 'Market',
    description: 'Products, pricing, demand & capacity',
    key: '4',
    letter: 'T',
    items: [
      { id: 'plans', label: 'Plans', hint: 'Tiers & API list', key: '1', presentation: 'workbench' },
      { id: 'market', label: 'Market', hint: 'Share & segments', key: '2' },
    ],
  },
  {
    id: 'company',
    label: 'Company',
    short: 'Company',
    description: 'People, capital, ownership & recovery',
    key: '5',
    letter: 'Y',
    items: [
      { id: 'org', label: 'Company', hint: 'Leads, staff, equity & debt', key: '1' },
    ],
  },
]

export type CommandViewId = 'pnl' | 'trends' | 'rivals' | 'feed'

export const COMMAND_VIEWS: { id: CommandViewId; label: string; key: string }[] = [
  { id: 'pnl', label: 'P&L', key: 'F1' },
  { id: 'trends', label: 'Trends', key: 'F2' },
  { id: 'rivals', label: 'Rivals', key: 'F3' },
  { id: 'feed', label: 'Feed', key: 'F4' },
]

export function groupForPanel(panel: PanelId): NavGroup {
  return (
    NAV_GROUPS.find((g) => g.items.some((i) => i.id === panel)) ?? NAV_GROUPS[0]!
  )
}

export function defaultPanelForGroup(groupId: NavGroupId): PanelId {
  const g = NAV_GROUPS.find((x) => x.id === groupId) ?? NAV_GROUPS[0]!
  return g.items[0]!.id
}

/** Panels that need a wider drawer. */
export function isWidePanel(panel: PanelId): boolean {
  return (
    panel === 'research' ||
    panel === 'racks' ||
    panel === 'models' ||
    panel === 'data' ||
    panel === 'benchmarks'
    || panel === 'rivals'
  )
}

export function panelPresentation(panel: PanelId): WorkspacePresentation {
  if (panel === 'allocate') return 'workbench'
  return groupForPanel(panel).items.find((item) => item.id === panel)?.presentation ?? 'drawer'
}

/** Legacy panel ids still routable (hotkey / deep link) but not in primary nav. */
export function isLegacyPanel(panel: PanelId): boolean {
  return panel === 'allocate' || panel === 'rivals'
}
