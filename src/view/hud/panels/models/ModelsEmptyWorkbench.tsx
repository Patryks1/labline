import { HudButton } from "../../ui/HudPrimitives";

const PIPELINE = [
  { n: "1", label: "Base", hint: "Raw corpus, one incident" },
  { n: "2", label: "Align", hint: "Chat tokens and post-train" },
] as const;

export function ModelsEmptyWorkbench({
  onOpenLabs,
  onOpenCheckpoints,
  onStartCampaign,
}: {
  onOpenLabs: () => void;
  onOpenCheckpoints: () => void;
  onStartCampaign: () => void;
}) {
  return (
    <div
      className="models-empty-workbench flex flex-col gap-4 rounded-lg border border-mint/35 bg-mint/5 px-3 py-4"
      data-models-empty-workbench="true"
    >
      <div className="min-w-0">
        <p className="hud-eyebrow">Campaign</p>
        <h3 className="mt-1 text-[1.0625rem] font-semibold text-bone">
          No campaign yet
        </h3>
        <p className="hud-mobile-detail mt-1.5 max-w-xl text-[0.8125rem] leading-5 text-muted">
          Two phases. Train a raw base on code, math, and science, then spend
          chat tokens in post-training to make a usable model. Weight files
          only exist if you save them.
        </p>
        <p className="hud-mobile-summary mt-1 text-[0.75rem] text-muted">
          Train a base, align it, then launch.
        </p>
      </div>
      <ol
        className="grid grid-cols-2 gap-1.5"
        data-empty-campaign-pipeline="true"
      >
        {PIPELINE.map((step) => (
          <li
            key={step.n}
            className="rounded-md border border-line/60 bg-void/40 px-2.5 py-2"
          >
            <span className="font-mono text-[0.5625rem] tabular-nums text-mint">
              {step.n}
            </span>
            <strong className="mt-1 block text-[0.8125rem] text-bone">
              {step.label}
            </strong>
            <span className="hud-mobile-detail mt-0.5 block text-[0.625rem] leading-4 text-muted">
              {step.hint}
            </span>
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-1.5 [&_.hud-button]:!min-h-11 [&_.hud-button]:!w-full sm:flex sm:flex-wrap sm:[&_.hud-button]:!w-auto">
        <HudButton
          type="button"
          variant="primary"
          className="col-span-2 min-h-11 sm:col-span-1"
          data-action="empty-start-campaign"
          onClick={onStartCampaign}
        >
          Start campaign
        </HudButton>
        <HudButton
          type="button"
          variant="secondary"
          className="min-h-11"
          onClick={onOpenCheckpoints}
        >
          Checkpoints
        </HudButton>
        <HudButton
          type="button"
          variant="secondary"
          className="min-h-11"
          onClick={onOpenLabs}
        >
          Gyms
        </HudButton>
      </div>
    </div>
  );
}
