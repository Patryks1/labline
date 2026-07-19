type NamedModel = { name: string }

const VERSION_SUFFIX = /\s+v(\d+)$/i

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
