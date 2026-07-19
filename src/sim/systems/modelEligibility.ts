import type { DataDomain, MarketOffer, Model, SegmentId } from '../types'

/**
 * Image and video generators are products, not general-purpose reasoning models.
 * Multimodal language/omni models remain general because they can understand
 * media while still serving text, code, tools, and specialist workflows.
 */
export function isGenerationOnlyModel(
  model: Pick<Model, 'family' | 'productPreset'>,
): boolean {
  if (model.productPreset != null) {
    return (
      model.productPreset === 'image_generation' ||
      model.productPreset === 'video_generation'
    )
  }
  return model.family === 'diffusion' || model.family === 'video'
}

export function generationDomainForModel(
  model: Pick<Model, 'family' | 'productPreset'>,
): 'image' | 'video' | null {
  if (model.productPreset === 'image_generation') return 'image'
  if (model.productPreset === 'video_generation') return 'video'
  if (model.productPreset != null) return null
  if (model.family === 'diffusion') return 'image'
  if (model.family === 'video') return 'video'
  return null
}

export function modelCanCurateDataDomain(
  model: Pick<Model, 'family' | 'productPreset'>,
  domain: DataDomain,
): boolean {
  const generationDomain = generationDomainForModel(model)
  return generationDomain == null || generationDomain === domain
}

/** Creative is the sole demand segment representing generated media. */
export function modelCanCompeteForSegment(
  model: Pick<Model, 'family' | 'productPreset'>,
  segmentId: SegmentId,
): boolean {
  return !isGenerationOnlyModel(model) || segmentId === 'creative'
}

export function marketOfferCanCompeteForSegment(
  offer: Pick<MarketOffer, 'generationOnly' | 'apiListed' | 'subscriptionListed'>,
  segmentId: SegmentId,
  prefersSubscription = false,
): boolean {
  const generationEligible = offer.generationOnly !== true || segmentId === 'creative'
  if (!generationEligible) return false
  return prefersSubscription
    ? offer.subscriptionListed !== false
    : offer.apiListed !== false
}
