type NamedModel = { name: string }

const VERSION_SUFFIX = /\s+v(\d+)$/i

export const MODEL_NAME_POOL = [
  'Spark',
  'Nova',
  'Atlas',
  'Quill',
  'Pulse',
  'Orbit',
  'Forge',
  'Aether',
  'Lumen',
  'Cascade',
  'Helix',
  'Vertex',
  'Prism',
  'Nimbus',
  'Solace',
  'Vector',
  'Cobalt',
  'Ion',
  'Rune',
  'Ember',
  'Flux',
  'Glyph',
  'Harbor',
  'Iris',
  'Jolt',
  'Kite',
  'Ledger',
  'Mirage',
  'North',
  'Oxide',
] as const

const NAME_POOL = MODEL_NAME_POOL

export function modelTemplateName(name: string): string {
  const trimmed = name.trim()
  return trimmed.replace(VERSION_SUFFIX, '').trim()
}

export function resolveModelIteration(
  models: readonly NamedModel[],
  requestedName: string,
): { template: string; iteration: number; name: string } {
  const template = modelTemplateName(requestedName) || 'Model'
  const normalizedTemplate = template.toLocaleLowerCase()
  let latestIteration = 0

  for (const model of models) {
    const candidate = model.name.trim()
    const candidateTemplate = modelTemplateName(candidate)
    if (candidateTemplate.toLocaleLowerCase() !== normalizedTemplate) continue

    const match = candidate.match(VERSION_SUFFIX)
    latestIteration = Math.max(latestIteration, match ? Number(match[1]) : 1)
  }

  const iteration = latestIteration + 1
  return {
    template,
    iteration,
    name: iteration === 1 ? template : `${template} v${iteration}`,
  }
}

export function recentModelTemplates(models: readonly NamedModel[], limit = 6): string[] {
  const templates: string[] = []
  const seen = new Set<string>()

  for (let index = models.length - 1; index >= 0; index -= 1) {
    const template = modelTemplateName(models[index]!.name)
    const normalized = template.toLocaleLowerCase()
    if (!template || seen.has(normalized)) continue
    seen.add(normalized)
    templates.push(template)
    if (templates.length >= limit) break
  }

  return templates
}

/** Case-insensitive exact name collision against player + rival models and active jobs. */
export function isModelNameTaken(
  name: string,
  sources: {
    playerModels?: readonly NamedModel[]
    rivalModels?: readonly NamedModel[]
    jobs?: readonly NamedModel[]
  },
): boolean {
  const needle = name.trim().toLocaleLowerCase()
  if (!needle) return false
  const lists = [sources.playerModels, sources.rivalModels, sources.jobs]
  for (const list of lists) {
    if (!list) continue
    for (const entry of list) {
      if (entry.name.trim().toLocaleLowerCase() === needle) return true
    }
  }
  return false
}

export const MODEL_NAME_TAKEN_MESSAGE = 'That model name is already in use.'

/** Generate a unique display name not used by player, rivals, or active jobs. */
export function generateUniqueModelName(
  sources: {
    playerModels?: readonly NamedModel[]
    rivalModels?: readonly NamedModel[]
    jobs?: readonly NamedModel[]
  },
  opts?: { avoid?: string },
): string {
  const taken = new Set<string>()
  const avoid = opts?.avoid?.trim()
  if (avoid) {
    taken.add(avoid.toLocaleLowerCase())
    const avoidedTemplate = modelTemplateName(avoid).toLocaleLowerCase()
    if (avoidedTemplate) taken.add(avoidedTemplate)
  }
  for (const list of [sources.playerModels, sources.rivalModels, sources.jobs]) {
    if (!list) continue
    for (const entry of list) {
      const exact = entry.name.trim().toLocaleLowerCase()
      if (exact) taken.add(exact)
      const template = modelTemplateName(entry.name).toLocaleLowerCase()
      if (template) taken.add(template)
    }
  }

  const shuffled = [...NAME_POOL]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }

  for (const base of shuffled) {
    if (!taken.has(base.toLocaleLowerCase())) return base
  }

  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const candidate = `${shuffled[attempt % shuffled.length]} ${attempt}`
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate
  }

  return `Model ${Date.now().toString(36)}`
}

/** Continue a lineage: keep the family name and bump v2, v3, … */
export function continueRunName(
  parentName: string,
  existing: readonly NamedModel[],
): string {
  const template = modelTemplateName(parentName)
  return resolveModelIteration(existing, template).name
}
