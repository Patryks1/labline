import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Handshake, PaperPlaneTilt } from "@phosphor-icons/react";
import {
  activeCityPowerContracts,
  activePowerExportContracts,
  cancelCityPowerContract,
  cancelPowerExportContract,
  cityDashboard,
  citiesInGridConnectorRange,
  evaluatePowerExportOffer,
  evaluatePowerImportOffer,
  powerBalance,
  powerExportNegotiationQuote,
  powerImportNegotiationQuote,
  powerImportBill,
  signCityPowerContract,
  signPowerExportContract,
} from "../../../sim/systems/facilities";
import type { SimState } from "../../../sim/types";
import {
  energyPriceForState,
  gridScarcity,
  resolvePlayerPowerMw,
} from "../../../sim/systems/map";
import { fleetStats } from "../../../sim/systems/racks";
import { useGameStore } from "../../../store/gameStore";
import {
  EMPTY_NEGOTIATION,
  formatNegotiationTimestamp,
  powerNegotiationKey,
  reopenEndedNegotiation,
  useUiStore,
} from "../../../store/uiStore";
import { computeSnapshot } from "../../../sim/tick";
import { money, mw, num, pct, pf } from "../format";
import {
  EmptyState,
  HudButton,
  HudSelect,
  PanelScaffold,
  StatusChip,
} from "../ui/HudPrimitives";
import {
  BlockerList,
  GameCard,
  LiveDot,
  MeterBar,
  SegmentedTabs,
  StatRow,
} from "../ui/kit";
import { ResponsiveDonut } from "../ui/dataViz/ResponsiveDonut";
import { Sparkline } from "../ui/dataViz/Sparkline";
import {
  NegotiationHeader,
  NegotiationComposer,
  NegotiationMessage,
  NegotiationMetric,
  NegotiationSlider,
} from "../ui/NegotiationRoom";
import {
  renewCityPowerContract,
  renewPowerExportContract,
} from "./powerPanelActions";

import { HudDesktopDefaultDetails } from "../ui/HudDesktopDefaultDetails";

type NegotiationState = {
  mode: "import" | "export";
  cityId: string;
  offerPrice?: number;
};

type PowerTab = "status" | "desk";

export type PowerMixSlice = {
  id: string;
  label: string;
  mw: number;
  color: string;
};

export function PowerPanel() {
  const state = useGameStore((store) => store.state);
  const setState = (next: typeof state) =>
    useGameStore.setState({ state: next });
  const balance = powerBalance(state);
  const scarcity = gridScarcity(state);
  const wholesale = energyPriceForState(state);
  const snap = computeSnapshot(state);
  const resolved = resolvePlayerPowerMw(state, snap.mwDemand);
  const bill = powerImportBill(state, resolved.mwGridImport);
  const importContracts = activeCityPowerContracts(state);
  const exportContracts = activePowerExportContracts(state);
  const citiesInRange = new Set(
    citiesInGridConnectorRange(state).map((city) => city.id),
  );
  const cities = cityDashboard(state).filter(({ city }) =>
    citiesInRange.has(city.id),
  );
  const citySelectionKey = cities.map(({ city }) => city.id).join("|");
  const [contractMw, setContractMw] = useState(8);
  const [contractTerm, setContractTerm] = useState(60);
  const [tab, setTab] = useState<PowerTab>("status");
  const [negotiation, setNegotiation] = useState<NegotiationState>(() => ({
    mode: "import",
    cityId: cities[0]?.city.id ?? "",
  }));

  useEffect(() => {
    const availableCityIds = citySelectionKey ? citySelectionKey.split("|") : [];
    setNegotiation((current) =>
      availableCityIds.includes(current.cityId)
        ? current
        : {
            ...current,
            cityId: availableCityIds[0] ?? "",
            offerPrice: undefined,
          },
    );
  }, [citySelectionKey]);

  const short = Math.max(
    0,
    balance.demandMw - resolved.mwAvailable,
  );
  const supplyRatio =
    balance.demandMw > 0.001
      ? Math.min(1, (balance.demandMw - short) / balance.demandMw)
      : 1;

  // Power mix: generated MW feed demand first (split by source), contracts and
  // spot cover the rest, and any surplus leaves as export or curtailment.
  const contractCapMw = importContracts.reduce(
    (sum, contract) => sum + Math.max(0, contract.mw),
    0,
  );
  const genUsedShare =
    balance.genMw > 1e-6 ? balance.generationUsedMw / balance.genMw : 0;
  const mixSlices: PowerMixSlice[] = [];
  const pushSlice = (id: string, label: string, sliceMw: number, color: string) => {
    if (sliceMw > 1e-4) mixSlices.push({ id, label, mw: sliceMw, color });
  };
  pushSlice("solar", "Solar", balance.genBySourceMw.solarMw * genUsedShare, "var(--color-gold)");
  pushSlice("gas", "Gas", balance.genBySourceMw.gasMw * genUsedShare, "var(--color-amber)");
  pushSlice("nuclear", "Nuclear", balance.genBySourceMw.nuclearMw * genUsedShare, "var(--color-research)");
  pushSlice("other-gen", "Other on-site", balance.genBySourceMw.otherMw * genUsedShare, "var(--color-mint)");
  importContracts.forEach((contract, index) => {
    const deliveredMw =
      contractCapMw > 1e-6
        ? (bill.contractMw * Math.max(0, contract.mw)) / contractCapMw
        : 0;
    pushSlice(
      `city-${contract.id}`,
      `${contract.cityName} contract`,
      deliveredMw,
      `color-mix(in srgb, var(--color-infer) ${Math.round(Math.max(0.45, 1 - index * 0.18) * 100)}%, transparent)`,
    );
  });
  pushSlice("ppa", "PPA import", bill.energyContractMw, "var(--color-infer)");
  pushSlice("spot", "Spot import", bill.spotMw, "var(--color-muted)");
  pushSlice("export", "Export (sold)", balance.exportMw, "var(--color-mint)");
  pushSlice("curtailed", "Curtailed", balance.curtailedMw, "color-mix(in srgb, var(--color-muted) 45%, transparent)");

  return (
    <PanelScaffold
      eyebrow="Infrastructure"
      title="Power"
      description="Grid MW, utility contracts, and surplus export."
      mobileDescription="Supply, cost, and utility deals."
    >
      <div className="min-w-0 touch-pan-y space-y-3">
        <GameCard
          eyebrow="Power mix"
          title="Where the MW come from"
          tone={short > 0.05 ? "danger" : "mint"}
          actions={
            short > 0.05 ? (
              <StatusChip tone="danger">Short {mw(short)}</StatusChip>
            ) : (
              <StatusChip tone="positive">Covered</StatusChip>
            )
          }
        >
          <div className="grid min-w-0 grid-cols-1 items-center gap-3 min-[400px]:grid-cols-[auto_minmax(0,1fr)]">
            <PowerMixDonut
              slices={mixSlices}
              coveredPct={supplyRatio}
              demandMw={balance.demandMw}
            />
            <div className="min-w-0 space-y-0.5">
              {mixSlices.length === 0 ? (
                <p className="text-[0.8125rem] text-muted">
                  No supply yet — build generation or buy grid power.
                </p>
              ) : (
                mixSlices.map((slice) => (
                  <div
                    key={slice.id}
                    className="flex min-w-0 items-baseline justify-between gap-3 py-0.5"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-muted">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: slice.color }}
                      />
                      <span className="truncate">{slice.label}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[0.8125rem] tabular-nums text-bone">
                      {mw(slice.mw)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="mt-2 border-t border-line/50 pt-1">
            <StatRow label="Spot price" value={`${money(wholesale)}/MWh`} />
          </div>
        </GameCard>

        <GameCard
          eyebrow="Supply vs demand"
          title={
            balance.demandMw <= 0.001
              ? "No active load"
              : short > 0.05
                ? "Power pressure"
                : "Demand covered"
          }
          live={short > 0.05}
          tone={short > 0.05 ? "danger" : "mint"}
          actions={
            short > 0.05 ? (
              <LiveDot className="text-danger" />
            ) : balance.demandMw <= 0.001 ? (
              <StatusChip tone="neutral">Idle</StatusChip>
            ) : (
              <StatusChip tone="positive">OK</StatusChip>
            )
          }
        >
          <MeterBar
            label="MW covered"
            value={supplyRatio}
            detail={`${mw(Math.max(0, balance.demandMw - short))} / ${mw(balance.demandMw)}`}
            tone={
              short > 0.05
                ? "danger"
                : supplyRatio < 0.9
                  ? "warning"
                  : "positive"
            }
            live={short > 0.05}
          />
          <div className="mt-2 space-y-0.5">
            <StatRow label="Physical demand" value={mw(balance.demandMw)} />
            <StatRow
              label="Brownout shortfall"
              value={mw(short)}
              tone={short > 0.05 ? "danger" : "positive"}
            />
            <StatRow
              label="Daily power cost"
              value={`${money(balance.generationCostDay + bill.totalCostDay)}/d`}
              strong
            />
          </div>
          <HudDesktopDefaultDetails className="group mt-2 rounded-md border border-line/60 bg-void/30">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.75rem] text-muted marker:hidden">
              <span>Power flow details</span>
              <span className="shrink-0 font-mono tabular-nums text-bone">
                {mw(resolved.mwGeneration)} on-site
              </span>
            </summary>
            <div className="space-y-0.5 border-t border-line/60 px-2.5 py-2">
              <StatRow label="On-site generation" value={mw(resolved.mwGeneration)} />
              <StatRow
                label="Firm contract draw"
                value={mw(resolved.mwContractImport)}
              />
              <StatRow
                label="Spot draw"
                value={mw(bill.spotMw)}
                tone={bill.spotMw > 0 ? "warning" : "neutral"}
              />
              <StatRow
                label="Interconnect limit"
                value={mw(resolved.mwInterconnect)}
              />
              <StatRow
                label="Export"
                value={mw(balance.exportMw)}
                tone="positive"
              />
            </div>
          </HudDesktopDefaultDetails>
        </GameCard>

        <HudDesktopDefaultDetails className="group rounded-lg border border-line/70 bg-panel-2/45">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 marker:hidden">
            <span>
              <span className="hud-eyebrow block">Efficiency</span>
              <strong className="mt-0.5 block text-sm text-bone">Power → compute</strong>
            </span>
            <span className="shrink-0 font-mono text-[0.75rem] tabular-nums text-mint">
              {pf(snap.effectiveFlopsPf)}
            </span>
          </summary>
          <div className="border-t border-line/60 p-2">
            <PowerEfficiencyCard state={state} />
          </div>
        </HudDesktopDefaultDetails>

        <SegmentedTabs
          ariaLabel="Power sections"
          active={tab}
          onChange={(id) => setTab(id as PowerTab)}
          items={[
            { id: "status", label: "Status" },
            {
              id: "desk",
              label: `Utility desk (${importContracts.length + exportContracts.length})`,
            },
          ]}
        />

        <div key={tab} className="panel-swap">
          {tab === "status" ? (
            <GameCard eyebrow="Grid" title="Network pressure">
              <StatRow
                label="Industry DCs"
                value={`${scarcity.industryDcCount}/${scarcity.softCap}`}
              />
              <StatRow
                label="Grid demand / cap"
                value={`${mw(scarcity.gridDemandMw)} / ${mw(scarcity.gridCapMw)}`}
                tone={
                  scarcity.gridDemandMw > scarcity.gridCapMw
                    ? "danger"
                    : "neutral"
                }
              />
              <StatRow label="Curtailment" value={mw(balance.curtailedMw)} />
            </GameCard>
          ) : null}

          {tab === "desk" ? (
            <div className="space-y-2">
              <UtilityContractsCard state={state} />
              {cities.length === 0 ? (
                <EmptyState
                  title="No city utilities in range"
                  description="Commission a grid connector within 50 tiles of a city utility to open negotiations."
                />
              ) : (
                <ContractDesk
                  state={state}
                  setState={setState}
                  cities={cities}
                  contractMw={contractMw}
                  setContractMw={setContractMw}
                  contractTerm={contractTerm}
                  setContractTerm={setContractTerm}
                  negotiation={negotiation}
                  setNegotiation={setNegotiation}
                  gridStatus={`${scarcity.industryDcCount}/${scarcity.softCap}`}
                  gridConstrained={scarcity.gridDemandMw > scarcity.gridCapMw}
                />
              )}
            </div>
          ) : null}
        </div>
      </div>
    </PanelScaffold>
  );
}

/**
 * Active import/export contracts inside the Utility desk: summary, capacity,
 * price, remaining term, and delivery status beside the negotiation, with
 * renew/break actions.
 */
export function UtilityContractsCard({ state }: { state: SimState }) {
  const requestConfirm = useUiStore((store) => store.requestConfirm);
  const importContracts = activeCityPowerContracts(state);
  const exportContracts = activePowerExportContracts(state);
  const balance = powerBalance(state);
  const bill = powerImportBill(state, balance.gridImportMw);
  if (importContracts.length === 0 && exportContracts.length === 0) {
    return null;
  }
  const setState = (next: SimState) => useGameStore.setState({ state: next });
  const importCapMw = importContracts.reduce(
    (sum, contract) => sum + Math.max(0, contract.mw),
    0,
  );
  const exportCapMw = exportContracts.reduce(
    (sum, contract) => sum + Math.max(0, contract.mw),
    0,
  );

  const importRows = importContracts.map((contract) => {
    const deliveredMw =
      importCapMw > 1e-6
        ? (bill.contractMw * Math.max(0, contract.mw)) / importCapMw
        : 0;
    return {
      key: contract.id,
      direction: "Import" as const,
      cityName: contract.cityName,
      mwValue: contract.mw,
      price: contract.pricePerMWh,
      daysLeft: contract.daysLeft,
      daysTotal: contract.daysTotal,
      delivery:
        deliveredMw > 0.05
          ? { text: `Delivering ${mw(deliveredMw)}`, tone: "positive" as const }
          : { text: "Standby — no draw today", tone: "warning" as const },
      onRenew: () => setState(renewCityPowerContract(state, contract.id)),
      onBreak: () =>
        requestConfirm({
          title: "Break the utility contract?",
          body: `${contract.cityName} will stop supplying ${mw(contract.mw)} immediately. The remaining-term fee applies.`,
          actionLabel: "Break contract",
          tone: "danger",
          onConfirm: () =>
            setState(cancelCityPowerContract(state, contract.id)),
        }),
    };
  });
  const exportRows = exportContracts.map((contract) => {
    const deliveredMw =
      exportCapMw > 1e-6
        ? (balance.exportMw * Math.max(0, contract.mw)) / exportCapMw
        : 0;
    return {
      key: contract.id,
      direction: "Export" as const,
      cityName: contract.cityName,
      mwValue: contract.mw,
      price: contract.pricePerMWh,
      daysLeft: contract.daysLeft,
      daysTotal: contract.daysTotal,
      delivery:
        deliveredMw > 0.05
          ? { text: `Exporting ${mw(deliveredMw)}`, tone: "positive" as const }
          : { text: "Standby — no surplus today", tone: "warning" as const },
      onRenew: () => setState(renewPowerExportContract(state, contract.id)),
      onBreak: () =>
        requestConfirm({
          title: "Break the export contract?",
          body: `${contract.cityName} will release the ${mw(contract.mw)} offtake commitment. The early-exit fee applies.`,
          actionLabel: "Break contract",
          tone: "danger",
          onConfirm: () =>
            setState(cancelPowerExportContract(state, contract.id)),
        }),
    };
  });

  return (
    <GameCard
      tone="research"
      eyebrow="Utility contracts"
      title="Current city contracts"
      actions={
        <StatusChip tone="neutral">
          {importContracts.length + exportContracts.length} live
        </StatusChip>
      }
    >
      <div className="anim-stagger space-y-2">
        {[...importRows, ...exportRows].map((row) => (
          <article
            key={row.key}
            className="rounded-lg border border-line/70 bg-void/35 px-2.5 py-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                  {row.direction}
                </span>
                <strong className="min-w-0 truncate text-[0.8125rem] text-bone">
                  {row.cityName}
                </strong>
              </span>
              <StatusChip
                tone={row.direction === "Import" ? "research" : "positive"}
              >
                {row.daysLeft}d left
              </StatusChip>
            </div>
            <div className="mt-1">
              <StatRow label="Capacity" value={mw(row.mwValue)} strong />
              <StatRow label="Rate" value={`${money(row.price)}/MWh`} />
              <StatRow
                label="Term"
                value={`${row.daysLeft} of ${row.daysTotal}d remaining`}
              />
              <StatRow
                label="Delivery"
                value={row.delivery.text}
                tone={row.delivery.tone}
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <HudButton type="button" variant="ghost" className="min-h-11" onClick={row.onRenew}>
                Renew
              </HudButton>
              <HudButton type="button" variant="danger" className="min-h-11" onClick={row.onBreak}>
                Break
              </HudButton>
            </div>
          </article>
        ))}
      </div>
    </GameCard>
  );
}

type CityRows = ReturnType<typeof cityDashboard>;

function ContractDesk({
  state,
  setState,
  cities,
  contractMw,
  setContractMw,
  contractTerm,
  setContractTerm,
  negotiation,
  setNegotiation,
  gridStatus,
  gridConstrained,
}: {
  state: SimState;
  setState: (state: SimState) => void;
  cities: CityRows;
  contractMw: number;
  setContractMw: (mw: number) => void;
  contractTerm: number;
  setContractTerm: (days: number) => void;
  negotiation: NegotiationState;
  setNegotiation: Dispatch<SetStateAction<NegotiationState>>;
  gridStatus: string;
  gridConstrained: boolean;
}) {
  const conversationKey = powerNegotiationKey(negotiation.cityId, negotiation.mode);
  const conversation = useUiStore((store) => store.powerNegotiations[conversationKey] ?? EMPTY_NEGOTIATION);
  const updatePowerNegotiation = useUiStore((store) => store.updatePowerNegotiation);
  const saveConversation = (
    patch: Partial<typeof conversation>,
    append: typeof conversation.transcript = [],
  ) => updatePowerNegotiation(conversationKey, (current) => ({
    ...current,
    ...patch,
    transcript: [...current.transcript, ...append.map((line, index) => ({ ...line, day: state.day, sequence: current.transcript.length + index }))],
  }));
  const importQuote =
    negotiation.mode === "import"
      ? powerImportNegotiationQuote(
          state,
          negotiation.cityId,
          contractMw,
          contractTerm,
        )
      : null;
  const exportQuote =
    negotiation.mode === "export"
      ? powerExportNegotiationQuote(
          state,
          negotiation.cityId,
          contractMw,
          contractTerm,
        )
      : null;
  const activeQuote = importQuote ?? exportQuote;
  const selectedCity = cities.find(
    ({ city }) => city.id === negotiation.cityId,
  );
  // Only list cities that can deliver in the current mode (quote rule).
  const deskCities = cities.filter((row) =>
    negotiation.mode === "import"
      ? row.connectorAvailableMw > 0
      : row.genInZone > 0,
  );
  const selectionOutOfZone =
    selectedCity != null &&
    !deskCities.some((row) => row.city.id === selectedCity.city.id);
  const defaultOffer = Math.round(
    importQuote
      ? importQuote.askPricePerMWh * 0.94
      : exportQuote
        ? exportQuote.utilityOfferPerMWh * 1.05
        : 0,
  );
  const offerPrice = negotiation.offerPrice ?? defaultOffer;
  const sliderMin = Math.max(
    1,
    Math.floor(
      importQuote
        ? importQuote.floorPricePerMWh * 0.82
        : (exportQuote?.utilityOfferPerMWh ?? 1) * 0.9,
    ),
  );
  const sliderMax = Math.max(
    sliderMin + 1,
    Math.ceil(
      importQuote
        ? importQuote.askPricePerMWh * 1.05
        : (exportQuote?.ceilingPricePerMWh ?? 1) * 1.18,
    ),
  );
  const contactAgainDay = conversation.contactAgainDay;
  const contactLocked = state.day < contactAgainDay;
  const canNegotiate = (activeQuote?.contractMw ?? 0) >= 1 && !contactLocked;
  const selectedContractActive = negotiation.mode === "import"
    ? state.cityPowerContracts.some((contract) =>
        (conversation.contractId ? contract.id === conversation.contractId : contract.cityId === negotiation.cityId) && contract.daysLeft > 0)
    : state.powerExportContracts.some((contract) =>
        (conversation.contractId ? contract.id === conversation.contractId : contract.cityId === negotiation.cityId) && contract.daysLeft > 0);
  useEffect(() => {
    if (conversation.status !== "signed" || selectedContractActive) return;
    updatePowerNegotiation(conversationKey, (current) =>
      reopenEndedNegotiation(current, false),
    );
  }, [conversation.status, conversationKey, selectedContractActive, updatePowerNegotiation]);
  const resetNegotiation = (
    patch: Partial<Pick<NegotiationState, "cityId" | "mode">> = {},
  ) => {
    setNegotiation({
      ...negotiation,
      ...patch,
      offerPrice: undefined,
    });
    if (!patch.cityId && !patch.mode) saveConversation({ status: "idle", message: undefined, proposal: undefined });
  };
  useEffect(() => {
    if (!conversation.proposal || (conversation.status !== "countered" && conversation.status !== "agreed")) return;
    setContractMw(conversation.proposal.capacity);
    setContractTerm(conversation.proposal.termDays);
    setNegotiation((current) => ({ ...current, offerPrice: conversation.proposal?.offer }));
  }, [conversation.proposal, conversation.status, conversationKey, setContractMw, setContractTerm, setNegotiation]);

  const commitNegotiation = (price: number) => {
    const before =
      negotiation.mode === "import"
        ? state.cityPowerContracts.length
        : state.powerExportContracts.length;
    const next =
      negotiation.mode === "import"
        ? signCityPowerContract(
            state,
            negotiation.cityId,
            contractMw,
            contractTerm,
            price,
          )
        : signPowerExportContract(
            state,
            negotiation.cityId,
            contractMw,
            contractTerm,
            price,
          );
    const after =
      negotiation.mode === "import"
        ? next.cityPowerContracts.length
        : next.powerExportContracts.length;
    setState(next);
    if (after > before) {
      const activation = `Deal activated. ${mw(activeQuote?.contractMw ?? 0)} is live now at ${money(price)}/MWh.`;
      const contractId = negotiation.mode === "import"
        ? next.cityPowerContracts.find((contract) => !state.cityPowerContracts.some((existing) => existing.id === contract.id))?.id
        : next.powerExportContracts.find((contract) => !state.powerExportContracts.some((existing) => existing.id === contract.id))?.id;
      setNegotiation({ ...negotiation, offerPrice: price });
      saveConversation({ status: "signed", message: activation, contractId }, [{ side: "provider", text: activation, status: "signed" }]);
    } else {
      setNegotiation({ ...negotiation, offerPrice: price });
      saveConversation(
        { status: "declined", message: "We could not activate this contract. Check cash, generation, and connector headroom." },
        [{ side: "provider", text: "Activation failed. Check cash, generation, and connector headroom.", status: "declined" }],
      );
    }
  };

  const submitOffer = () => {
    const proposal = `${negotiation.mode === "import" ? "Buy" : "Sell"} ${contractMw} MW for ${contractTerm} days at ${money(offerPrice)}/MWh.`;
    const result = importQuote
      ? evaluatePowerImportOffer(importQuote, offerPrice)
      : exportQuote
        ? evaluatePowerExportOffer(exportQuote, offerPrice)
        : null;
    if (!result) return;
    const agreedPrice = Math.round(result.agreedPricePerMWh);
    setNegotiation({ ...negotiation, offerPrice: agreedPrice });
    if (result.accepted) {
      const agreement = `We agree at ${money(result.agreedPricePerMWh)}/MWh. Accept to activate.`;
      saveConversation(
        { status: "agreed", message: agreement, proposal: { capacity: contractMw, termDays: contractTerm, offer: agreedPrice } },
        [{ side: "player", text: proposal }, { side: "provider", text: agreement, status: "agreed" }],
      );
      return;
    }
    const failures = conversation.failures + 1;
    const locked = failures >= 3;
    const response = locked
      ? `Talks paused until day ${state.day + 30}.`
      : `Our firm counter is ${money(result.agreedPricePerMWh)}/MWh.`;
    saveConversation(
      {
        status: locked ? "declined" : "countered",
        message: response,
        failures,
        contactAgainDay: locked ? state.day + 30 : conversation.contactAgainDay,
        proposal: { capacity: contractMw, termDays: contractTerm, offer: agreedPrice },
      },
      [{ side: "player", text: proposal }, { side: "provider", text: response, status: locked ? "declined" : "countered" }],
    );
  };

  const providerCopy =
    conversation.status === "signed"
      ? "The agreement is active. Power and settlement start immediately."
      : contactLocked
        ? `Our traders are tied up — reach us again on day ${contactAgainDay}.`
        : importQuote
          ? canNegotiate
            ? `We can reserve up to ${mw(importQuote.contractMw)} from our ${mw(importQuote.surplusMw)} surplus at ${money(importQuote.askPricePerMWh)}/MWh.`
            : importQuote.surplusMw < 1
              ? `${importQuote.cityName} has no sellable surplus right now — municipal demand and existing offtake cover the plant.`
              : `No commissioned grid interconnect inside ${importQuote.cityName}'s power zone${
                  selectedCity
                    ? ` (needs one within ~${selectedCity.city.powerRadius} tiles of the city core)`
                    : ""
                }. Place one from the build tray's Power tab on the map.`
          : exportQuote
            ? canNegotiate
              ? `We can buy up to ${mw(exportQuote.contractMw)} of your surplus at ${money(exportQuote.utilityOfferPerMWh)}/MWh.`
              : `Build generation inside ${exportQuote.cityName} before offering surplus power.`
            : "Select a city utility to open a negotiation.";

  const belowSellerFloor =
    importQuote != null && offerPrice < importQuote.floorPricePerMWh;
  const aboveUtilityCeiling =
    exportQuote != null && offerPrice > exportQuote.ceilingPricePerMWh;
  // Mirrors the reservation fee charged by signCityPowerContract.
  const reservationFee = importQuote
    ? Math.floor(importQuote.contractMw * offerPrice * 24 * 2.5)
    : 0;
  const insufficientCash =
    importQuote != null && state.player.cash < reservationFee;
  const blockers: { text: string; tone: "danger" | "warning" }[] = [];
  if (!canNegotiate && !selectedContractActive) {
    blockers.push({ text: providerCopy, tone: "warning" });
  }
  if (selectedContractActive) {
    blockers.push({
      text: `Contract already active with ${activeQuote?.cityName ?? "this utility"} — renew or break it from the contract list above.`,
      tone: "warning",
    });
  }
  if (belowSellerFloor) {
    blockers.push({
      text: `Your bid is below the seller floor (${money(importQuote!.floorPricePerMWh)}/MWh) — raise it to open talks.`,
      tone: "warning",
    });
  }
  if (aboveUtilityCeiling) {
    blockers.push({
      text: `Your ask is above the utility ceiling (${money(exportQuote!.ceilingPricePerMWh)}/MWh) — lower it to open talks.`,
      tone: "warning",
    });
  }
  if (insufficientCash) {
    blockers.push({
      text: `Insufficient cash — the ${money(reservationFee)} reservation fee exceeds your balance.`,
      tone: "danger",
    });
  }
  const deskActionDisabled = blockers.length > 0;
  const deskActionReason = blockers[0]?.text;

  return (
    <GameCard
      tone="mint"
      eyebrow={`Grid ${gridStatus}${gridConstrained ? " · constrained" : ""}`}
      title="Utility desk"
      pad={false}
    >
      <NegotiationHeader
        title="Utility desk"
        subtitle="Power contract negotiation"
        status={conversation.status}
      />

      <div className="min-w-0 space-y-2 p-2.5">
        <label className="flex flex-col items-stretch gap-1 rounded-md border border-line/70 bg-void/55 px-2 py-1.5 min-[420px]:flex-row min-[420px]:items-center min-[420px]:gap-2">
          <span className="shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            Chat with
          </span>
          <HudSelect
            value={negotiation.cityId}
            onChange={(event) =>
              resetNegotiation({ cityId: event.target.value })
            }
            className="min-h-11 min-w-0 w-full flex-1 border-0 bg-transparent text-left text-[0.8125rem] font-medium text-bone outline-none min-[420px]:text-right"
            aria-label="City utility"
          >
            {deskCities.map(({ city }) => (
              <option key={city.id} value={city.id} className="bg-void">
                {city.name} Utility
              </option>
            ))}
            {selectedCity && selectionOutOfZone ? (
              <option
                value={selectedCity.city.id}
                disabled
                className="bg-void"
              >
                {selectedCity.city.name} Utility — no{" "}
                {negotiation.mode === "import"
                  ? "interconnect"
                  : "generation"}{" "}
                in zone
              </option>
            ) : null}
          </HudSelect>
        </label>

        <div className="grid grid-cols-2 gap-1" role="group" aria-label="Buy or sell power">
          <HudButton
            type="button"
            variant={negotiation.mode === "import" ? "primary" : "ghost"}
            aria-pressed={negotiation.mode === "import"}
            className="min-h-11"
            onClick={() => resetNegotiation({ mode: "import" })}
          >
            Buy power
          </HudButton>
          <HudButton
            type="button"
            variant={negotiation.mode === "export" ? "primary" : "ghost"}
            aria-pressed={negotiation.mode === "export"}
            className="min-h-11"
            onClick={() => resetNegotiation({ mode: "export" })}
          >
            Sell surplus
          </HudButton>
        </div>

        <div className="panel-scroll max-h-[min(15rem,35dvh)] space-y-2 overflow-y-auto overscroll-y-auto rounded-lg border border-line/60 bg-void/35 p-2 touch-pan-y">
          <NegotiationMessage
            side="provider"
            name={`${activeQuote?.cityName ?? selectedCity?.city.name ?? "City"} Utility`}
          >
            <span className="font-medium text-bone">
              {negotiation.mode === "import"
                ? "Firm supply offer"
                : "Surplus purchase offer"}
            </span>
            <span className="mt-0.5 block text-muted">{providerCopy}</span>
          </NegotiationMessage>

          {conversation.transcript.map((line, index) => (
            <NegotiationMessage
              key={`${index}-${line.text}`}
              side={line.side}
              name={line.side === "player" ? "You" : `${activeQuote?.cityName ?? selectedCity?.city.name ?? "City"} Utility`}
              status={line.status}
              timestamp={formatNegotiationTimestamp(line, state.day, index)}
            >
              {line.text}
            </NegotiationMessage>
          ))}
        </div>

        {conversation.status !== "signed" && conversation.status !== "agreed" ? (
          <>
            <NegotiationComposer>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                  Your offer
                </span>
                <span className="text-[0.6875rem] text-muted">
                  Drag to negotiate
                </span>
              </div>
              <div className="space-y-1.5">
                <NegotiationSlider
                  label="Capacity"
                  value={contractMw}
                  min={1}
                  max={80}
                  suffix=" MW"
                  onChange={(value) => {
                    setContractMw(value);
                    resetNegotiation();
                  }}
                />
                <NegotiationSlider
                  label="Term"
                  value={contractTerm}
                  min={30}
                  max={180}
                  step={15}
                  suffix=" days"
                  onChange={(value) => {
                    setContractTerm(value);
                    resetNegotiation();
                  }}
                />
                <NegotiationSlider
                  label={
                    negotiation.mode === "import" ? "Your bid" : "Your ask"
                  }
                  value={offerPrice}
                  min={sliderMin}
                  max={sliderMax}
                  suffix="/MWh"
                  onChange={(value) => {
                    setNegotiation({ ...negotiation, offerPrice: value });
                    saveConversation({ status: "idle", message: undefined, proposal: undefined });
                  }}
                />
              </div>
            </NegotiationComposer>

            <div className="grid grid-cols-2 gap-1 font-mono text-[0.6875rem] sm:grid-cols-4">
              <NegotiationMetric
                label="MW"
                value={mw(activeQuote?.contractMw ?? 0)}
              />
              <NegotiationMetric
                label="Offer"
                value={`${money(offerPrice)}/MWh`}
              />
              <NegotiationMetric label="Term" value={`${contractTerm}d`} />
              <NegotiationMetric
                label="Daily"
                value={money((activeQuote?.contractMw ?? 0) * offerPrice * 24)}
              />
            </div>

            <BlockerList items={blockers} />
          </>
        ) : null}

        {conversation.status === "idle" && (
          <HudButton
            type="button"
            variant="primary"
            disabled={deskActionDisabled}
            title={deskActionReason}
            className="flex w-full items-center justify-center gap-1.5"
            onClick={submitOffer}
          >
            <PaperPlaneTilt size={15} weight="fill" />
            Send proposal
          </HudButton>
        )}
        {conversation.status === "countered" && (
          <div className="space-y-2">
            <BlockerList items={blockers} />
            <div className="grid grid-cols-2 gap-2">
              <HudButton
                variant="primary"
                disabled={deskActionDisabled}
                title={deskActionReason}
                onClick={() => commitNegotiation(offerPrice)}
              >
                Accept counter
              </HudButton>
              <HudButton variant="ghost" onClick={() => resetNegotiation()}>
                Decline
              </HudButton>
            </div>
          </div>
        )}
        {conversation.status === "agreed" && (
          <div className="space-y-2">
            <BlockerList items={blockers} />
            <div className="grid grid-cols-2 gap-2">
              <HudButton
                variant="primary"
                disabled={deskActionDisabled}
                title={deskActionReason}
                onClick={() => commitNegotiation(offerPrice)}
              >
                Accept agreement
              </HudButton>
              <HudButton variant="ghost" onClick={() => resetNegotiation()}>
                Decline
              </HudButton>
            </div>
          </div>
        )}
        {conversation.status === "signed" && (
          <div className="flex items-center justify-center gap-1.5 rounded-md border border-mint/35 bg-mint/10 px-2 py-1.5 text-[0.8125rem] font-medium text-mint">
            <Handshake size={16} weight="duotone" />
            Contract active
          </div>
        )}
        {conversation.status === "declined" && (
          <HudButton
            type="button"
            variant="ghost"
            className="flex w-full items-center justify-center gap-1.5"
            onClick={() => resetNegotiation()}
          >
            <Handshake size={15} />
            Edit proposal
          </HudButton>
        )}
      </div>
    </GameCard>
  );
}

/**
 * Power-mix graphic. The SVG is hard-capped at 88px, the center overlay shows
 * only the coverage percentage, and the demand value moved to a truncated
 * caption below the chart so it can never be absolutely positioned beyond the
 * card. Below the narrow breakpoint the donut swaps for a full-width
 * horizontal capacity bar.
 */
export function PowerMixDonut({
  slices,
  coveredPct,
  demandMw,
}: {
  slices: PowerMixSlice[];
  coveredPct: number;
  demandMw: number;
}) {
  const caption = `of ${mw(demandMw)} demand`;
  return (
    <ResponsiveDonut
      slices={slices.map((slice) => ({
        id: slice.id,
        label: slice.label,
        value: slice.mw,
        color: slice.color,
      }))}
      centerLabel={pct(coveredPct)}
      caption={caption}
      ariaLabel="Power supply mix"
      valueFormatter={mw}
    />
  );
}

export function PowerEfficiencyCard({ state }: { state: SimState }) {
  const snap = computeSnapshot(state);
  const fleet = fleetStats(state);
  const localRawPf = Math.max(0, snap.rawFlopsPf - snap.remoteFlopsPf);
  const hasCompute = snap.effectiveFlopsPf > 1e-6;
  const localPfPerMw =
    snap.mwDemand > 1e-6 ? localRawPf / snap.mwDemand : 0;
  const conversionLoss = hasCompute
    ? Math.max(0, 1 - snap.effectiveFlopsPf / snap.rawFlopsPf)
    : 0;
  const pueOverhead = 1 - 1 / Math.max(1.0001, snap.pue);
  const fleetMwPerPf = fleet.flopsPf > 1e-6 ? fleet.mw / fleet.flopsPf : 0;
  const history = state.player.powerEfficiencyHistory ?? [];
  const first = history[0];
  const last = history[history.length - 1];
  const trendDelta =
    first && last && first.pfPerMw > 1e-9
      ? (last.pfPerMw - first.pfPerMw) / first.pfPerMw
      : 0;

  return (
    <GameCard eyebrow="Power → compute" title="Compute efficiency" tone="mint">
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-[0.8125rem]">
        <span className="font-mono tabular-nums text-bone">
          {mw(snap.mwDemand)}
        </span>
        <span className="text-muted">→</span>
        <span className="font-mono tabular-nums text-bone">
          {pf(snap.rawFlopsPf)} raw
        </span>
        <span className="text-muted">→</span>
        <span className="font-mono tabular-nums text-mint">
          {pf(snap.effectiveFlopsPf)} effective
        </span>
      </div>
      <div className="mt-2 space-y-2">
        <MeterBar
          label="Draw → IT power"
          value={1 - pueOverhead}
          detail={`PUE ${snap.pue.toFixed(2)} · ${pct(pueOverhead)} overhead`}
          tone={pueOverhead > 0.3 ? "warning" : "positive"}
        />
        <MeterBar
          label="Raw → effective compute"
          value={hasCompute ? 1 - conversionLoss : 0}
          detail={
            hasCompute
              ? `${pct(conversionLoss)} lost to throttling & allocation`
              : "No compute online"
          }
          tone={conversionLoss > 0.25 ? "warning" : "positive"}
        />
      </div>
      <div className="mt-2 space-y-0.5">
        <StatRow label="Local PF per MW" value={num(localPfPerMw)} strong />
        <StatRow
          label="Cloud compute"
          value={snap.remoteFlopsPf > 1e-6 ? pf(snap.remoteFlopsPf) : "—"}
          hint="Contracted PF; it has no local MW denominator."
        />
        <StatRow
          label="Combined effective"
          value={pf(snap.effectiveFlopsPf)}
          hint={`${pf(snap.localEffectiveFlopsPf)} local · ${pf(snap.remoteEffectiveFlopsPf)} cloud`}
          strong
        />
        <StatRow
          label="Fleet draw"
          value={
            fleetMwPerPf > 0 ? `${fleetMwPerPf.toFixed(3)} MW/PF` : "—"
          }
        />
      </div>
      {history.length >= 2 ? (
        <div className="mt-2 flex items-center gap-2">
          <Sparkline
            values={history.map((sample) => sample.pfPerMw)}
            days={history.map((sample) => sample.day)}
            format={(value) => num(value)}
            label="Local PF per MW"
            height={20}
            color="var(--color-mint)"
            className="h-5 w-24 shrink-0"
            ariaLabel="PF per MW trend"
          />
          <span className="text-[0.6875rem] text-muted">
            Local PF/MW {trendDelta >= 0 ? "up" : "down"} {pct(Math.abs(trendDelta), 1)}{" "}
            over {history.length}d
          </span>
        </div>
      ) : (
        <p className="mt-2 text-[0.6875rem] text-muted">
          Trend builds over the next few days.
        </p>
      )}
      <p className="mt-2 text-[0.6875rem] leading-snug text-muted">
        Local PF/MW tracks grid-backed hardware only. Cloud PF adds to the
        combined effective total without pretending it draws campus MW.
      </p>
    </GameCard>
  );
}
