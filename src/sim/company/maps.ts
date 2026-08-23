import type { Model, ProductOffer, TrainingJob } from "../types";
import type { ModelDeployment } from "./types";

export function recordsFromOrder<T extends { id: string }>(
  items: readonly T[] | undefined,
): { byId: Record<string, T>; order: string[] } {
  const byId: Record<string, T> = {};
  const order: string[] = [];
  for (const item of items ?? []) {
    if (!item?.id || byId[item.id]) continue;
    byId[item.id] = item;
    order.push(item.id);
  }
  return { byId, order };
}

export function orderedFromRecord<T>(
  byId: Record<string, T> | undefined,
  order: readonly string[] | undefined,
): T[] {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const id of order ?? []) {
    const item = byId?.[id];
    if (!item || seen.has(id)) continue;
    seen.add(id);
    items.push(item);
  }
  if (byId) {
    for (const [id, item] of Object.entries(byId)) {
      if (seen.has(id)) continue;
      items.push(item);
    }
  }
  return items;
}

export function modelsFromCompany(
  modelsById: Record<string, Model>,
  modelOrder: readonly string[],
): Model[] {
  return orderedFromRecord(modelsById, modelOrder);
}

export function jobsFromCompany(
  jobsById: Record<string, TrainingJob>,
  jobOrder: readonly string[],
): TrainingJob[] {
  return orderedFromRecord(jobsById, jobOrder);
}

export function assertModelReferences(opts: {
  modelsById: Record<string, Model>;
  productsById: Record<string, ProductOffer>;
  deploymentsById: Record<string, ModelDeployment>;
  jobsById: Record<string, TrainingJob>;
}): void {
  for (const product of Object.values(opts.productsById)) {
    if (!opts.modelsById[product.primaryModelId]) {
      throw new Error(
        `Product ${product.id} references missing model ${product.primaryModelId}`,
      );
    }
    for (const modelId of product.modelIds) {
      if (!opts.modelsById[modelId]) {
        throw new Error(`Product ${product.id} references missing model ${modelId}`);
      }
    }
  }
  for (const deployment of Object.values(opts.deploymentsById)) {
    if (!opts.modelsById[deployment.modelId]) {
      throw new Error(
        `Deployment ${deployment.id} references missing model ${deployment.modelId}`,
      );
    }
  }
  for (const job of Object.values(opts.jobsById)) {
    if (job.teacherId && !opts.modelsById[job.teacherId] && job.mode === "distill") {
      // Teacher may have been archived/deleted after freeze; the frozen plan keeps the id.
      continue;
    }
    if (job.continueFromId && !opts.modelsById[job.continueFromId]) {
      throw new Error(
        `Training job ${job.id} continues from missing model ${job.continueFromId}`,
      );
    }
  }
}
