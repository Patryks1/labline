import { useState } from "react";
import type { EndpointCardVM } from "../../viewModels/types";
import { GameCard } from "../../../../ui/kit";
import { HudButton, HudMeter, StatusChip } from "../../../../ui/HudPrimitives";
import { gb, money, num, pct } from "../../../../format";
import { useGameStore } from "../../../../../../store/gameStore";
import { trainingStateOf } from "../../../../../../sim/training/state";
import { TiersControl } from "./TiersControl";
import { POLICY_LABEL, trySim } from "./fleetModel";
import type { EvalMetric } from "../../../../../../sim/training/types";
import { useModelsUi } from "../modelsUiStore";
import { copyFormulaFromEndpoint } from "../dialogs/designState";
import { FLEET_AGE_COPY_LOCK } from "../../../../../../sim/balance/modelAging";

function TwoStepAction({
  idleLabel,
  confirmLabel,
  onConfirm,
  name,
  variant = "danger",
}: {
  idleLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  name: string;
  variant?: "danger" | "secondary";
}) {
  const [armed, setArmed] = useState(false);
  if (armed) {
    return (
      <div data-two-step={name} data-two-step-armed="true">
        <HudButton
          variant={variant}
          className="min-h-11 min-w-0"
          onClick={() => {
            onConfirm();
            setArmed(false);
          }}
        >
          {confirmLabel}
        </HudButton>
        <HudButton variant="ghost" className="min-h-11 min-w-0" onClick={() => setArmed(false)}>
          Cancel
        </HudButton>
      </div>
    );
  }
  return (
    <HudButton
      variant={variant}
      className="min-h-11 min-w-0 w-full"
      data-two-step={name}
      onClick={() => setArmed(true)}
    >
      {idleLabel}
    </HudButton>
  );
}

function statusTone(status: EndpointCardVM["status"]): "positive" | "warning" | "neutral" {
  if (status === "live") return "positive";
  if (status === "sunset") return "warning";
  return "neutral";
}

function statusLabel(vm: EndpointCardVM): string {
  if (vm.status === "sunset") {
    const days = vm.sunsetDaysLeft ?? 0;
    return `Sunset · ${days}d left`;
  }
  if (vm.status === "retired") return "Retired";
  return "Live";
}

function shareLabel(share: number): string {
  if (share <= 1) return pct(share);
  return `${share.toFixed(1)}%`;
}

function publicScoreEntries(
  scores: EndpointCardVM["publicScores"],
): { key: string; value: number }[] {
  const overall = scores.overall;
  const rest = (Object.entries(scores) as [EvalMetric, number | undefined][])
    .filter((entry): entry is [EvalMetric, number] => entry[0] !== "overall" && typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, value]) => ({ key, value }));
  const rows: { key: string; value: number }[] = [];
  if (typeof overall === "number") rows.push({ key: "overall", value: overall });
  rows.push(...rest);
  return rows;
}

export function EndpointCard({
  vm,
  selected,
  onSelect,
  onOpenRouter,
  onOpenSunset,
}: {
  vm: EndpointCardVM;
  selected: boolean;
  onSelect: (endpointId: string) => void;
  onOpenRouter: (endpointId?: string) => void;
  onOpenSunset: (endpointId: string) => void;
}) {
  const retireEndpoint = useGameStore((s) => s.retireEndpoint);
  const openSourceEndpoint = useGameStore((s) => s.openSourceEndpoint);
  const setPanel = useGameStore((s) => s.setPanel);
  const openDialog = useModelsUi((s) => s.openDialog);
  const sim = useGameStore((s) => s.state);
  const endpoint = useGameStore((s) =>
    trainingStateOf(s.state, s.state.playerLabId).endpoints.find((item) => item.id === vm.id),
  );
  const formula = copyFormulaFromEndpoint(sim, vm.id);
  const pricing = endpoint?.pricing;
  const isRouter = vm.policy !== "single" || vm.memberNames.length > 1;
  const scores = publicScoreEntries(vm.publicScores);
  const liveOrSunset = vm.status === "live" || vm.status === "sunset";
  const agingFrac = vm.agingPct <= 1 ? vm.agingPct : vm.agingPct / 100;
  const tooStale = agingFrac >= FLEET_AGE_COPY_LOCK;
  const agingTone = agingFrac >= 0.7 ? "danger" : "warning";

  return (
    <GameCard
      title={vm.name}
      selected={selected}
      live={vm.status === "live"}
      tone={vm.status === "live" ? "mint" : vm.status === "sunset" ? "train" : undefined}
      className="min-w-0"
      ariaLabel={vm.name}
      onActivate={() => onSelect(vm.id)}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip tone="neutral">{POLICY_LABEL[vm.policy]}</StatusChip>
          <StatusChip tone={statusTone(vm.status)}>{statusLabel(vm)}</StatusChip>
          {vm.openWeights ? <StatusChip tone="positive">Open weights</StatusChip> : null}
        </div>
      }
    >
      <div data-endpoint-card={vm.id} data-endpoint-status={vm.status} className="space-y-3">
        {vm.memberNames.length > 0 ? (
          <p className="min-w-0 truncate text-[0.6875rem] text-muted">
            {vm.memberNames.join(", ")}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="min-w-0">
            <p className="text-[0.625rem] text-muted">Revenue/day</p>
            <p className="font-mono text-sm tabular-nums text-bone">{money(vm.revenuePerDay)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[0.625rem] text-muted">Share</p>
            <p className="font-mono text-sm tabular-nums text-bone">{shareLabel(vm.share)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[0.625rem] text-muted">tok/s</p>
            <p className="font-mono text-sm tabular-nums text-bone">{num(vm.tokPerSec, 0)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[0.625rem] text-muted">HBM</p>
            <p className="font-mono text-sm tabular-nums text-bone">{gb(vm.hbmGB)}</p>
          </div>
        </div>

        <HudMeter
          label="Aging"
          value={agingFrac}
          detail={shareLabel(agingFrac)}
          tone={agingTone}
        />

        {scores.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Public scores">
            {scores.map((row) => (
              <StatusChip key={row.key} tone="neutral">
                <span className="font-mono">
                  {row.key} {Math.round(row.value)}
                </span>
              </StatusChip>
            ))}
          </div>
        ) : null}

        {vm.status === "live" ? <TiersControl endpointId={vm.id} tiers={vm.tiers} /> : null}

        <div className="space-y-2 border-t border-line/70 pt-2">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="min-w-0 truncate font-mono text-[0.6875rem] tabular-nums text-muted">
              {pricing?.inPerMTok != null ? `${money(pricing.inPerMTok)} in` : "In unset"}
              {" / "}
              {pricing?.outPerMTok != null ? `${money(pricing.outPerMTok)} out` : "out unset"}
              {" / MTok"}
            </p>
            <HudButton
              variant="ghost"
              className="min-h-11 shrink-0 px-2.5"
              onClick={() => setPanel("plans")}
            >
              Plans
            </HudButton>
          </div>

          {liveOrSunset ? (
            <div className="models-v4-actions" data-endpoint-actions={vm.id}>
              {isRouter ? (
                <HudButton
                  variant="secondary"
                  className="min-h-11 min-w-0"
                  onClick={() => onOpenRouter(vm.id)}
                >
                  Members
                </HudButton>
              ) : null}
              <HudButton
                variant="secondary"
                className="min-h-11 min-w-0"
                data-copy-formula={vm.id}
                disabled={!formula || tooStale}
                disabledReason={
                  tooStale
                    ? "This recipe is too stale to start a new run."
                    : formula
                      ? undefined
                      : "No base formula on this endpoint."
                }
                onClick={() => openDialog({ kind: "design", copyFromEndpointId: vm.id })}
              >
                Copy formula
              </HudButton>
              {vm.openWeights ? null : (
                <TwoStepAction
                  name="open-source"
                  idleLabel="Open source"
                  confirmLabel="Confirm open source"
                  variant="secondary"
                  onConfirm={() => {
                    trySim(() => {
                      openSourceEndpoint(vm.id);
                    }, undefined);
                  }}
                />
              )}
              {vm.status === "live" ? (
                <HudButton
                  variant="secondary"
                  className="min-h-11 min-w-0"
                  onClick={() => onOpenSunset(vm.id)}
                >
                  Sunset
                </HudButton>
              ) : null}
              <TwoStepAction
                name="retire"
                idleLabel="Retire"
                confirmLabel="Confirm retire"
                onConfirm={() => {
                  trySim(() => {
                    retireEndpoint(vm.id);
                  }, undefined);
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </GameCard>
  );
}
