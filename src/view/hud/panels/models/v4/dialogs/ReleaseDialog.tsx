import { useEffect, useMemo, useState } from "react";
import type { ServePrecision } from "../../../../../../sim/types";
import {
  apiComparablePeerRows,
  apiHostingCostFloor,
  blendApiPrice,
  clampApiListToHostingFloor,
  commercialModelKind,
} from "../../../../../../sim/balance/pricing";
import { computeSnapshot } from "../../../../../../sim/systems/compute";
import { isLivePublicModel } from "../../../../../../sim/modelRelease";
import { overallCapability } from "../../../../../../sim/training/scaling";
import { useGameStore } from "../../../../../../store/gameStore";
import { gb, money, num } from "../../../../format";
import { formatApiListPrice, effectiveApiPeerPricing } from "../../../apiPriceUi";
import { formatFrontierThinking, frontierThinkingFor } from "../../../BenchmarkCompareTab";
import { HudButton, HudInput } from "../../../../ui/HudPrimitives";
import { ConsoleDialog } from "../../../../ui/ConsoleDialog";
import { DialogFooter } from "./DialogStepper";
import {
  QUANT_OPTIONS,
  TRAIN_TO_SERVE,
  actionError,
  checkpointById,
  serveHbmGB,
} from "./designState";
import { tierLabel } from "../fleet/fleetModel";

export function ReleaseDialog({
  open,
  onClose,
  checkpointId,
}: {
  open: boolean;
  onClose: () => void;
  checkpointId: string;
}) {
  const sim = useGameStore((s) => s.state);
  const createEndpoint = useGameStore((s) => s.createEndpoint);
  const setEndpointTier = useGameStore((s) => s.setEndpointTier);
  const listReleasedModel = useGameStore((s) => s.listReleasedModel);
  const checkpoint = checkpointById(sim, checkpointId);
  const native = checkpoint ? TRAIN_TO_SERVE[checkpoint.arch.precision] : "bf16";
  const plans = sim.player.pricing.plans;
  const [name, setName] = useState(checkpoint?.name ?? "Endpoint");
  const [precision, setPrecision] = useState<ServePrecision>(native);
  const [openWeights, setOpenWeights] = useState(false);
  const [servedTiers, setServedTiers] = useState<Record<number, boolean>>(() => {
    const next: Record<number, boolean> = {};
    for (const tier of checkpoint?.tiers ?? []) next[tier.budget] = tier.served;
    return next;
  });
  const [apiOn, setApiOn] = useState(true);
  const [apiIn, setApiIn] = useState(0.8);
  const [apiOut, setApiOut] = useState(3.2);
  const [planIds, setPlanIds] = useState<string[]>(() => plans.map((plan) => plan.id));
  const [actionErr, setActionErr] = useState<string | null>(null);

  const precisionOptions = useMemo(() => {
    const ids = new Set<ServePrecision>([native, ...QUANT_OPTIONS.map((row) => row.id)]);
    return [...ids];
  }, [native]);

  const hosting = useMemo(() => {
    if (!checkpoint) return null;
    try {
      return apiHostingCostFloor(sim, computeSnapshot(sim), {
        id: checkpoint.id,
        paramsB: checkpoint.arch.totalParamsB,
        activeParamsB: checkpoint.arch.activeParamsB,
        family: checkpoint.arch.backbone === "moe" ? "moe" : "dense",
        inferCostMult: 1,
        tokPerSecMult: 1,
      });
    } catch {
      return null;
    }
  }, [checkpoint, sim]);

  useEffect(() => {
    if (!open || !checkpoint) return;
    const nextTiers: Record<number, boolean> = {};
    for (const tier of checkpoint.tiers) nextTiers[tier.budget] = tier.served;
    const suggestedIn = 0.8;
    const suggestedOut = 3.2;
    const seeded = hosting
      ? clampApiListToHostingFloor(suggestedIn, suggestedOut, hosting)
      : { priceIn: suggestedIn, priceOut: suggestedOut };
    setName(checkpoint.name);
    setPrecision(TRAIN_TO_SERVE[checkpoint.arch.precision]);
    setOpenWeights(false);
    setServedTiers(nextTiers);
    setApiOn(true);
    setApiIn(seeded.priceIn);
    setApiOut(seeded.priceOut);
    setPlanIds(plans.map((plan) => plan.id));
    setActionErr(null);
  }, [open, checkpointId]);

  const hbm = serveHbmGB(checkpoint?.arch.totalParamsB ?? 0, precision);
  const note = QUANT_OPTIONS.find((row) => row.id === precision)?.note;
  const capability = checkpoint ? overallCapability(checkpoint.truth) : 0;
  const comparablePeers = useMemo(() => {
    if (!checkpoint) return [];
    const blend = blendApiPrice(apiIn, apiOut);
    const peers = sim.rivals.flatMap((rival) =>
      rival.models.filter(isLivePublicModel).map((model) => {
        const effective = effectiveApiPeerPricing(rival.pricing, model);
        return {
          name: model.name,
          price: effective.price,
          capability: model.capability,
          featureScore: model.modalities.length * 18,
          tokPerSec: model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult,
          kind: commercialModelKind(model),
          thinking: frontierThinkingFor(model),
        };
      }),
    );
    return apiComparablePeerRows(
      blend,
      {
        capability,
        featureScore: checkpoint.arch.inputs.length * 18,
        tokPerSec: 52,
      },
      peers,
    ).map((row) => ({
      ...row,
      thinking: peers.find((peer) => peer.name === row.name)?.thinking,
    }));
  }, [apiIn, apiOut, capability, checkpoint, sim.rivals]);

  const release = () => {
    try {
      const listed = hosting
        ? clampApiListToHostingFloor(apiIn, apiOut, hosting)
        : { priceIn: apiIn, priceOut: apiOut };
      const result = createEndpoint({
        name,
        checkpointId,
        precision,
        pricing: {
          inPerMTok: apiOn ? listed.priceIn : null,
          outPerMTok: apiOn ? listed.priceOut : null,
        },
        openWeights,
      });
      if (!result.ok) {
        setActionErr(result.reason);
        return;
      }
      for (const tier of checkpoint?.tiers ?? []) {
        const served = servedTiers[tier.budget] ?? tier.served;
        if (served !== tier.served) setEndpointTier(result.id, tier.budget, served);
      }
      listReleasedModel({
        modelId: result.id,
        sell: true,
        apiIn: apiOn ? listed.priceIn : null,
        apiOut: apiOn ? listed.priceOut : null,
        planIds,
      });
      setActionErr(null);
      onClose();
    } catch (cause) {
      setActionErr(actionError(cause));
    }
  };

  return (
    <ConsoleDialog
      open={open}
      titleId="v4-release"
      eyebrow="Release"
      title={checkpoint ? `Release ${checkpoint.name}` : "Release endpoint"}
      description="Ship a live endpoint, price the API, and pick plans."
      mobileDescription="Name, precision, API, plans."
      onClose={onClose}
      closeLabel="Close release"
      maxWidthClass="max-w-5xl"
      footer={
        <DialogFooter
          onCancel={onClose}
          primaryLabel="Release"
          onPrimary={release}
          disabled={!name.trim()}
        />
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <label className="block">
            <span className="text-[0.75rem] text-muted">Endpoint name</span>
            <HudInput
              className="mt-1 min-h-11 w-full"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Endpoint name"
            />
          </label>
          <div>
            <p className="mb-2 text-[0.75rem] text-muted">Serving precision</p>
            <div className="flex flex-wrap gap-2" data-serve-precision="true">
              {precisionOptions.map((id) => (
                <HudButton
                  key={id}
                  type="button"
                  variant={precision === id ? "primary" : "ghost"}
                  className="!min-h-11 uppercase"
                  aria-pressed={precision === id}
                  onClick={() => setPrecision(id)}
                >
                  {id}
                  {id === native ? " native" : ""}
                </HudButton>
              ))}
            </div>
            {note ? <p className="mt-2 text-[0.6875rem] text-muted">{note}</p> : null}
          </div>
          <div>
            <p className="mb-2 text-[0.75rem] text-muted">Thinking tiers</p>
            <div className="flex flex-wrap gap-2" data-endpoint-tiers="true">
              {(checkpoint?.tiers ?? []).map((tier) => {
                const on = servedTiers[tier.budget] ?? tier.served;
                return (
                  <HudButton
                    key={tier.budget}
                    type="button"
                    variant={on ? "primary" : "ghost"}
                    className="!min-h-11"
                    aria-pressed={on}
                    onClick={() =>
                      setServedTiers((current) => ({ ...current, [tier.budget]: !on }))
                    }
                  >
                    {tierLabel(tier.budget)} {on ? "on" : "off"}
                  </HudButton>
                );
              })}
            </div>
          </div>
          <HudButton
            type="button"
            variant={openWeights ? "primary" : "ghost"}
            className="!min-h-11"
            aria-pressed={openWeights}
            data-open-weights="true"
            onClick={() => setOpenWeights((value) => !value)}
          >
            {openWeights ? "Open weights on" : "Open weights off"}
          </HudButton>
          {openWeights ? (
            <p className="text-[0.6875rem] text-muted">
              Public weights. Hosted plan and API demand ease; brand reputation rises.
            </p>
          ) : null}
          <p data-hbm-estimate="true" className="font-mono text-[0.75rem] tabular-nums text-bone">
            Serving HBM {gb(hbm)}
          </p>
        </div>
        <div className="space-y-3">
          <div className="rounded-md border border-line/60 bg-void/35 px-3 py-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-[0.75rem] text-muted">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-mint"
                checked={apiOn}
                onChange={(event) => setApiOn(event.target.checked)}
                data-api-listing="true"
              />
              <span className="font-medium text-bone">API listing</span>
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-[0.6875rem] text-muted">
                In $/MTok
                <HudInput
                  className="mt-1 w-full"
                  type="number"
                  min={hosting?.costIn ?? 0}
                  step={0.01}
                  disabled={!apiOn}
                  value={apiIn}
                  invalid={Boolean(hosting && apiIn < hosting.costIn)}
                  onChange={(event) => setApiIn(Number(event.target.value))}
                  onBlur={() => {
                    if (!hosting) return;
                    const listed = clampApiListToHostingFloor(apiIn, apiOut, hosting);
                    setApiIn(listed.priceIn);
                    setApiOut(listed.priceOut);
                  }}
                  aria-label="Input price per MTok"
                />
                {hosting ? (
                  <span className="mt-1 block font-mono text-[0.625rem] tabular-nums text-mint">
                    Floor ${formatApiListPrice(hosting.costIn)}
                  </span>
                ) : null}
              </label>
              <label className="text-[0.6875rem] text-muted">
                Out $/MTok
                <HudInput
                  className="mt-1 w-full"
                  type="number"
                  min={hosting?.costOut ?? 0}
                  step={0.01}
                  disabled={!apiOn}
                  value={apiOut}
                  invalid={Boolean(hosting && apiOut < hosting.costOut)}
                  onChange={(event) => setApiOut(Number(event.target.value))}
                  onBlur={() => {
                    if (!hosting) return;
                    const listed = clampApiListToHostingFloor(apiIn, apiOut, hosting);
                    setApiIn(listed.priceIn);
                    setApiOut(listed.priceOut);
                  }}
                  aria-label="Output price per MTok"
                />
                {hosting ? (
                  <span className="mt-1 block font-mono text-[0.625rem] tabular-nums text-mint">
                    Floor ${formatApiListPrice(hosting.costOut)}
                  </span>
                ) : null}
              </label>
            </div>
            {comparablePeers.length > 0 ? (
              <div className="mt-2" data-testid="release-comparable-peers">
                <p className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                  Similar capability
                </p>
                <ul className="mt-1 space-y-0.5">
                  {comparablePeers.map((peer) => (
                    <li
                      key={`${peer.name}-${peer.capability}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 font-mono text-[0.6875rem] tabular-nums min-[420px]:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
                    >
                      <span className="min-w-0 truncate text-bone">
                        {peer.name}
                        {peer.thinking?.thinkingTokenMult != null
                          ? ` · ${formatFrontierThinking(peer.thinking)}`
                          : ""}
                      </span>
                      <span className="shrink-0 text-bone">
                        ${formatApiListPrice(peer.price)}/M
                      </span>
                      <span className="text-muted min-[420px]:shrink-0">
                        cap {num(peer.capability, 0)}
                      </span>
                      <span
                        className={`text-right uppercase tracking-[0.08em] min-[420px]:shrink-0 ${
                          peer.position === "cheaper"
                            ? "text-mint"
                            : peer.position === "premium"
                              ? "text-amber"
                              : "text-muted"
                        }`}
                      >
                        {peer.position}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="rounded-md border border-line/60 bg-void/35 px-3 py-2.5" data-release-plans="true">
            <p className="text-[0.75rem] font-medium text-bone">Plans</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {plans.length === 0 ? (
                <p className="text-[0.6875rem] text-muted">No plans yet.</p>
              ) : (
                plans.map((plan) => {
                  const checked = planIds.includes(plan.id);
                  return (
                    <label
                      key={plan.id}
                      className="flex min-h-11 cursor-pointer items-center gap-2 text-[0.75rem] text-muted"
                    >
                      <input
                        type="checkbox"
                        className="size-5 shrink-0 accent-mint"
                        checked={checked}
                        onChange={() =>
                          setPlanIds((current) =>
                            checked
                              ? current.filter((id) => id !== plan.id)
                              : [...current, plan.id],
                          )
                        }
                      />
                      <span className="truncate text-bone">{plan.name}</span>
                      <span className="ml-auto font-mono text-[0.625rem]">
                        {money(plan.pricePerMonth)}/mo
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </div>
        {actionErr ? (
          <p role="alert" className="text-[0.75rem] text-danger lg:col-span-2">
            {actionErr}
          </p>
        ) : null}
      </div>
    </ConsoleDialog>
  );
}
