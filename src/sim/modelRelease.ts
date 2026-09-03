/** Live API/subscription serving. Archived weights stay trainable but off-market. */
export function isLivePublicModel(model: {
  archived?: boolean;
  soldIp?: boolean;
  release?: string;
  shipped?: boolean;
  commerciallyOffered?: boolean;
  endpointId?: string;
}): boolean {
  if (model.archived || model.soldIp) return false;
  if (isV4ProjectedModel(model)) {
    return model.release === "released" && model.commerciallyOffered === true;
  }
  // V4-DELETE: legacy models use shipped or release.
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

/** Market projection produced from a V4 endpoint (`Endpoint.modelId === Endpoint.id`). */
export function isV4ProjectedModel(model: { endpointId?: string }): boolean {
  return typeof model.endpointId === "string" && model.endpointId.length > 0;
}
