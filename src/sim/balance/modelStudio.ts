import type {
  Model,
  ModelRouter,
  ModelRouterLane,
  PlayerState,
  PostTrainGym,
  PostTrainGymKind,
  PostTrainStage,
  ToolSkill,
  ToolSkillId,
} from '../types'

const clamp01 = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

export const POST_TRAIN_GYM_KINDS: readonly PostTrainGymKind[] = [
  'code',
  'cyber',
  'math',
  'research',
  'chat',
]

export const GYM_UNLOCK_RESEARCH: Record<PostTrainGymKind, string> = {
  code: 'domain_coding',
  cyber: 'domain_agents',
  math: 'domain_math',
  research: 'domain_science',
  chat: 'align_sft',
}

export const POST_TRAIN_GYM_META: Record<
  PostTrainGymKind,
  { name: string; blurb: string; grades: string; unlock: string }
> = {
  code: {
    name: 'Code lab',
    blurb: 'Repo tests and SWE traces. Attach while training to raise code.',
    grades: 'Train · SFT · tools',
    unlock: GYM_UNLOCK_RESEARCH.code,
  },
  cyber: {
    name: 'Cyber range',
    blurb: 'Adversarial sandboxes, exploit repair, secure tool use, and red-team traces.',
    grades: 'Train · RLHF · tools',
    unlock: GYM_UNLOCK_RESEARCH.cyber,
  },
  math: {
    name: 'Math lab',
    blurb: 'Proofs and process rewards. Attach while training to raise math.',
    grades: 'Train · RLHF · process',
    unlock: GYM_UNLOCK_RESEARCH.math,
  },
  research: {
    name: 'Research lab',
    blurb: 'Paper QA and lab notebooks. Attach while training to raise science.',
    grades: 'Train · RLHF · process',
    unlock: GYM_UNLOCK_RESEARCH.research,
  },
  chat: {
    name: 'Personality lab',
    blurb: 'Preference traces and conversation style. Attach to raise personality.',
    grades: 'SFT · RLHF',
    unlock: GYM_UNLOCK_RESEARCH.chat,
  },
}

export function gymUnlocked(
  kind: PostTrainGymKind,
  researchUnlocked: readonly string[] | undefined,
): boolean {
  return (researchUnlocked ?? []).includes(GYM_UNLOCK_RESEARCH[kind])
}

export function unlockedGymKinds(
  researchUnlocked: readonly string[] | undefined,
): PostTrainGymKind[] {
  return POST_TRAIN_GYM_KINDS.filter((kind) => gymUnlocked(kind, researchUnlocked))
}

/** Domain lift from labs attached to a training run. Unfunded labs add nothing. */
export function trainingGymDomainExtras(
  gyms: readonly PostTrainGym[] | undefined,
  attached: readonly PostTrainGymKind[] | undefined,
): Partial<import('../types').BenchmarkScores> {
  const attachedSet = new Set(attached ?? [])
  if (attachedSet.size === 0) return {}
  const extras: Partial<import('../types').BenchmarkScores> = {}
  for (const gym of normalizePostTrainGyms(gyms)) {
    if (!attachedSet.has(gym.kind) || gym.quality <= 1e-6) continue
    const q = gym.quality
    if (gym.kind === 'code') {
      extras.coding = (extras.coding ?? 0) + Math.min(5.5, q * 5.8)
      extras.agents = (extras.agents ?? 0) + Math.min(3, q * 3.2)
    } else if (gym.kind === 'cyber') {
      // Cyber is deliberately narrow: it can create an excellent security or
      // agent endpoint, but it does not raise headline general capability.
      extras.coding = (extras.coding ?? 0) + Math.min(4.5, q * 4.8)
      extras.agents = (extras.agents ?? 0) + Math.min(6, q * 6.4)
      extras.safety = (extras.safety ?? 0) + Math.min(4, q * 4.2)
      extras.law = (extras.law ?? 0) + Math.min(2.5, q * 2.8)
    } else if (gym.kind === 'math') {
      extras.math = (extras.math ?? 0) + Math.min(5.5, q * 5.8)
      extras.science = (extras.science ?? 0) + Math.min(2.4, q * 2.6)
    } else if (gym.kind === 'chat') {
      extras.personality = (extras.personality ?? 0) + Math.min(8, q * 8.5)
      extras.multilingual = (extras.multilingual ?? 0) + Math.min(2.5, q * 2.8)
    } else {
      extras.science = (extras.science ?? 0) + Math.min(5.5, q * 5.8)
      extras.mmlu = (extras.mmlu ?? 0) + Math.min(2.8, q * 3)
      extras.law = (extras.law ?? 0) + Math.min(2.2, q * 2.4)
    }
  }
  return extras
}

export function trainingGymLatentLift(
  gyms: readonly PostTrainGym[] | undefined,
  attached: readonly PostTrainGymKind[] | undefined,
): number {
  const extras = trainingGymDomainExtras(gyms, attached)
  const values = Object.values(extras)
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + (value ?? 0), 0) / values.length
}

export interface StudioSpendPackage {
  id: string
  label: string
  cash: number
  computeCash: number
  hint: string
}

export interface GymUpgradePackage extends StudioSpendPackage {
  /** Sequential facility tier unlocked when the project completes. */
  tier: 1 | 2 | 3
  /** Shared research compute required to commission this tier. */
  researchPfDays: number
  minResearchers: number
  operatingCostPerDay: number
  targetQuality: number
}

export const GYM_PACKAGES: readonly GymUpgradePackage[] = [
  {
    id: 'foundry',
    label: 'Foundry',
    tier: 1,
    cash: 12_000_000,
    computeCash: 8_000_000,
    researchPfDays: 4,
    minResearchers: 2,
    operatingCostPerDay: 40_000,
    targetQuality: 0.3,
    hint: 'Stand up graders and a small eval team. Costly, noisy, but finally useful.',
  },
  {
    id: 'cluster',
    label: 'Eval cluster',
    tier: 2,
    cash: 55_000_000,
    computeCash: 35_000_000,
    researchPfDays: 22,
    minResearchers: 6,
    operatingCostPerDay: 180_000,
    targetQuality: 0.64,
    hint: 'Rent a serious eval fleet. SFT/RLHF start to land.',
  },
  {
    id: 'campus',
    label: 'Full campus',
    tier: 3,
    cash: 240_000_000,
    computeCash: 180_000_000,
    researchPfDays: 90,
    minResearchers: 16,
    operatingCostPerDay: 650_000,
    targetQuality: 0.92,
    hint: 'Dedicated post-train campus. The expensive way to buy reliability.',
  },
]

export const TOOL_SKILL_IDS: readonly ToolSkillId[] = [
  'json',
  'grep',
  'python',
  'shell',
  'web',
]

export const TOOL_SKILL_META: Record<ToolSkillId, { name: string; blurb: string }> = {
  json: { name: 'JSON / schema', blurb: 'Structured I/O, function calling, schema adherence.' },
  grep: { name: 'Grep / search', blurb: 'Repo search, ripgrep patterns, and file navigation.' },
  python: { name: 'Python runtime', blurb: 'Execute, test, and repair Python in a sandbox.' },
  shell: { name: 'Shell', blurb: 'Command-line tools, pipes, and working-directory hygiene.' },
  web: { name: 'Web fetch', blurb: 'Retrieve pages, APIs, and citations without hallucinating URLs.' },
}

export const TOOL_PACKAGES: readonly StudioSpendPackage[] = [
  {
    id: 'primer',
    label: 'Primer',
    cash: 4_500_000,
    computeCash: 1_500_000,
    hint: 'Synthetic traces. The model knows the tool exists.',
  },
  {
    id: 'drill',
    label: 'Drill set',
    cash: 16_000_000,
    computeCash: 12_000_000,
    hint: 'Thousands of graded trajectories. Failure modes shrink.',
  },
  {
    id: 'mastery',
    label: 'Mastery',
    cash: 55_000_000,
    computeCash: 40_000_000,
    hint: 'Long-horizon tool campaigns. Expensive, sticky skill.',
  },
]

export function gymQualityFromInvestment(cash: number, computeCash: number): number {
  const units = Math.max(0, cash) / 40_000_000 + Math.max(0, computeCash) / 28_000_000
  return clamp01(1 - Math.exp(-units))
}

export function toolProficiencyFromInvestment(cash: number, computeCash = 0): number {
  const units = Math.max(0, cash) / 22_000_000 + Math.max(0, computeCash) / 18_000_000
  return clamp01(1 - Math.exp(-units * 1.15))
}

export function defaultPostTrainGyms(): PostTrainGym[] {
  return POST_TRAIN_GYM_KINDS.map((kind) => ({
    id: `gym-${kind}`,
    kind,
    name: POST_TRAIN_GYM_META[kind].name,
    investedCash: 0,
    investedComputeCash: 0,
    quality: 0,
    tier: 0,
    activePackageId: null,
    progressPfDays: 0,
    targetPfDays: 0,
    researchShare: 0,
    assignedResearchers: 0,
    operatingCostPerDay: 0,
  }))
}

export function defaultToolSkills(): ToolSkill[] {
  return TOOL_SKILL_IDS.map((id) => ({
    id,
    proficiency: 0,
    investedCash: 0,
    investedComputeCash: 0,
  }))
}

export function normalizePostTrainGyms(gyms: readonly PostTrainGym[] | undefined): PostTrainGym[] {
  const byKind = new Map((gyms ?? []).map((gym) => [gym.kind, gym]))
  const normalized = defaultPostTrainGyms().map((seed) => {
    const existing = byKind.get(seed.kind)
    if (!existing) return seed
    const investedCash = Math.max(0, existing.investedCash ?? 0)
    const investedComputeCash = Math.max(0, existing.investedComputeCash ?? 0)
    const legacyQuality = gymQualityFromInvestment(investedCash, investedComputeCash)
    const hasStoredTier = Number.isFinite(existing.tier)
    const storedQuality = clamp01(existing.quality ?? legacyQuality)
    const migrationQuality = hasStoredTier
      ? storedQuality
      : Math.max(storedQuality, Math.min(0.995, legacyQuality))
    const inferredTier =
      migrationQuality >= 0.78
        ? 3
        : migrationQuality >= 0.42
          ? 2
          : migrationQuality > 0.001
            ? 1
            : 0
    const tier = Math.max(0, Math.min(3, Math.round(existing.tier ?? inferredTier)))
    const activePack = GYM_PACKAGES.find(
      (pack) => pack.id === existing.activePackageId && pack.tier === tier + 1,
    )
    const targetPfDays = activePack
      ? Math.max(0.001, existing.targetPfDays ?? activePack.researchPfDays)
      : 0
    return {
      ...seed,
      ...existing,
      investedCash,
      investedComputeCash,
      quality: migrationQuality,
      tier,
      activePackageId: activePack?.id ?? null,
      progressPfDays: activePack
        ? Math.max(0, Math.min(targetPfDays, existing.progressPfDays ?? 0))
        : 0,
      targetPfDays,
      researchShare: Math.max(0, Math.min(0.75, existing.researchShare ?? 0)),
      assignedResearchers: Math.max(0, Math.round(existing.assignedResearchers ?? 0)),
      operatingCostPerDay: Math.max(
        0,
        existing.operatingCostPerDay ??
          activePack?.operatingCostPerDay ??
          GYM_PACKAGES.find((pack) => pack.tier === tier)?.operatingCostPerDay ??
          0,
      ),
    }
  })
  // Legacy and hand-edited saves may contain several individually valid
  // shares whose sum exceeds the one shared research pool. Preserve the
  // canonical gym order while enforcing the same aggregate cap used by the
  // research ledger, so gym ticks can never spend more PF than was reserved.
  let remainingResearchShare = 0.75
  return normalized.map((gym) => {
    const researchShare = Math.min(gym.researchShare ?? 0, remainingResearchShare)
    remainingResearchShare = Math.max(0, remainingResearchShare - researchShare)
    return researchShare === gym.researchShare ? gym : { ...gym, researchShare }
  })
}

/** Research-pool share reserved by staffed gyms, active projects first. */
export function gymResearchReservationShare(
  gyms: readonly PostTrainGym[] | undefined,
): number {
  const share = normalizePostTrainGyms(gyms).reduce((sum, gym) => {
    const hasWork = Boolean(gym.activePackageId) || (gym.tier ?? 0) > 0
    return sum + (hasWork && (gym.assignedResearchers ?? 0) > 0 ? (gym.researchShare ?? 0) : 0)
  }, 0)
  return Math.max(0, Math.min(0.75, share))
}

export function assignedGymResearchers(
  gyms: readonly PostTrainGym[] | undefined,
  exceptKind?: PostTrainGymKind,
): number {
  return normalizePostTrainGyms(gyms).reduce(
    (sum, gym) => sum + (gym.kind === exceptKind ? 0 : Math.max(0, gym.assignedResearchers ?? 0)),
    0,
  )
}

export function normalizeToolSkills(skills: readonly ToolSkill[] | undefined): ToolSkill[] {
  const byId = new Map((skills ?? []).map((skill) => [skill.id, skill]))
  return defaultToolSkills().map((seed) => {
    const existing = byId.get(seed.id)
    if (!existing) return seed
    const investedCash = Math.max(0, existing.investedCash ?? 0)
    const investedComputeCash = Math.max(0, existing.investedComputeCash ?? 0)
    return {
      ...seed,
      investedCash,
      investedComputeCash,
      proficiency: toolProficiencyFromInvestment(investedCash, investedComputeCash),
    }
  })
}

const STAGE_GYM_WEIGHT: Record<Exclude<PostTrainStage, 'none'>, Partial<Record<PostTrainGymKind, number>>> = {
  sft: { chat: 0.45, code: 0.25, math: 0.1, research: 0.2 },
  rlhf: { chat: 0.5, research: 0.25, math: 0.15, code: 0.1 },
  process: { math: 0.55, research: 0.35, code: 0.1 },
  tools: { code: 0.7, math: 0.15, research: 0.15 },
}

export function gymQualityForStage(
  stage: Exclude<PostTrainStage, 'none'>,
  gyms: readonly PostTrainGym[] | undefined,
): number {
  const weights = STAGE_GYM_WEIGHT[stage]
  const normalized = normalizePostTrainGyms(gyms)
  let total = 0
  let weighted = 0
  for (const kind of POST_TRAIN_GYM_KINDS) {
    const weight = weights[kind] ?? 0
    if (weight <= 0) continue
    const gym = normalized.find((entry) => entry.kind === kind)
    total += weight
    weighted += (gym?.quality ?? 0) * weight
  }
  return clamp01(weighted / Math.max(1e-9, total))
}

export function meanToolProficiency(skills: readonly ToolSkill[] | undefined): number {
  const normalized = normalizeToolSkills(skills)
  if (normalized.length === 0) return 0
  return (
    normalized.reduce((sum, skill) => sum + skill.proficiency, 0) / normalized.length
  )
}

/** Unfunded gyms waste PF; a campus still costs more cash but finishes cleaner. */
export function postTrainGymWorkMult(gymQuality: number): number {
  return 1.22 + (1 - clamp01(gymQuality)) * 0.48
}

export function postTrainStageCashCost(
  paramsB: number,
  stage: Exclude<PostTrainStage, 'none'>,
  gymQuality: number,
): number {
  const base =
    stage === 'sft' ? 2_400_000
    : stage === 'rlhf' ? 6_800_000
    : stage === 'process' ? 12_000_000
    : 8_500_000
  const size = Math.pow(Math.max(1, paramsB), 0.42)
  const gymTax = 1.15 - clamp01(gymQuality) * 0.2
  return Math.round(base * size * gymTax)
}

export function packageTotalCash(pack: StudioSpendPackage): number {
  return pack.cash + pack.computeCash
}

export const ROUTER_UNLOCK_RESEARCH = 'sys_router'

export function routerUnlocked(
  researchUnlocked: readonly string[] | undefined,
): boolean {
  return (researchUnlocked ?? []).includes(ROUTER_UNLOCK_RESEARCH)
}

export const ROUTER_LANES: readonly ModelRouterLane[] = [
  'chat',
  'code',
  'math',
  'science',
  'default',
]

export const ROUTER_LANE_META: Record<
  ModelRouterLane,
  { label: string; blurb: string }
> = {
  chat: { label: 'Chat', blurb: 'Dialogue and consumer traffic.' },
  code: { label: 'Code', blurb: 'IDE, agents, and repo-shaped traffic.' },
  math: { label: 'Math', blurb: 'Proofs, numerics, and quantitative work.' },
  science: { label: 'Science', blurb: 'Papers, lab notes, and research Q&A.' },
  default: { label: 'Fallback', blurb: 'Anything that does not match a specialist lane.' },
  fast: { label: 'Chat', blurb: 'Legacy cheap lane. Remapped to Chat.' },
  frontier: { label: 'Fallback', blurb: 'Legacy premium lane. Remapped to Fallback.' },
}

export function remapLegacyRouterLanes(
  lanes: Partial<Record<ModelRouterLane, string>> | undefined,
): Partial<Record<ModelRouterLane, string>> {
  const next: Partial<Record<ModelRouterLane, string>> = { ...lanes }
  if (!next.chat && next.fast) next.chat = next.fast
  if (!next.default && next.frontier) next.default = next.frontier
  delete next.fast
  delete next.frontier
  return Object.fromEntries(
    ROUTER_LANES
      .map((lane) => [lane, next[lane]])
      .filter((entry): entry is [ModelRouterLane, string] => typeof entry[1] === 'string' && entry[1].length > 0),
  )
}

export function normalizeModelRouters(
  routers: readonly ModelRouter[] | undefined,
): ModelRouter[] {
  return (routers ?? []).map((router, index) => ({
    id: router.id || `router-${index + 1}`,
    name: router.name?.trim() || `Router ${index + 1}`,
    lanes: remapLegacyRouterLanes(router.lanes),
  }))
}

export function releasedOrInternalModel(
  models: readonly Model[],
  id: string | undefined,
): Model | undefined {
  if (!id) return undefined
  return models.find((model) => model.id === id)
}

export function gymPackageById(id: string): GymUpgradePackage | undefined {
  return GYM_PACKAGES.find((pack) => pack.id === id)
}

export function toolPackageById(id: string): StudioSpendPackage | undefined {
  return TOOL_PACKAGES.find((pack) => pack.id === id)
}

/** Fill missing studio fields on load / new games without bumping save version. */
export function ensureModelStudio<T extends Pick<
  PlayerState,
  'postTrainGyms' | 'toolSkills' | 'modelRouters' | 'activeModelRouterId'
>>(player: T): T {
  const routers = normalizeModelRouters(player.modelRouters)
  const active =
    player.activeModelRouterId &&
    routers.some((router) => router.id === player.activeModelRouterId)
      ? player.activeModelRouterId
      : null
  return {
    ...player,
    postTrainGyms: normalizePostTrainGyms(player.postTrainGyms),
    toolSkills: normalizeToolSkills(player.toolSkills),
    modelRouters: routers,
    activeModelRouterId: active,
  }
}
