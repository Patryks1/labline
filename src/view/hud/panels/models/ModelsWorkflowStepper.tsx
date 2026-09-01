import type { ReactNode } from "react";
import { HudButton } from "../../ui/HudPrimitives";

export type ModelsWorkflowStep =
  | "product"
  | "architecture"
  | "data"
  | "compute"
  | "review";

const STEPS: ReadonlyArray<{
  id: ModelsWorkflowStep;
  label: string;
}> = [
  { id: "product", label: "Goal & I/O" },
  { id: "architecture", label: "Topology" },
  { id: "data", label: "Data" },
  { id: "compute", label: "Compute" },
  { id: "review", label: "Review" },
];

export const MODELS_WORKFLOW_STEPS = STEPS;

export const MODELS_CONTINUE_STEPS: ReadonlyArray<{
  id: ModelsWorkflowStep;
  label: string;
}> = [
  { id: "data", label: "Data extras" },
  { id: "compute", label: "Compute" },
  { id: "review", label: "Review" },
];

/**
 * Single-level workflow navigation. Form controls remain in their owner card;
 * clicking a step only changes which existing card is visible.
 */
export function ModelsWorkflowStepper({
  activeStep,
  completedThrough,
  onStepChange,
  onCancel,
  primaryAction,
  steps = STEPS,
}: {
  activeStep: ModelsWorkflowStep;
  completedThrough?: ModelsWorkflowStep;
  onStepChange?: (step: ModelsWorkflowStep) => void;
  onCancel?: () => void;
  primaryAction?: ReactNode;
  steps?: ReadonlyArray<{ id: ModelsWorkflowStep; label: string }>;
}) {
  const activeIndex = Math.max(0, steps.findIndex((step) => step.id === activeStep));
  const completedIndex = completedThrough
    ? steps.findIndex((step) => step.id === completedThrough)
    : activeIndex - 1;

  return (
    <nav
      aria-label="Model workflow"
      data-model-workflow="true"
      data-mobile-layout="compact-steps"
      className="rounded-lg border border-line/60 bg-void/25 px-1.5 py-2 sm:px-2.5"
    >
      <ol className={`grid gap-1 ${steps.length <= 2 ? "grid-cols-2" : steps.length === 3 ? "grid-cols-3" : "grid-cols-5"}`}>
        {steps.map((step, index) => {
          const complete = index <= completedIndex;
          const active = index === activeIndex;
          return (
            <li
              key={step.id}
              data-step={step.id}
              data-state={active ? "active" : complete ? "complete" : "upcoming"}
              className="min-w-0"
            >
              <HudButton
                type="button"
                variant="ghost"
                aria-label={step.label}
                aria-current={active ? "step" : undefined}
                aria-pressed={active}
                disabled={!onStepChange}
                onClick={() => onStepChange?.(step.id)}
                className={`!flex !min-h-11 !w-full !items-center !justify-center !gap-1 !rounded-md !border-0 !px-1 !text-left !text-[0.6875rem] !font-semibold !uppercase !tracking-[0.1em] transition xl:!justify-start xl:!gap-1.5 xl:!px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/45 disabled:cursor-default ${
                  active
                    ? "!bg-mint/10 !text-mint"
                    : complete
                      ? "!bg-transparent !text-bone hover:!bg-panel-2"
                      : "!bg-transparent !text-muted hover:!bg-panel-2 hover:!text-bone"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[0.625rem] ${
                    active
                      ? "border-mint bg-mint text-void"
                      : complete
                        ? "border-mint/50 text-mint"
                        : "border-line text-muted"
                  }`}
                >
                  {complete && !active ? "✓" : index + 1}
                </span>
                <span className="hidden min-w-0 whitespace-nowrap xl:inline">
                  {step.label}
                </span>
              </HudButton>
            </li>
          );
        })}
      </ol>
      {onStepChange ? (
        <div
          className="mt-2 flex flex-nowrap items-center gap-2 border-t border-line/45 pt-2"
        >
          {onCancel ? (
            <HudButton
              type="button"
              variant="danger"
              className="!min-h-11 !shrink-0 !rounded-md !px-3 !text-[0.6875rem] !font-semibold"
              onClick={onCancel}
            >
              Cancel
            </HudButton>
          ) : null}
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-11 !shrink-0 !rounded-md !border !border-line/70 !bg-void/40 !px-3 !text-[0.6875rem] !font-semibold !text-bone hover:!bg-panel-2"
            disabled={activeIndex <= 0}
            onClick={() => onStepChange(steps[activeIndex - 1]!.id)}
          >
            Back
          </HudButton>
          <span className="min-w-0 flex-1 text-center font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
            {activeIndex + 1} / {steps.length}
          </span>
          {activeIndex < steps.length - 1 ? (
            <HudButton
              type="button"
              variant="primary"
              className="!min-h-11 !shrink-0 !rounded-md !px-3 !text-[0.6875rem] !font-semibold"
              onClick={() => onStepChange(steps[activeIndex + 1]!.id)}
            >
              Continue
            </HudButton>
          ) : primaryAction ? (
            <div className="flex shrink-0 items-center gap-2">{primaryAction}</div>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
