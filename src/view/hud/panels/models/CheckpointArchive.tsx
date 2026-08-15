import { CheckpointRail } from "./CheckpointRail";
import type { CheckpointUiRecord } from "./checkpointUi";

export interface CheckpointArchiveEntry {
  sourceJobId: string;
  checkpoint: CheckpointUiRecord;
}

/** Keeps completed-job checkpoints reachable after their source run is gone. */
export function CheckpointArchive({
  entries,
  activeJobIds,
  onBenchmark,
  onReview,
  onPromote,
  onDiscard,
}: {
  entries: CheckpointArchiveEntry[];
  activeJobIds: readonly string[];
  onBenchmark?: (checkpointId: string) => void;
  onReview?: (checkpointId: string) => void;
  onPromote?: (checkpointId: string) => void;
  onDiscard?: (checkpointId: string) => void;
}) {
  const active = new Set(activeJobIds);
  const archived = entries
    .filter((entry) => !active.has(entry.sourceJobId))
    .map((entry) => entry.checkpoint);
  if (archived.length === 0) return null;
  return (
    <CheckpointRail
      checkpoints={archived}
      title="Checkpoint archive"
      onBenchmark={onBenchmark}
      onReview={onReview}
      onPromote={onPromote}
      onDiscard={onDiscard}
    />
  );
}
