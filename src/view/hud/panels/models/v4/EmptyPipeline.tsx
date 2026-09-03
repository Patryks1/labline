import { EmptyState } from "../../../ui/HudPrimitives";
import type { ReactNode } from "react";

export function EmptyPipeline({
  title = "No Runs yet",
  description = "Start a Model design to open a Run. Checkpoints, Recipes, and Endpoints follow from there.",
  mobileDescription = "Start a Model design to open a Run.",
  action,
}: {
  title?: string;
  description?: string;
  mobileDescription?: string;
  action?: ReactNode;
}) {
  return (
    <div data-empty-pipeline="true">
      <EmptyState
        title={title}
        description={description}
        mobileDescription={mobileDescription}
        action={action}
      />
    </div>
  );
}
