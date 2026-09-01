import type { ReactNode } from "react";
import { ConsoleDialog } from "../../ui/ConsoleDialog";
import {
  ModelsWorkflowStepper,
  type ModelsWorkflowStep,
} from "./ModelsWorkflowStepper";

/**
 * Viewport-level shell for the new-model workflow.
 *
 * The workflow is deliberately a dialog rather than a second surface in the
 * Models workbench. That keeps the queue visible as context while the form
 * owns the whole viewport, and lets ConsoleDialog provide the shared focus,
 * Escape, scroll and modal semantics used by other decision-heavy flows.
 */
export function ModelsTrainingModal({
  open,
  activeStep,
  completedThrough,
  onStepChange,
  onCancel,
  footerAction,
  children,
  steps,
  title = "New training run",
  description = "Set the goal, data and compute, then review the launch.",
  mobileDescription = "Goal → data → compute → launch.",
}: {
  open: boolean;
  activeStep: ModelsWorkflowStep;
  completedThrough?: ModelsWorkflowStep;
  onStepChange: (step: ModelsWorkflowStep) => void;
  onCancel: () => void;
  footerAction?: ReactNode;
  children?: ReactNode;
  steps?: ReadonlyArray<{ id: ModelsWorkflowStep; label: string }>;
  title?: string;
  description?: string;
  mobileDescription?: string;
}) {
  return (
    <ConsoleDialog
      open={open}
      titleId="models-training-workflow"
      eyebrow="Model training"
      title={title}
      description={description}
      mobileDescription={mobileDescription}
      onClose={onCancel}
      closeLabel="Close training workflow"
      maxWidthClass="max-w-5xl"
      footer={
        <ModelsWorkflowStepper
          activeStep={activeStep}
          completedThrough={completedThrough}
          onStepChange={onStepChange}
          onCancel={onCancel}
          primaryAction={footerAction}
          steps={steps}
        />
      }
    >
      {children}
    </ConsoleDialog>
  );
}
