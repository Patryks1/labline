import type { TrainingJob } from "../../../../sim/types";

export function resolveModelsFocusJobId(
  jobs: readonly TrainingJob[],
  requestedJobId: string | null | undefined,
): string | null {
  return requestedJobId && jobs.some((job) => job.id === requestedJobId)
    ? requestedJobId
    : null;
}
