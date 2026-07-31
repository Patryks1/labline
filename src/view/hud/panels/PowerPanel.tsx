import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Handshake, PaperPlaneTilt } from "@phosphor-icons/react";
import {
  activeCityPowerContracts,
  activePowerExportContracts,
  cancelCityPowerContract,
  cancelPowerExportContract,
  cityDashboard,
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
import { useGameStore } from "../../../store/gameStore";
import {
  EMPTY_NEGOTIATION,
  formatNegotiationTimestamp,
  powerNegotiationKey,
  reopenEndedNegotiation,
  useUiStore,
} from "../../../store/uiStore";
import { computeSnapshot } from "../../../sim/tick";
import { money, mw } from "../format";
import {
  EmptyState,
  HudButton,
  MetricTile,
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
import {
  NegotiationHeader,
  NegotiationComposer,
  NegotiationMessage,
  NegotiationMetric,
  NegotiationSlider,
} from "../ui/NegotiationRoom";

type NegotiationState = {
  mode: "import" | "export";
  cityId: string;
  offerPrice?: number;
};

type PowerTab = "status" | "contracts" | "desk";

export function PowerPanel() {
  const state = useGameStore((store) => store.state);
  const requestConfirm = useUiStore((store) => store.requestConfirm);
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
  const cities = cityDashboard(state);
  const [contractMw, setContractMw] = useState(8);
  const [contractTerm, setContractTerm] = useState(60);
  const [tab, setTab] = useState<PowerTab>("status");
  const [negotiation, setNegotiation] = useState<NegotiationState>(() => ({
    mode: "import",
    cityId: cities[0]?.city.id ?? "",
  }));

  const short = Math.max(
    0,
    balance.demandMw -
      Math.min(
        balance.demandMw,
        Math.min(balance.demandMw, balance.genMw) +
          bill.contractMw +
          bill.energyContractMw +
          bill.spotMw,
      ),
  );
  const supplyRatio =
    balance.demandMw > 0.001
      ? Math.min(1, (balance.demandMw - short) / balance.demandMw)
      : 1;

  return (
    <PanelScaffold
      eyebrow="Infrastructure"
      title="Power"
      description="Grid MW, utility contracts, and surplus export."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile
            label="Need"
            value={mw(balance.demandMw)}
            tone="warning"
          />
          <MetricTile
            label="On-site"
            value={mw(balance.genMw)}
            tone="positive"
          />
          <MetricTile
            label="Short"
            value={mw(short)}
            tone={short > 0.05 ? "danger" : "positive"}
            detail={short > 0.05 ? "Tight" : "Covered"}
          />
          <MetricTile label="Spot" value={`${money(wholesale)}/MWh`} />
        </div>

        <GameCard
          eyebrow="Supply vs demand"
          title={short > 0.05 ? "Power pressure" : "Fully powered"}
          live={short > 0.05}
          tone={short > 0.05 ? "danger" : "mint"}
          actions={
            short > 0.05 ? (
              <LiveDot className="text-danger" />
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
            <StatRow
              label="Contract import"
              value={mw(bill.contractMw + bill.energyContractMw)}
            />
            <StatRow
              label="Spot draw"
              value={mw(bill.spotMw)}
              tone={bill.spotMw > 0 ? "warning" : "neutral"}
            />
            <StatRow
              label="Export"
              value={mw(balance.exportMw)}
              tone="positive"
            />
            <StatRow
              label="Daily power cost"
              value={`${money(balance.generationCostDay + bill.totalCostDay)}/d`}
              strong
            />
          </div>
        </GameCard>

        <SegmentedTabs
          ariaLabel="Power sections"
          active={tab}
          onChange={(id) => setTab(id as PowerTab)}
          items={[
            { id: "status", label: "Status" },
            {
              id: "contracts",
              label: `Contracts (${importContracts.length + exportContracts.length})`,
            },
            { id: "desk", label: "Utility desk" },
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

          {tab === "contracts" ? (
            importContracts.length === 0 && exportContracts.length === 0 ? (
              <EmptyState
                title="No power contracts"
                description="Lock utility supply or export surplus from the desk."
                action={
                  <HudButton
                    type="button"
                    variant="primary"
                    onClick={() => setTab("desk")}
                  >
                    Open utility desk
                  </HudButton>
                }
              />
            ) : (
              <div className="anim-stagger space-y-2">
                {importContracts.map((contract) => (
                  <ContractCard
                    key={contract.id}
                    direction="Import"
                    name={contract.cityName}
                    mwValue={contract.mw}
                    price={contract.pricePerMWh}
                    days={contract.daysLeft}
                    onBreak={() =>
                      requestConfirm({
                        title: "Break the utility contract?",
                        body: `${contract.cityName} will stop supplying ${mw(contract.mw)} immediately. The remaining-term fee applies.`,
                        actionLabel: "Break contract",
                        tone: "danger",
                        onConfirm: () =>
                          setState(cancelCityPowerContract(state, contract.id)),
                      })
                    }
                  />
                ))}
                {exportContracts.map((contract) => (
                  <ContractCard
                    key={contract.id}
                    direction="Export"
                    name={contract.cityName}
                    mwValue={contract.mw}
                    price={contract.pricePerMWh}
                    days={contract.daysLeft}
                    onBreak={() =>
                      requestConfirm({
                        title: "Break the export contract?",
                        body: `${contract.cityName} will release the ${mw(contract.mw)} offtake commitment. The early-exit fee applies.`,
                        actionLabel: "Break contract",
                        tone: "danger",
                        onConfirm: () =>
                          setState(
                            cancelPowerExportContract(state, contract.id),
                          ),
                      })
                    }
                  />
                ))}
              </div>
            )
          ) : null}

          {tab === "desk" ? (
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
          ) : null}
        </div>
      </div>
    </PanelScaffold>
  );
}

function ContractCard({
  direction,
  name,
  mwValue,
  price,
  days,
  onBreak,
}: {
  direction: "Import" | "Export";
  name: string;
  mwValue: number;
  price: number;
  days: number;
  onBreak: () => void;
}) {
  return (
    <GameCard
      tone={direction === "Import" ? "research" : "mint"}
      eyebrow={direction}
      title={name}
      actions={
        <StatusChip tone={direction === "Import" ? "research" : "positive"}>
          {days}d
        </StatusChip>
      }
    >
      <StatRow label="Capacity" value={mw(mwValue)} strong />
      <StatRow label="Rate" value={`${money(price)}/MWh`} />
      <HudButton
        type="button"
        variant="danger"
        className="mt-2 w-full"
        onClick={onBreak}
      >
        Break contract
      </HudButton>
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
      : importQuote
        ? canNegotiate
          ? `We can reserve up to ${mw(importQuote.contractMw)} at ${money(importQuote.askPricePerMWh)}/MWh.`
          : `Commission a grid connector inside ${importQuote.cityName} before buying power here.`
        : exportQuote
          ? canNegotiate
            ? `We can buy up to ${mw(exportQuote.contractMw)} of your surplus at ${money(exportQuote.utilityOfferPerMWh)}/MWh.`
            : `Build generation inside ${exportQuote.cityName} before offering surplus power.`
          : "Select a city utility to open a negotiation.";

  const blockers = !canNegotiate
    ? [{ text: providerCopy, tone: "warning" as const }]
    : [];

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

      <div className="space-y-2 p-3">
        <label className="flex items-center gap-2 rounded-md border border-line/70 bg-void/55 px-2 py-1.5">
          <span className="shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            Chat with
          </span>
          <select
            value={negotiation.cityId}
            onChange={(event) =>
              resetNegotiation({ cityId: event.target.value })
            }
            className="min-w-0 flex-1 bg-transparent text-right text-[0.8125rem] font-medium text-bone outline-none"
            aria-label="City utility"
          >
            {cities.map(({ city }) => (
              <option key={city.id} value={city.id} className="bg-void">
                {city.name} Utility
              </option>
            ))}
          </select>
        </label>

        <SegmentedTabs
          ariaLabel="Buy or sell power"
          active={negotiation.mode}
          onChange={(id) =>
            resetNegotiation({ mode: id as "import" | "export" })
          }
          items={[
            { id: "import", label: "Buy power" },
            { id: "export", label: "Sell surplus" },
          ]}
        />

        <div className="space-y-2 rounded-lg border border-line/60 bg-void/35 p-2">
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

            <div className="grid grid-cols-4 gap-1 font-mono text-[0.6875rem]">
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
            disabled={!canNegotiate}
            className="flex w-full items-center justify-center gap-1.5"
            onClick={submitOffer}
          >
            <PaperPlaneTilt size={15} weight="fill" />
            Send proposal
          </HudButton>
        )}
        {conversation.status === "countered" && (
          <div className="grid grid-cols-2 gap-2">
            <HudButton
              variant="primary"
              disabled={!canNegotiate}
              onClick={() => commitNegotiation(offerPrice)}
            >
              Accept counter
            </HudButton>
            <HudButton variant="ghost" onClick={() => resetNegotiation()}>
              Decline
            </HudButton>
          </div>
        )}
        {conversation.status === "agreed" && (
          <div className="grid grid-cols-2 gap-2">
            <HudButton
              variant="primary"
              onClick={() => commitNegotiation(offerPrice)}
            >
              Accept agreement
            </HudButton>
            <HudButton variant="ghost" onClick={() => resetNegotiation()}>
              Decline
            </HudButton>
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
