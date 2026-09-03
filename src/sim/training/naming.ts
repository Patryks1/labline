import { recipeStageLabel, STAGE_LABEL } from "./postTrainStages";
import type {
  Checkpoint,
  PostTrainStageKind,
  TrainingState,
} from "./types";

export const POST_STAGE_ORDER: readonly PostTrainStageKind[] = [
  "instruct",
  "preference",
  "reasoning",
  "agentic",
];

const STAGE_SUFFIX_RE =
  /\s·\s(?:Base|Instruct|Preference|Reasoning|Agentic|Post)(?:\+(?:Instruct|Preference|Reasoning|Agentic))*$/i;

export function isPlaceholderCheckpointName(name: string): boolean {
  const trimmed = name.trim();
  return /^auto-\d+$/i.test(trimmed) || /@\d+%$/.test(trimmed);
}

export function orderedPostStages(
  stages: readonly PostTrainStageKind[] | Partial<Record<PostTrainStageKind, unknown>>,
): PostTrainStageKind[] {
  const present = new Set(
    Array.isArray(stages) ? stages : (Object.keys(stages) as PostTrainStageKind[]),
  );
  return POST_STAGE_ORDER.filter((stage) => present.has(stage));
}

export function stripStageSuffix(name: string): string {
  let next = name.trim();
  while (STAGE_SUFFIX_RE.test(next)) {
    next = next.replace(STAGE_SUFFIX_RE, "").trim();
  }
  return next;
}

function resolveStoredName(
  checkpoint: Pick<Checkpoint, "name" | "runId">,
  training: Pick<TrainingState, "runs">,
): string {
  if (!isPlaceholderCheckpointName(checkpoint.name)) return checkpoint.name;
  const run = checkpoint.runId
    ? training.runs.find((row) => row.id === checkpoint.runId)
    : undefined;
  if (run?.design.name) return run.design.name;
  return checkpoint.name;
}

export function lineageBaseName(
  checkpoint: Pick<Checkpoint, "id" | "name" | "parentId" | "runId">,
  training: Pick<TrainingState, "checkpoints" | "runs">,
): string {
  const byId = new Map(training.checkpoints.map((row) => [row.id, row]));
  const seen = new Set<string>();
  let cursor: typeof checkpoint | undefined = checkpoint;
  while (cursor?.parentId) {
    if (seen.has(cursor.id)) break;
    const parent = byId.get(cursor.parentId);
    if (!parent) break;
    seen.add(cursor.id);
    cursor = parent;
  }
  const resolved = cursor ? resolveStoredName(cursor, training) : checkpoint.name;
  const stripped = stripStageSuffix(resolved);
  if (!isPlaceholderCheckpointName(stripped)) return stripped;
  return resolveStoredName(checkpoint, training);
}

export function persistBaseCheckpointName(designName: string): string {
  const base = stripStageSuffix(designName.trim()) || designName.trim() || "Model";
  return `${base} · Base`;
}

export function persistPostCheckpointName(
  source: Pick<Checkpoint, "id" | "name" | "parentId" | "runId">,
  training: Pick<TrainingState, "checkpoints" | "runs">,
  stages: readonly PostTrainStageKind[],
): string {
  const base = lineageBaseName(source, training);
  const label = recipeStageLabel(orderedPostStages(stages));
  return label ? `${base} · ${label}` : `${base} · Post`;
}

function leftoverStageLabel(stored: string, base: string): string | null {
  const stripped = stripStageSuffix(stored);
  if (stored !== stripped) {
    const suffix = stored.slice(stripped.length).replace(/^\s·\s/, "").trim();
    return suffix || null;
  }
  if (base && stored.toLowerCase().startsWith(base.toLowerCase())) {
    const rest = stored.slice(base.length).replace(/^[\s·]+/, "").trim();
    return rest || null;
  }
  return null;
}

export function checkpointDisplayName(
  checkpoint: Pick<Checkpoint, "id" | "name" | "stage" | "parentId" | "runId" | "postTrain">,
  training: Pick<TrainingState, "checkpoints" | "runs">,
): string {
  const base = lineageBaseName(checkpoint, training);
  if (checkpoint.stage === "base") return persistBaseCheckpointName(base);
  const fromRecord = orderedPostStages(checkpoint.postTrain.stages);
  if (fromRecord.length > 0) return persistPostCheckpointName(checkpoint, training, fromRecord);
  const leftover = leftoverStageLabel(checkpoint.name, base);
  if (leftover && !isPlaceholderCheckpointName(leftover)) return `${base} · ${leftover}`;
  return `${base} · Post`;
}

export function postStageLabel(kind: PostTrainStageKind): string {
  return STAGE_LABEL[kind];
}
