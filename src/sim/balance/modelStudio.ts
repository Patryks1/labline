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

/** Curriculum poles. 0 = conservative, 1 = exploratory. */
export const GYM_FOCUS_AXES: Record<
  PostTrainGymKind,
  { low: string; high: string; hint: string }
> = {
  code: {
    low: 'Maintenance',
    high: 'Greenfield',
    hint: 'Known APIs and repair vs new repos and invention.',
  },
  cyber: {
    low: 'Defense',
    high: 'Offense',
    hint: 'Hardening and audit vs exploit-finding and red team.',
  },
  math: {
    low: 'Known results',
    high: 'New maths',
    hint: 'Textbook proofs vs unsolved and invented techniques.',
  },
  research: {
    low: 'Survey',
    high: 'Frontier papers',
    hint: 'Literature coverage vs latest lab notebooks.',
  },
  chat: {
    low: 'Pragmatic',
    high: 'Warmth',
    hint: 'Direct and terse vs friendly and socially fluent.',
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

function addExtra(
  extras: Partial<import('../types').BenchmarkScores>,
  key: keyof import('../types').BenchmarkScores,
  amount: number,
) {
  extras[key] = (extras[key] ?? 0) + amount
}

/** Domain lift from labs attached to a training run. Unfunded labs add nothing. */
export function trainingGymDomainExtras(
  gyms: readonly PostTrainGym[] | undefined,
  attached: readonly PostTrainGymKind[] | undefined,
  options?: { attachDays?: number },
): Partial<import('../types').BenchmarkScores> {
  const attachedSet = new Set(attached ?? [])
  if (attachedSet.size === 0) return {}
  const extras: Partial<import('../types').BenchmarkScores> = {}
  const attachDays = Math.max(0, options?.attachDays ?? 0)
  const overfit = Math.max(0, (attachDays - 10) / 18)
  for (const gym of normalizePostTrainGyms(gyms)) {
    if (!attachedSet.has(gym.kind) || gym.quality <= 1e-6) continue
    const q = gym.quality
    const tilt = clamp01(gym.focusBias ?? 0.5) - 0.5
    const specialtyScale = 1 - Math.min(0.42, overfit * 0.42)
    if (gym.kind === 'code') {
      addExtra(extras, 'coding', Math.min(5.5, q * 5.8) * specialtyScale)
      addExtra(extras, 'agents', Math.min(3, q * (3.2 + tilt * 1.4)) * specialtyScale)
    } else if (gym.kind === 'cyber') {
      addExtra(extras, 'coding', Math.min(4.5, q * 4.8) * specialtyScale)
      addExtra(extras, 'agents', Math.min(6, q * (6.4 + tilt * 1.2)) * specialtyScale)
      addExtra(extras, 'safety', Math.min(4, q * (4.2 - tilt * 1.4)) * specialtyScale)
      addExtra(extras, 'law', Math.min(2.5, q * 2.8) * specialtyScale)
    } else if (gym.kind === 'math') {
      addExtra(extras, 'math', Math.min(5.5, q * 5.8) * specialtyScale)
      addExtra(extras, 'science', Math.min(2.4, q * (2.6 + tilt * 1.6)) * specialtyScale)
    } else if (gym.kind === 'chat') {
      addExtra(extras, 'personality', Math.min(8, q * (8.5 + tilt * 2.2)) * specialtyScale)
      addExtra(extras, 'multilingual', Math.min(2.5, q * 2.8) * specialtyScale)
      addExtra(extras, 'coding', Math.min(1.6, q * Math.max(0, -tilt) * 3.2) * specialtyScale)
    } else {
      addExtra(extras, 'science', Math.min(5.5, q * 5.8) * specialtyScale)
      addExtra(extras, 'mmlu', Math.min(2.8, q * 3) * specialtyScale)
      addExtra(extras, 'law', Math.min(2.2, q * 2.4) * specialtyScale)
    }
    if (overfit > 0 && gym.kind !== 'cyber') {
      const leak = q * overfit * 1.6
      addExtra(extras, 'multilingual', leak * 0.22)
      if (gym.kind !== 'math') addExtra(extras, 'math', leak * 0.28)
      if (gym.kind !== 'code') addExtra(extras, 'coding', leak * 0.22)
      if (gym.kind !== 'research') addExtra(extras, 'science', leak * 0.22)
      if (gym.kind !== 'research') addExtra(extras, 'mmlu', leak * 0.2)
    } else if (overfit > 0) {
      const leak = q * overfit * 0.9
      addExtra(extras, 'agents', leak * 0.35)
      addExtra(extras, 'safety', leak * 0.2)
    }
  }
  return extras
}

export function trainingGymLatentLift(
  gyms: readonly PostTrainGym[] | undefined,
  attached: readonly PostTrainGymKind[] | undefined,
  options?: { attachDays?: number },
): number {
  const extras = trainingGymDomainExtras(gyms, attached, options)
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

export const TOOL_SKILL_UNLOCK: Record<ToolSkillId, string> = {
  json: 'align_sft',
  grep: 'domain_coding',
  python: 'domain_coding',
  shell: 'domain_agents',
  web: 'data_web',
}

export const TOOL_PACKAGE_UNLOCK: Record<string, string | undefined> = {
  primer: undefined,
  drill: 'align_rlhf',
  mastery: 'align_process',
}

export function toolSkillUnlocked(
  skillId: ToolSkillId,
  researchUnlocked: readonly string[] | undefined,
): boolean {
  return (researchUnlocked ?? []).includes(TOOL_SKILL_UNLOCK[skillId])
}

export function toolPackageUnlocked(
  packageId: string,
  researchUnlocked: readonly string[] | undefined,
): boolean {
  const node = TOOL_PACKAGE_UNLOCK[packageId]
  if (!node) return true
  return (researchUnlocked ?? []).includes(node)
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
    hint: 'Graded trajectories plus a live eval harness. Needs RLHF Pipeline.',
  },
  {
    id: 'mastery',
    label: 'Mastery',
    cash: 55_000_000,
    computeCash: 40_000_000,
    hint: 'Long-horizon campaigns. Needs Process Reward Models.',
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
    assignedEngineers: 0,
    assignedDataStaff: 0,
    operatingCostPerDay: 0,
    focusBias: 0.5,
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
      assignedEngineers: Math.max(0, Math.round(existing.assignedEngineers ?? 0)),
      assignedDataStaff: Math.max(0, Math.round(existing.assignedDataStaff ?? 0)),
      focusBias: clamp01(existing.focusBias ?? 0.5),
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

function gymResearcherNeed(gym: PostTrainGym): number {
  const active = GYM_PACKAGES.find((pack) => pack.id === gym.activePackageId)
  if (active) return active.minResearchers
  const next = GYM_PACKAGES.find((pack) => pack.tier === (gym.tier ?? 0) + 1)
  if (next) return next.minResearchers
  const completed = GYM_PACKAGES.find((pack) => pack.tier === (gym.tier ?? 0))
  return Math.max(1, completed?.minResearchers ?? 1)
}

function splitCount(total: number, slots: number): number[] {
  if (slots <= 0) return []
  const base = Math.floor(Math.max(0, total) / slots)
  let extra = Math.max(0, total) - base * slots
  return Array.from({ length: slots }, () => {
    const value = base + (extra > 0 ? 1 : 0)
    if (extra > 0) extra -= 1
    return value
  })
}

/** Spread leftover HQ crew and research PF across unlocked gyms. */
export function autoAssignedGymStaffing(input: {
  gyms: readonly PostTrainGym[] | undefined
  unlockedKinds: ReadonlySet<PostTrainGymKind>
  availableResearchers: number
  availableEngineers: number
  availableDataStaff: number
  researchShareBudget: number
}): PostTrainGym[] {
  const gyms = normalizePostTrainGyms(input.gyms)
  const targets = gyms.filter((gym) => input.unlockedKinds.has(gym.kind))
  const clear = (gym: PostTrainGym): PostTrainGym => ({
    ...gym,
    assignedResearchers: 0,
    assignedEngineers: 0,
    assignedDataStaff: 0,
    researchShare: 0,
  })
  if (targets.length === 0) return gyms.map(clear)

  const researchers: Partial<Record<PostTrainGymKind, number>> = {}
  let remainingResearchers = Math.max(0, Math.floor(input.availableResearchers))
  const fillNeed = (gym: PostTrainGym) => {
    const have = researchers[gym.kind] ?? 0
    const give = Math.min(Math.max(0, gymResearcherNeed(gym) - have), remainingResearchers)
    researchers[gym.kind] = have + give
    remainingResearchers -= give
  }
  for (const gym of targets.filter((candidate) => candidate.activePackageId)) fillNeed(gym)
  for (const gym of targets.filter((candidate) => !candidate.activePackageId)) fillNeed(gym)
  let cursor = 0
  while (remainingResearchers > 0 && targets.length > 0) {
    const gym = targets[cursor % targets.length]!
    researchers[gym.kind] = (researchers[gym.kind] ?? 0) + 1
    remainingResearchers -= 1
    cursor += 1
  }

  const engineers = splitCount(Math.max(0, Math.floor(input.availableEngineers)), targets.length)
  const dataStaff = splitCount(Math.max(0, Math.floor(input.availableDataStaff)), targets.length)
  const budget = Math.max(0, Math.min(0.75, input.researchShareBudget))
  const shares: Partial<Record<PostTrainGymKind, number>> = {}
  if (budget >= 0.05 * targets.length) {
    const each = Math.floor((budget / targets.length) * 1000) / 1000
    let leftover = budget - each * targets.length
    for (const gym of targets) {
      const extra = leftover >= 0.001 ? 0.001 : leftover
      leftover -= extra
      shares[gym.kind] = each + extra
    }
  } else {
    let remainingShare = budget
    for (const gym of targets) {
      const give = remainingShare >= 0.05 ? 0.05 : remainingShare
      shares[gym.kind] = give
      remainingShare -= give
    }
  }

  return gyms.map((gym) => {
    if (!input.unlockedKinds.has(gym.kind)) return clear(gym)
    const index = targets.findIndex((candidate) => candidate.kind === gym.kind)
    return {
      ...gym,
      assignedResearchers: researchers[gym.kind] ?? 0,
      assignedEngineers: engineers[index] ?? 0,
      assignedDataStaff: dataStaff[index] ?? 0,
      researchShare: shares[gym.kind] ?? 0,
    }
  })
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
  tools: { code: 0.45, cyber: 0.3, math: 0.15, research: 0.1 },
}

export function gymQualityForStage(
  stage: Exclude<PostTrainStage, 'none'>,
  gyms: readonly PostTrainGym[] | undefined,
  bonus = 0,
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
  return clamp01(weighted / Math.max(1e-9, total) + bonus)
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
