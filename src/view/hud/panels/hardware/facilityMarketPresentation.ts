import type { FacilityAcquisitionOffer, MapTile } from '../../../../sim/types'

export function facilityAcquisitionPresentation(
  tile: Pick<MapTile, 'forSale' | 'listPrice'>,
  offer?: FacilityAcquisitionOffer,
): { mode: 'bid' | 'listed' | 'pending' | 'countered'; amount?: number } {
  if (offer?.status === 'countered') return { mode: 'countered', amount: offer.counterAmount ?? offer.amount }
  if (offer?.status === 'pending') return { mode: 'pending', amount: offer.amount }
  if (tile.forSale && tile.listPrice && tile.listPrice > 0) return { mode: 'listed', amount: tile.listPrice }
  return { mode: 'bid' }
}
