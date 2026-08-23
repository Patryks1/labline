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
  compactLabel: string;
}> = [
  { id: "product", label: "Product", compactLabel: "Goal" },
  { id: "architecture", label: "Architecture", compactLabel: "Arch" },
  { id: "data", label: "Data", compactLabel: "Data" },
  { id: "compute", label: "Compute", compactLabel: "Recipe" },
  { id: "review", label: "Review", compactLabel: "Rev" },
];

export const MODELS_WORKFLOW_STEPS = STEPS;

/**
 * Single-level workflow navigation. Form controls remain in their owner card;
 * clicking a step only changes which existing card is visible.
 */
export function ModelsWorkflowStepper({
  activeStep,
  completedThrough,
  onStepChange,
}: {
  activeStep: ModelsWorkflowStep;
  completedThrough?: ModelsWorkflowStep;
  onStepChange?: (step: ModelsWorkflowStep) => void;
}) {
  const activeIndex = STEPS.findIndex((step) => step.id === activeStep);
  const completedIndex = completedThrough
    ? STEPS.findIndex((step) => step.id === completedThrough)
    : activeIndex - 1;

  return (
    <nav
      aria-label="Model workflow"
      data-model-workflow="true"
      className="rounded-lg border border-line/60 bg-void/25 px-2.5 py-2"
    >
      <ol className="grid grid-cols-5 gap-1">
        {STEPS.map((step, index) => {
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
                className={`!flex !min-h-11 !w-full !items-center !gap-1 !rounded-md !border-0 !px-1 !text-left !text-[0.6875rem] !font-semibold !uppercase !tracking-[0.1em] transition max-[360px]:!tracking-[0.04em] sm:!gap-1.5 sm:!px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/45 disabled:cursor-default ${
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
                <span className="min-w-0 whitespace-nowrap max-[360px]:hidden">
                  {step.label}
                </span>
                <span
                  aria-hidden
                  className="hidden min-w-0 whitespace-nowrap max-[360px]:inline"
                >
                  {step.compactLabel}
                </span>
              </HudButton>
            </li>
          );
        })}
      </ol>
      {onStepChange ? (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line/45 pt-2">
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-11 !rounded-md !border-0 !bg-transparent !px-2.5 !text-[0.6875rem] !font-semibold !text-muted transition hover:!bg-panel-2 hover:!text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/45 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={activeIndex <= 0}
            onClick={() => onStepChange(STEPS[activeIndex - 1]!.id)}
          >
            ← Back
          </HudButton>
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
            Step {activeIndex + 1} of {STEPS.length}
          </span>
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-11 !rounded-md !border-0 !bg-transparent !px-2.5 !text-[0.6875rem] !font-semibold !text-muted transition hover:!bg-panel-2 hover:!text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/45 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={activeIndex >= STEPS.length - 1}
            onClick={() => onStepChange(STEPS[activeIndex + 1]!.id)}
          >
            Continue →
          </HudButton>
        </div>
      ) : null}
    </nav>
  );
}
