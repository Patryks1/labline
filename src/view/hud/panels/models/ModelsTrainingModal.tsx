import type { ReactNode } from "react";
import { HudButton } from "../../ui/HudPrimitives";
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
}: {
  open: boolean;
  activeStep: ModelsWorkflowStep;
  completedThrough?: ModelsWorkflowStep;
  onStepChange: (step: ModelsWorkflowStep) => void;
  onCancel: () => void;
  footerAction?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <ConsoleDialog
      open={open}
      titleId="models-training-workflow"
      eyebrow="Model training"
      title="New training run"
      description="Set the goal, data and compute, then review the launch."
      mobileDescription="Goal → data → compute → launch."
      onClose={onCancel}
      closeLabel="Close training workflow"
      maxWidthClass="max-w-5xl"
      footer={
        <div className="space-y-3 [@media(max-height:600px)]:space-y-1">
          <ModelsWorkflowStepper
            activeStep={activeStep}
            completedThrough={completedThrough}
            onStepChange={onStepChange}
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <HudButton
              type="button"
              variant="ghost"
              onClick={onCancel}
              className="w-full sm:w-auto"
            >
              Cancel
            </HudButton>
            {footerAction ? (
              <div className="flex w-full gap-2 sm:w-auto">{footerAction}</div>
            ) : null}
          </div>
        </div>
      }
    >
      {children}
    </ConsoleDialog>
  );
}
