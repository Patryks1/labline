import type { ModelsDialog } from "../../viewModels/types";
import { DesignModelDialog } from "./DesignModelDialog";
import { DistillDialog } from "./DistillDialog";
import { EvaluateDialog } from "./EvaluateDialog";
import { MergeDialog } from "./MergeDialog";
import { PostTrainDialog } from "./PostTrainDialog";
import { ReleaseDialog } from "./ReleaseDialog";

export function ModelsDialogs({
  dialog,
  onClose,
}: {
  dialog: ModelsDialog;
  onClose: () => void;
}) {
  if (!dialog) return null;

  switch (dialog.kind) {
    case "design":
      return (
        <DesignModelDialog
          open
          onClose={onClose}
          goal={dialog.goal}
          parentCheckpointId={dialog.parentCheckpointId}
          teacherCheckpointId={dialog.teacherCheckpointId}
          copyFromEndpointId={dialog.copyFromEndpointId}
        />
      );
    case "postTrain":
      return <PostTrainDialog open onClose={onClose} checkpointId={dialog.checkpointId} />;
    case "distill":
      return (
        <DistillDialog open onClose={onClose} teacherCheckpointId={dialog.teacherCheckpointId} />
      );
    case "evaluate":
      return <EvaluateDialog open onClose={onClose} checkpointId={dialog.checkpointId} />;
    case "release":
      return <ReleaseDialog open onClose={onClose} checkpointId={dialog.checkpointId} />;
    case "merge":
      return <MergeDialog open onClose={onClose} aId={dialog.aId} bId={dialog.bId} />;
    case "router":
    case "sunset":
      return null;
    default: {
      const _exhaustive: never = dialog;
      void _exhaustive;
      return null;
    }
  }
}
