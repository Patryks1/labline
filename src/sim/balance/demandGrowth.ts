export interface DemandGrowthInput {
  progress: number
  frontierCapability: number
  marketPricePerMTok: number
  userMinMultiplier: number
  userMaxMultiplier: number
  taskMinMultiplier: number
  taskMaxMultiplier: number
}

export interface DemandGrowthResult {
  userAdoptionMultiplier: number
  taskIntensityMultiplier: number
  capabilityAdoption: number
  affordability: number
  /** Capability and price must improve on the same offer to unlock this. */
  smartAffordability: number
}

export interface IntelligenceOfferPrice {
  capability: number
  pricePerMTok: number
}

/**
 * Cheapest price of work normalized to the current capability frontier.
 * Capability and price deliberately come from the same offer, so a cheap weak
 * endpoint cannot borrow a different model's intelligence in the TAM signal.
 */
export function frontierEquivalentMarketPrice(
  offers: readonly IntelligenceOfferPrice[],
  fallback = 100,
): number {
  if (offers.length === 0) return fallback
  const frontier = offers.reduce(
    (best, offer) => Math.max(best, Math.max(20, offer.capability)),
    20,
  )
  // Below this band, lower prices can expand that model's own segment demand
  // but cannot stand in for frontier-capable work that the model cannot do.
  const capableOffers = offers.filter(
    (offer) => offer.capability >= Math.max(35, frontier * 0.72),
  )
  return Math.min(
    ...capableOffers.map((offer) => {
      const listPrice = Math.max(0.05, offer.pricePerMTok)
      const qualityRatio = frontier / Math.max(20, offer.capability)
      return listPrice * Math.pow(qualityRatio, 1.35)
    }),
  )
}

/**
 * Bounded demand diffusion with separate adopter and task-intensity curves.
 * This prevents a 10x automation boom from implying 10x human population.
 */
export function demandGrowthAtProgress(
  input: DemandGrowthInput,
): DemandGrowthResult {
  const progress = Math.max(0, Math.min(1, input.progress))
  const capabilityAdoption = Math.max(
    0,
    Math.min(1, (input.frontierCapability - 20) / 65),
  )
  const affordability =
    1 / (1 + Math.max(0.01, input.marketPricePerMTok) / 4)
  const diffusion =
    progress <= 0
      ? 0
      : (1 - Math.exp(-6 * progress)) / (1 - Math.exp(-6))
  const userMin = Math.max(1, input.userMinMultiplier)
  const userMax = Math.max(userMin, input.userMaxMultiplier)
  const taskMin = Math.max(1, input.taskMinMultiplier)
  const taskMax = Math.max(taskMin, input.taskMaxMultiplier)
  // Intelligence and price are complements, not interchangeable signals.
  // Cheap weak models and unaffordable frontier demos can each seed adoption,
  // but cheap capable models unlock substantially more production workloads.
  const smartAffordability = capabilityAdoption * affordability
  const marketReadiness =
    capabilityAdoption * 0.5 +
    affordability * 0.25 +
    smartAffordability * 0.25
  const automationReadiness =
    capabilityAdoption * 0.55 +
    affordability * 0.15 +
    smartAffordability * 0.3
  const userEnd = userMin + (userMax - userMin) * marketReadiness
  const taskEnd = taskMin + (taskMax - taskMin) * automationReadiness
  return {
    userAdoptionMultiplier: 1 + (userEnd - 1) * diffusion,
    taskIntensityMultiplier: 1 + (taskEnd - 1) * diffusion,
    capabilityAdoption,
    affordability,
    smartAffordability,
  }
}
