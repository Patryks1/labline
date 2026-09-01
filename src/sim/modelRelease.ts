/** Live API/subscription serving. Archived weights stay trainable but off-market. */
export function isLivePublicModel(model: {
  archived?: boolean;
  soldIp?: boolean;
  release?: string;
  shipped?: boolean;
}): boolean {
  if (model.archived || model.soldIp) return false;
  return model.release === "released" || model.shipped === true;
}

/**
 * Released models stay on eval boards. Demand only hits them after listing.
 * Missing flag = legacy save: treat released models as already listed.
 */
export function isCommerciallyOffered(model: {
  archived?: boolean;
  release?: string;
  shipped?: boolean;
  commerciallyOffered?: boolean;
}): boolean {
  if (!isLivePublicModel(model)) return false;
  return model.commerciallyOffered !== false;
}

export function isArchivedModel(model: { archived?: boolean }): boolean {
  return model.archived === true;
}

export function isInternalFleetModel(model: {
  archived?: boolean;
  release?: string;
  shipped?: boolean;
}): boolean {
  return !isLivePublicModel(model) && !isArchivedModel(model);
}
