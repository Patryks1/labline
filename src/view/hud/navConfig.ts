import type { PanelId } from '../../sim/types'

/** Top-level workspaces. */
export type NavGroupId =
  | 'strategy'
  | 'lab'
  | 'infrastructure'
  | 'build'
  | 'market'
  | 'marketing'
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
  items: NavItem[]
}

/**
 * The compatibility table above is also consumed by the legacy Shift+1–7 and
 * Z/X/C/V shortcuts. Keep it stable while the visible shell converges on the
 * four destination groups from the streamline reference.
 */
export type ShellNavGroupId = 'operate' | 'build' | 'products' | 'company'

export interface ShellNavGroup {
  id: ShellNavGroupId
  label: string
  short: string
  description: string
  items: NavItem[]
}

/** Compatibility keyboard groups; individual simulation panels remain independently routable. */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'strategy',
    label: 'Strategy',
    short: 'Strategy',
    description: 'P&L, rivals, forecasts & world signals',
    key: '1',
    items: [
      { id: 'stats', label: 'Command', hint: 'P&L · capital · compute', key: '1', presentation: 'workbench' },
      { id: 'rivals', label: 'Rivals', hint: 'Intentions, capacity & launches', key: '2' },
    ],
  },
  {
    id: 'lab',
    label: 'Lab',
    short: 'Lab',
    description: 'Models, datasets, research pods & evaluation',
    key: '2',
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
    items: [
      { id: 'map', label: 'Overview', hint: 'Fleet capacity, construction & map', key: '1' },
      { id: 'computeMarket', label: 'Compute', hint: 'Cloud, reserved, spot & rival PF', key: '2' },
      { id: 'racks', label: 'Hardware', hint: 'Racks, blueprints & custom silicon', key: '3', presentation: 'workbench' },
      { id: 'power', label: 'Power', hint: 'Grid MW, utility contracts & export', key: '4' },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    short: 'Build',
    description: 'Place facilities and expand campus capacity',
    key: '4',
    items: [
      { id: 'build', label: 'Build', hint: 'Facilities, people, power & silicon', key: '1' },
    ],
  },
  {
    id: 'market',
    label: 'Market',
    short: 'Market',
    description: 'Products, pricing, demand & capacity',
    key: '5',
    items: [
      { id: 'plans', label: 'Plans', hint: 'Tiers & API list', key: '1', presentation: 'workbench' },
      { id: 'market', label: 'Market', hint: 'Share & segments', key: '2' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    short: 'Marketing',
    description: 'Reach, acquisition channels, brand & competitive spend',
    key: '6',
    items: [
      { id: 'marketing', label: 'Marketing', hint: 'Budget, channels, reach & brand' },
    ],
  },
  {
    id: 'company',
    label: 'Company',
    short: 'Company',
    description: 'People, research, strategy & milestones',
    key: '7',
    items: [
      { id: 'org', label: 'Company', hint: 'Leads, staff & hiring', key: '1' },
    ],
  },
]

/**
 * Visual shell IA. This is deliberately separate from NAV_GROUPS: the latter
 * is a compatibility surface for existing numeric and sub-navigation keys.
 * Items remain one level deep; the group headings are visual landmarks, not
 * nested tablists.
 */
export const SHELL_NAV_GROUPS: ShellNavGroup[] = [
  {
    id: 'operate',
    label: 'Operate',
    short: 'Operate',
    description: 'Overview, workloads, processes & finances',
    items: [
      { id: 'map', label: 'Overview', hint: 'Fleet, facilities, construction & map' },
      { id: 'computeMarket', label: 'Workloads', hint: 'Cloud, reserved, spot & rival PF' },
      { id: 'rivals', label: 'Processes', hint: 'Intentions, capacity & launches' },
      { id: 'stats', label: 'Finances', hint: 'P&L · capital · compute' },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    short: 'Build',
    description: 'Facilities, hardware & infrastructure',
    items: [
      { id: 'build', label: 'Facilities', hint: 'Place facilities and expand campus capacity' },
      { id: 'racks', label: 'Hardware', hint: 'Racks, blueprints & custom silicon', presentation: 'workbench' },
      { id: 'power', label: 'Infrastructure', hint: 'Grid MW, utility contracts & export' },
    ],
  },
  {
    id: 'products',
    label: 'Products',
    short: 'Products',
    description: 'Models, datasets, benchmarks & plans',
    items: [
      { id: 'models', label: 'Models', hint: 'Train · intervene · release', presentation: 'workbench' },
      { id: 'data', label: 'Datasets', hint: 'Assets, rights, manifests & synth', presentation: 'workbench' },
      { id: 'benchmarks', label: 'Benchmarks', hint: 'Seasons, audits & field reviews', presentation: 'workbench' },
      { id: 'plans', label: 'Plans', hint: 'Tiers & API list', presentation: 'workbench' },
      { id: 'market', label: 'Market', hint: 'Share & segments' },
    ],
  },
  {
    id: 'company',
    label: 'Company',
    short: 'Company',
    description: 'People, research, strategy & milestones',
    items: [
      { id: 'org', label: 'People', hint: 'Leads, staff & hiring' },
      { id: 'research', label: 'Research', hint: 'Leads, pods, evidence & methods', presentation: 'immersive' },
      { id: 'marketing', label: 'Strategy', hint: 'Budget, channels, reach & brand' },
    ],
  },
]

/** Map legacy panel ids to their single visible shell destination. */
export function shellPanelForPanel(panel: PanelId): PanelId {
  return panel === 'chips' ? 'racks' : panel
}

export function shellGroupForPanel(panel: PanelId): ShellNavGroup {
  return (
    SHELL_NAV_GROUPS.find((group) => group.items.some((item) => item.id === shellPanelForPanel(panel))) ??
    SHELL_NAV_GROUPS[0]!
  )
}

export type CommandViewId = 'pnl' | 'sites' | 'rivals' | 'feed'

export const COMMAND_VIEWS: { id: CommandViewId; label: string; key: string }[] = [
  { id: 'pnl', label: 'P&L', key: 'F1' },
  { id: 'sites', label: 'Sites', key: 'F2' },
  { id: 'rivals', label: 'Rivals', key: 'F3' },
  { id: 'feed', label: 'World', key: 'F4' },
]

/** Function-row shortcuts follow the visible panel order beneath map tools. */
export const FUNCTION_PANEL_SHORTCUTS: readonly { key: string; panel: PanelId; label: string }[] = [
  { key: 'F1', panel: 'stats', label: 'Demand' },
  { key: 'F2', panel: 'rivals', label: 'Rivals' },
  { key: 'F3', panel: 'models', label: 'Models' },
  { key: 'F4', panel: 'data', label: 'Data' },
  { key: 'F5', panel: 'research', label: 'Research' },
  { key: 'F6', panel: 'benchmarks', label: 'Evals' },
  { key: 'F7', panel: 'map', label: 'Overview' },
  { key: 'F8', panel: 'computeMarket', label: 'Compute' },
  { key: 'F9', panel: 'racks', label: 'Hardware' },
  { key: 'F10', panel: 'power', label: 'Power' },
  { key: 'F11', panel: 'plans', label: 'Plans' },
  { key: 'F12', panel: 'market', label: 'Market' },
] as const

export function panelForFunctionKey(key: string): PanelId | null {
  return FUNCTION_PANEL_SHORTCUTS.find((shortcut) => shortcut.key === key)?.panel ?? null
}

export function groupForPanel(panel: PanelId): NavGroup {
  if (panel === 'chips') {
    return NAV_GROUPS.find((group) => group.id === 'infrastructure') ?? NAV_GROUPS[0]!
  }
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
  if (panel === 'chips') return 'workbench'
  return groupForPanel(panel).items.find((item) => item.id === panel)?.presentation ?? 'drawer'
}

/** Legacy panel ids still routable (hotkey / deep link) but not in primary nav. */
export function isLegacyPanel(panel: PanelId): boolean {
  return panel === 'allocate' || panel === 'rivals'
}
