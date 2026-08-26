import { useEffect, useMemo, useState } from "react";
import { Handshake, PaperPlaneTilt } from "@phosphor-icons/react";
import {
  acceptComputeOffer,
  activeLeases,
  cancelComputeLease,
  openOffers,
  rejectComputeOffer,
} from "../../../sim/systems/computeMarket";
import { useGameStore } from "../../../store/gameStore";
import {
  EMPTY_NEGOTIATION,
  createEmptyNegotiation,
  formatNegotiationTimestamp,
  reopenEndedNegotiation,
  useUiStore,
} from "../../../store/uiStore";
import {
  computeMw,
  computeMwValue,
  gb,
  money,
  mwToPf,
  pct,
  pf,
  pfToMw,
  pricePerMwDayFromPf,
} from "../format";
import {
  computeContractCashReserve,
  evaluateComputeProviderOffer,
  quoteComputeContract,
  signComputeContract,
  terminateComputeContract,
} from "../../../sim/systems/computeContracts";
import { computeLabSnapshot } from "../../../sim/systems/labEngine";
import { remoteAcceleratorRamGb } from "../../../sim/systems/compute";
import { CapacitySalesCeilingCard } from "../ui/CapacitySalesCeilingCard";
import {
  NegotiationHeader,
  NegotiationComposer,
  NegotiationMessage,
  NegotiationSlider,
  type NegotiationStatus,
} from "../ui/NegotiationRoom";
import {
  EmptyState,
  HudButton,
  HudSelect,
  PanelScaffold,
  StatusChip,
} from "../ui/HudPrimitives";
import { BlockerList, GameCard, SegmentedTabs, StatRow } from "../ui/kit";
import { ResponsiveDonut } from "../ui/dataViz/ResponsiveDonut";
import { LineChart, type LineChartSeries } from "../ui/LineChart";

type ProviderEvent = {
  title: string;
  body: string;
  priceMultiplier: number;
  capacityMultiplier: number;
  riskDelta: number;
  satisfactionDelta: number;
};

const PROVIDER_EVENTS: ProviderEvent[] = [
  {
    title: "Clean capacity window",
    body: "The provider has an unusually quiet reservation window. Standard terms apply.",
    priceMultiplier: 1,
    capacityMultiplier: 1,
    riskDelta: 0,
    satisfactionDelta: 3,
  },
  {
    title: "Metering correction",
    body: "Their forecast overstated another customer. They can include 10% more compute capacity in this deal.",
    priceMultiplier: 1,
    capacityMultiplier: 1.1,
    riskDelta: 0,
    satisfactionDelta: 8,
  },
  {
    title: "Service-credit window",
    body: "A prior billing miss unlocks an 8% service credit on the negotiated rate.",
    priceMultiplier: 0.92,
    capacityMultiplier: 1,
    riskDelta: 0,
    satisfactionDelta: 6,
  },
  {
    title: "Outage watch",
    body: "Maintenance risk is elevated. The provider is flexible on price, but interruption risk rises.",
    priceMultiplier: 0.9,
    capacityMultiplier: 1,
    riskDelta: 0.05,
    satisfactionDelta: -10,
  },
];

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

function quoteProjectionSeries(
  dailyCost: number,
  termDays: number,
  interruptionRisk: number,
): { spend: LineChartSeries; risk: LineChartSeries } {
  const days = Math.max(1, Math.floor(termDays));
  const sampleDays = [...new Set([0, Math.round(days * 0.25), Math.round(days * 0.5), Math.round(days * 0.75), days])];
  return {
    spend: {
      id: "spend",
      label: "Cumulative spend",
      color: "var(--color-mint)",
      points: sampleDays.map((day) => ({ x: day, y: Math.max(0, day * dailyCost) })),
    },
    risk: {
      id: "risk",
      label: "Interruption exposure",
      color: "var(--color-amber)",
      points: sampleDays.map((day) => ({
        x: day,
        // Compute contracts roll the interruption draw once per simulation
        // day, so cumulative exposure compounds over the quoted term.
        y: 1 - Math.pow(1 - clamp(0, 0.999, interruptionRisk), day),
      })),
    },
  };
}

/** Opening package: a slice of the provider's current (sub-MW at launch) pool. */
export function defaultCloudContractPf(availablePf: number): number {
  const available = Math.max(1, Math.floor(availablePf));
  return Math.max(1, Math.min(available, Math.max(24, Math.round(available * 0.12))));
}

export function maxCloudContractPf(availablePf: number): number {
  return Math.max(1, Math.floor(availablePf));
}

function providerEvent(day: number, providerId: string): ProviderEvent {
  const hash = [...providerId].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  return PROVIDER_EVENTS[
    Math.abs(hash + Math.floor(day / 5)) % PROVIDER_EVENTS.length
  ]!;
}

type MarketTab = "negotiate" | "offers" | "leases";
type ChatLine = {
  side: "provider" | "player";
  text: string;
  status?: NegotiationStatus;
};

/**
 * Wholesale compute leases — advertise, accept rival offers, manage contracts.
 */
export function ComputeMarketPanel() {
  const state = useGameStore((s) => s.state);
  const setState = (next: typeof state) =>
    useGameStore.setState({ state: next });
  const requestConfirm = useUiStore((s) => s.requestConfirm);
  const [tab, setTab] = useState<MarketTab>("negotiate");

  const offers = openOffers(state).filter((offer) => offer.from === "rival");
  const active = activeLeases(state);

  const [cloudProviderId, setCloudProviderId] = useState(
    state.worldMarkets.cloudProviders.find(
      (provider) => provider.availablePf >= 1,
    )?.id ??
      state.worldMarkets.cloudProviders[0]?.id ??
      "",
  );
  const initialProvider = state.worldMarkets.cloudProviders.find(
    (provider) => provider.id === cloudProviderId,
  );
  const [cloudPf, setCloudPf] = useState(() =>
    defaultCloudContractPf(initialProvider?.availablePf ?? 24),
  );
  const [cloudTerm, setCloudTerm] = useState(90);
  const [offerPercent, setOfferPercent] = useState(95);
  const updateComputeNegotiation = useUiStore((store) => store.updateComputeNegotiation);
  const resetComputeNegotiations = useUiStore((store) => store.resetComputeNegotiations);
  const conversation = useUiStore((store) => store.computeNegotiations[cloudProviderId] ?? EMPTY_NEGOTIATION);
  const negotiationStatus = conversation.status;
  const negotiationMessage = conversation.message ?? "";
  const chatHistory = conversation.transcript;
  const saveConversation = (
    patch: Partial<typeof conversation>,
    append: ChatLine[] = [],
  ) => updateComputeNegotiation(cloudProviderId, (current) => ({
    ...current,
    ...patch,
    transcript: [...current.transcript, ...append.map((line, index) => ({ ...line, day: state.day, sequence: current.transcript.length + index }))],
  }));
  const continueNegotiation = () => {
    saveConversation({ status: "idle", message: undefined });
  };
  const resetDeskPackage = (availablePf: number) => {
    setCloudPf(defaultCloudContractPf(availablePf));
    setCloudTerm(90);
    setOfferPercent(95);
  };
  useEffect(() => {
    const provider = state.worldMarkets.cloudProviders.find(
      (entry) => entry.id === cloudProviderId,
    );
    resetComputeNegotiations();
    resetDeskPackage(provider?.availablePf ?? 24);
    // Intentionally mount-only: re-entering the desk starts a fresh contract.
  }, []);
  useEffect(() => {
    if (!conversation.proposal || (conversation.status !== "countered" && conversation.status !== "agreed")) return;
    setCloudPf(conversation.proposal.capacity);
    setCloudTerm(conversation.proposal.termDays);
    setOfferPercent(conversation.proposal.offer);
  }, [cloudProviderId, conversation.proposal, conversation.status]);
  const cloudQuote = useMemo(
    () =>
      quoteComputeContract(state, {
        providerId: cloudProviderId,
        buyerLabId: state.playerLabId,
        kind: "on_demand",
        pf: cloudPf,
        termDays: cloudTerm,
      }),
    [state, cloudProviderId, cloudPf, cloudTerm],
  );
  const selectedProvider = state.worldMarkets.cloudProviders.find(
    (provider) => provider.id === cloudProviderId,
  );
  const dealEvent = providerEvent(state.day, cloudProviderId);
  const offerEvaluation = evaluateComputeProviderOffer({
    reliability: selectedProvider?.reliability ?? 0.9,
    pf: cloudPf,
    availablePf: Math.max(1, selectedProvider?.availablePf ?? 1),
    termDays: cloudTerm,
    offerPercent,
    satisfactionDelta: dealEvent.satisfactionDelta,
  });
  const failedAttempts = conversation.failures;
  const contactAgainDay = conversation.contactAgainDay;
  const contactLocked = state.day < contactAgainDay;
  const negotiatedQuote = useMemo(() => {
    const bonusPf = Math.max(
      1,
      Math.floor(cloudQuote.contract.pf * dealEvent.capacityMultiplier),
    );
    const pfAvailable = selectedProvider?.availablePf ?? 0;
    const negotiatedPf = Math.min(bonusPf, Math.floor(pfAvailable));
    const pricePerPfDay =
      cloudQuote.contract.pricePerPfDay *
      (offerPercent / 100) *
      dealEvent.priceMultiplier;
    const dailyCost = negotiatedPf * pricePerPfDay;
    const terminationFee =
      cloudQuote.contract.kind === "reserved"
        ? dailyCost * cloudQuote.contract.daysTotal * 0.2
        : cloudQuote.contract.kind === "colocation"
          ? dailyCost * cloudQuote.contract.daysTotal * 0.25
          : 0;
    return {
      ...cloudQuote,
      canSign: cloudQuote.canSign && negotiatedPf >= cloudQuote.contract.pf,
      reason:
        negotiatedPf < cloudQuote.contract.pf
          ? `${selectedProvider?.name ?? "Provider"} no longer has enough capacity for this package.`
          : cloudQuote.reason,
      dailyCost,
      contract: {
        ...cloudQuote.contract,
        pf: negotiatedPf,
        pricePerPfDay,
        terminationFee,
        interruptionRisk: clamp(
          0,
          0.95,
          cloudQuote.contract.interruptionRisk + dealEvent.riskDelta,
        ),
      },
    };
  }, [cloudQuote, dealEvent, offerPercent, selectedProvider]);
  const providerContracts = state.computeContracts.filter(
    (contract) =>
      contract.buyerLabId === state.playerLabId &&
      contract.status !== "expired",
  );
  const selectedProviderContractActive = state.computeContracts.some(
    (contract) =>
      (conversation.contractId
        ? contract.id === conversation.contractId
        : contract.providerId === cloudProviderId) &&
      contract.buyerLabId === state.playerLabId &&
      contract.status !== "expired" &&
      contract.daysLeft > 0,
  );
  useEffect(() => {
    if (conversation.status !== "signed" || selectedProviderContractActive) return;
    updateComputeNegotiation(cloudProviderId, (current) =>
      reopenEndedNegotiation(current, false),
    );
  }, [cloudProviderId, conversation.status, selectedProviderContractActive, updateComputeNegotiation]);
  const capacitySnapshot = computeLabSnapshot(state, state.playerLabId);
  const providerBoughtPf = state.computeContracts
    .filter(
      (contract) =>
        contract.status === "active" &&
        contract.buyerLabId === state.playerLabId &&
        !contract.sellerLabId &&
        (contract.availableDay == null || contract.availableDay <= state.day),
    )
    .reduce((sum, contract) => sum + contract.pf, 0);
  const rivalBoughtPf =
    state.computeContracts
      .filter(
        (contract) =>
          contract.status === "active" &&
          contract.buyerLabId === state.playerLabId &&
          Boolean(contract.sellerLabId) &&
          (contract.availableDay == null || contract.availableDay <= state.day),
      )
      .reduce((sum, contract) => sum + contract.pf, 0) +
    active
      .filter((lease) => !lease.playerSells)
      .reduce((sum, lease) => sum + lease.pf, 0);

  const rentedPf = providerBoughtPf + rivalBoughtPf;
  const ownedPf = capacitySnapshot.availableLocalPf;
  const dailyRent =
    providerContracts.reduce((sum, c) => sum + c.pf * c.pricePerPfDay, 0) +
    active.reduce(
      (sum, l) => sum + (l.playerSells ? 0 : l.pf * l.pricePerPfDay),
      0,
    );
  const pricePerPfDay = rentedPf > 0 ? dailyRent / rentedPf : 0;
  const util =
    capacitySnapshot.installedLocalPf > 0
      ? Math.min(
          1,
          (capacitySnapshot.installedLocalPf -
            capacitySnapshot.availableLocalPf) /
            capacitySnapshot.installedLocalPf,
        )
      : 0;

  const cashReserve = computeContractCashReserve(negotiatedQuote.contract);
  const blockers: { text: string; tone: "danger" | "warning" }[] = [];
  if (!negotiatedQuote.canSign && negotiatedQuote.reason) {
    blockers.push({ text: negotiatedQuote.reason, tone: "warning" });
  }
  if (state.player.cash < cashReserve) {
    blockers.push({
      text: `Insufficient cash — hold ${money(cashReserve)} to cover up to 30 days of billing.`,
      tone: "danger",
    });
  }
  if (contactLocked) {
    blockers.push({
      text: `Offer expired — the vendor is unavailable until day ${contactAgainDay}.`,
      tone: "danger",
    });
  }
  if (offerEvaluation.belowFloor) {
    blockers.push({
      text: `Offer is below the seller floor (${offerEvaluation.floorOfferPercent}% of list) — raise your bid.`,
      tone: "warning",
    });
  }
  const actionDisabled = blockers.length > 0;
  const actionDisabledReason = blockers[0]?.text;

  const acceptNegotiatedTerms = () => {
    const signed = signComputeContract(state, negotiatedQuote);
    const newContract = signed.computeContracts.find(
      (contract) =>
        !state.computeContracts.some((existing) => existing.id === contract.id),
    );
    setState(signed);
    if (!newContract) {
      const failed =
        "We could not activate these terms — capacity or funds changed. Send a fresh proposal.";
      saveConversation({ status: "declined", message: failed }, [
        { side: "provider", text: failed, status: "declined" },
      ]);
      return;
    }
    const activeMsg = `Contract active. ${computeMw(pfToMw(newContract.pf))} is online.`;
    saveConversation(
      { status: "signed", message: activeMsg, contractId: newContract.id },
      [{ side: "provider", text: activeMsg, status: "signed" }],
    );
  };

  return (
    <PanelScaffold
      eyebrow="Compute"
      title="Compute market"
      description="Cloud, reserved, spot & rival compute capacity."
      mobileDescription="Buy, sell, and manage compute."
    >
      <div className="min-w-0 touch-pan-y space-y-3">
        <GameCard eyebrow="Capacity mix" title="Owned vs rented" tone="mint">
          <div className="grid min-w-0 grid-cols-1 items-center gap-3 min-[400px]:grid-cols-[auto_minmax(0,1fr)]">
            <OwnedRentedDonut owned={ownedPf} rented={rentedPf} />
            <div className="min-w-0 space-y-1.5">
              <StatRow
                label="Owned"
                value={pf(ownedPf)}
                tone="positive"
                strong
              />
              <StatRow label="Rented" value={pf(rentedPf)} tone="serve" />
              <StatRow
                label="$/MW-day"
                value={pricePerPfDay > 0 ? money(pricePerMwDayFromPf(pricePerPfDay)) : "—"}
                tone="warning"
              />
              <details className="group rounded-md border border-line/60 bg-void/30">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.75rem] text-muted marker:hidden">
                  <span>Capacity details</span>
                  <span className="shrink-0 font-mono tabular-nums text-bone">{pct(util, 0)} local util</span>
                </summary>
                <div className="space-y-0.5 border-t border-line/60 px-2.5 py-2">
                  <StatRow
                    label="Rented RAM"
                    value={gb(remoteAcceleratorRamGb(rentedPf))}
                    tone="serve"
                  />
                  <StatRow label="Local util" value={pct(util, 0)} />
                </div>
              </details>
            </div>
          </div>
        </GameCard>

        <CapacitySalesCeilingCard state={state} />

        <SegmentedTabs
          ariaLabel="Compute market views"
          active={tab}
          onChange={(id) => {
            setTab(id as MarketTab);
          }}
          items={[
            { id: "negotiate", label: "Provider desk" },
            { id: "offers", label: `Offers (${offers.length})` },
            {
              id: "leases",
              label: `Leases (${active.length + providerContracts.length})`,
            },
          ]}
        />

        <div key={tab} className="panel-swap">
          {tab === "negotiate" ? (
            <section className="overflow-hidden rounded-lg border border-mint/25 bg-panel-2/90">
              <NegotiationHeader
                title="Provider desk"
                subtitle="Live capacity negotiation"
                status={negotiationStatus}
              />

              <div className="min-w-0 space-y-2 p-2.5">
                <label className="flex flex-col items-stretch gap-1 rounded-md border border-line/70 bg-void/55 px-2 py-1.5 min-[420px]:flex-row min-[420px]:items-center min-[420px]:gap-2">
                  <span className="shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                    Chat with
                  </span>
                  <HudSelect
                    value={cloudProviderId}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      const nextProvider =
                        state.worldMarkets.cloudProviders.find(
                          (provider) => provider.id === nextId,
                        );
                      setCloudProviderId(nextId);
                      setCloudPf(defaultCloudContractPf(nextProvider?.availablePf ?? 1));
                    }}
                    className="min-h-11 min-w-0 w-full flex-1 border-0 bg-transparent text-left text-[0.8125rem] font-medium text-bone outline-none min-[420px]:text-right"
                    aria-label="Compute provider"
                  >
                    {state.worldMarkets.cloudProviders.map((provider) => (
                      <option
                        key={provider.id}
                        value={provider.id}
                        className="bg-void"
                      >
                        {provider.name} · {computeMw(pfToMw(provider.availablePf))}
                        {" open / "}
                        {computeMw(pfToMw(provider.baselinePf))} total
                      </option>
                    ))}
                  </HudSelect>
                </label>

                <div className="panel-scroll max-h-[min(15rem,35dvh)] space-y-2 overflow-y-auto overscroll-y-auto rounded-lg border border-line/60 bg-void/35 p-2 touch-pan-y">
                  <NegotiationMessage
                    side="provider"
                    name={selectedProvider?.name ?? "Provider"}
                    timestamp={`Day ${state.day} · 09:00`}
                  >
                    <span className="font-medium text-bone">
                      {dealEvent.title}
                    </span>
                    <span className="mt-0.5 block text-muted">
                      {dealEvent.body}
                    </span>
                  </NegotiationMessage>

                  {chatHistory.map((line, index) => (
                    <NegotiationMessage
                      key={index}
                      side={line.side}
                      name={
                        line.side === "player"
                          ? "You"
                          : (selectedProvider?.name ?? "Provider")
                      }
                      status={line.status}
                      timestamp={formatNegotiationTimestamp(line, state.day, index)}
                    >
                      {line.text}
                    </NegotiationMessage>
                  ))}

                  {negotiationMessage &&
                  chatHistory[chatHistory.length - 1]?.text !==
                    negotiationMessage ? (
                    <NegotiationMessage
                      side="provider"
                      name={selectedProvider?.name ?? "Provider"}
                      status={negotiationStatus}
                    >
                      {negotiationMessage}
                    </NegotiationMessage>
                  ) : null}
                </div>

                {negotiationStatus !== "signed" &&
                negotiationStatus !== "agreed" ? (
                  <>
                    <NegotiationComposer>
                      <div className="space-y-1.5">
                        <NegotiationSlider
                          label="Compute"
                          value={Number(pfToMw(cloudPf).toFixed(3))}
                          min={Number(pfToMw(1).toFixed(3))}
                          max={Number(
                            pfToMw(
                              maxCloudContractPf(selectedProvider?.availablePf ?? 1),
                            ).toFixed(3),
                          )}
                          step={Number(pfToMw(1).toFixed(3))}
                          suffix=" MW"
                          formatValue={(value) => computeMwValue(value, 3)}
                          onChange={(value) => {
                            setCloudPf(
                              Math.max(
                                1,
                                Math.min(
                                  maxCloudContractPf(selectedProvider?.availablePf ?? 1),
                                  Math.round(mwToPf(value)),
                                ),
                              ),
                            );
                            continueNegotiation();
                          }}
                        />
                        <NegotiationSlider
                          label="Term"
                          value={cloudTerm}
                          min={1}
                          max={720}
                          suffix=" days"
                          onChange={(value) => {
                            setCloudTerm(value);
                            continueNegotiation();
                          }}
                        />
                        <NegotiationSlider
                          label="Offer"
                          value={offerPercent}
                          min={70}
                          max={115}
                          suffix="% list"
                          onChange={(value) => {
                            setOfferPercent(value);
                            continueNegotiation();
                          }}
                        />
                      </div>
                    </NegotiationComposer>

                    <ComputeQuoteCard
                      providerName={selectedProvider?.name ?? "Provider"}
                      availablePf={Math.max(0, negotiatedQuote.providerAvailablePf)}
                      capacityPf={negotiatedQuote.contract.pf}
                      ramGb={remoteAcceleratorRamGb(negotiatedQuote.contract.pf)}
                      dailyCost={negotiatedQuote.dailyCost}
                      termDays={negotiatedQuote.contract.daysTotal}
                      interruptionRisk={negotiatedQuote.contract.interruptionRisk}
                    />
                    <BlockerList items={blockers} />
                  </>
                ) : null}

                {negotiationStatus === "idle" && (
                  <HudButton
                    type="button"
                    variant="primary"
                    disabled={actionDisabled}
                    title={actionDisabledReason}
                    className="flex w-full items-center justify-center gap-1.5"
                    onClick={() => {
                      const proposal = `${computeMw(pfToMw(cloudPf))} for ${cloudTerm} days at ${offerPercent}% of list.`;
                      if (offerEvaluation.outcome === "agreed") {
                        const agreement =
                          "We agree to these terms. Accept to activate the contract, or decline to keep negotiating.";
                        saveConversation(
                          { status: "agreed", message: agreement, proposal: { capacity: cloudPf, termDays: cloudTerm, offer: offerPercent } },
                          [{ side: "player", text: proposal }, { side: "provider", text: agreement, status: "agreed" }],
                        );
                        return;
                      }
                      if (offerEvaluation.outcome === "declined") {
                        const failures = failedAttempts + 1;
                        const refusal = offerEvaluation.belowFloor
                          ? `That offer is below our floor — we cannot sign under ${offerEvaluation.floorOfferPercent}% of list.`
                          : "That offer is too low. Improve the price or reduce the capacity.";
                        if (failures >= 3) {
                          const lockMsg = `We are ending talks. Contact us again on day ${state.day + 30}.`;
                          saveConversation(
                            { status: "declined", message: lockMsg, failures, contactAgainDay: state.day + 30 },
                            [{ side: "player", text: proposal }, { side: "provider", text: refusal, status: "declined" }, { side: "provider", text: lockMsg, status: "declined" }],
                          );
                        } else {
                          saveConversation(
                            { status: "idle", message: refusal, failures },
                            [{ side: "player", text: proposal }, { side: "provider", text: refusal, status: "declined" }],
                          );
                        }
                        return;
                      }
                      const counter = offerEvaluation.counter!;
                      const counterText = `We can do ${computeMw(pfToMw(counter.pf))} for ${counter.termDays} days at ${counter.offerPercent}% of list. Accept or decline.`;
                      saveConversation(
                        { status: "countered", message: counterText, proposal: { capacity: counter.pf, termDays: counter.termDays, offer: counter.offerPercent } },
                        [{ side: "player", text: proposal }, { side: "provider", text: counterText, status: "countered" }],
                      );
                    }}
                  >
                    <PaperPlaneTilt size={15} weight="fill" />
                    Send proposal
                  </HudButton>
                )}
                {negotiationStatus === "countered" && (
                  <div className="space-y-2">
                    <BlockerList items={blockers} />
                    <div className="grid grid-cols-2 gap-2">
                      <HudButton
                        variant="primary"
                        disabled={actionDisabled}
                        title={actionDisabledReason}
                        onClick={acceptNegotiatedTerms}
                      >
                        Accept counter
                      </HudButton>
                      <HudButton
                        variant="ghost"
                        onClick={() => {
                          saveConversation(
                            { status: "idle", message: undefined },
                            [{ side: "player", text: "Declining that counter. Adjusting the package." }],
                          );
                        }}
                      >
                        Decline
                      </HudButton>
                    </div>
                  </div>
                )}
                {negotiationStatus === "agreed" && (
                  <div className="space-y-2">
                    <BlockerList items={blockers} />
                    <div className="grid grid-cols-2 gap-2">
                      <HudButton
                        variant="primary"
                        disabled={actionDisabled}
                        title={actionDisabledReason}
                        onClick={acceptNegotiatedTerms}
                      >
                        Accept agreement
                      </HudButton>
                      <HudButton
                        variant="ghost"
                        onClick={() => {
                          saveConversation(
                            { status: "idle", message: undefined },
                            [{ side: "player", text: "Declining those terms. I want to revise the package." }],
                          );
                        }}
                      >
                        Decline
                      </HudButton>
                    </div>
                  </div>
                )}
                {negotiationStatus === "signed" && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-center gap-1.5 rounded-md border border-mint/35 bg-mint/10 px-2 py-1.5 text-[0.8125rem] font-medium text-mint">
                      <Handshake size={16} weight="duotone" />
                      Contract active · compute online
                    </div>
                    <HudButton
                      type="button"
                      variant="ghost"
                      className="flex w-full items-center justify-center gap-1.5"
                      title="Open a fresh negotiation with this provider while the current contract runs"
                      onClick={() => {
                        updateComputeNegotiation(cloudProviderId, () =>
                          createEmptyNegotiation(),
                        );
                        resetDeskPackage(selectedProvider?.availablePf ?? 24);
                      }}
                    >
                      <Handshake size={15} />
                      Negotiate another contract
                    </HudButton>
                  </div>
                )}
                {negotiationStatus === "declined" && (
                  <HudButton
                    type="button"
                    variant="ghost"
                    className="flex w-full items-center justify-center gap-1.5"
                    onClick={continueNegotiation}
                  >
                    <Handshake size={15} />
                    Edit proposal
                  </HudButton>
                )}
              </div>
            </section>
          ) : null}

          {tab === "offers" ? (
            offers.length === 0 ? (
              <EmptyState
                title="No open offers"
                description="Rivals send offers when they have spare compute and need cash."
              />
            ) : (
              <div className="anim-stagger space-y-2">
                {offers.map((o) => {
                  const rival = state.rivals.find((r) => r.id === o.rivalId);
                  return (
                    <GameCard
                      key={o.id}
                      tone="infer"
                      eyebrow={rival?.name ?? o.rivalId}
                      title={`${o.playerSells ? "You sell" : "You buy"} ${computeMw(pfToMw(o.pf))}`}
                      actions={
                        <StatusChip tone="serve">
                          ${pricePerMwDayFromPf(o.pricePerPfDay).toFixed(0)}/MW-day
                        </StatusChip>
                      }
                    >
                      <StatRow label="Term" value={`${o.daysTotal}d`} />
                      {o.note ? (
                        <p className="mt-1 text-[0.75rem] text-muted">
                          {o.note}
                        </p>
                      ) : null}
                      <div className="mt-2 flex gap-1.5">
                        <HudButton
                          type="button"
                          variant="primary"
                          className="min-h-11 flex-1"
                          onClick={() =>
                            setState(acceptComputeOffer(state, o.id))
                          }
                        >
                          Accept
                        </HudButton>
                        <HudButton
                          type="button"
                          variant="ghost"
                          className="min-h-11 flex-1"
                          onClick={() =>
                            setState(rejectComputeOffer(state, o.id))
                          }
                        >
                          Decline
                        </HudButton>
                      </div>
                    </GameCard>
                  );
                })}
              </div>
            )
          ) : null}

          {tab === "leases" ? (
            <div className="anim-stagger space-y-2">
              {providerContracts.map((contract) => (
                <GameCard
                  key={contract.id}
                  tone="mint"
                  eyebrow="Provider"
                  title={`${contract.providerName} · ${computeMw(pfToMw(contract.pf))}`}
                  actions={
                    <HudButton
                      type="button"
                      variant="danger"
                      onClick={() =>
                        requestConfirm({
                          title: "End this contract?",
                          body: `Terminate ${contract.providerName} ${computeMw(pfToMw(contract.pf))}. Termination fee may apply.`,
                          actionLabel: "End contract",
                          tone: "danger",
                          onConfirm: () =>
                            setState(
                              terminateComputeContract(state, contract.id),
                            ),
                        })
                      }
                    >
                      End
                    </HudButton>
                  }
                >
                  <StatRow
                    label="Daily"
                    value={money(contract.pf * contract.pricePerPfDay)}
                    tone="warning"
                  />
                  <StatRow label="Left" value={`${contract.daysLeft}d`} />
                  <StatRow
                    label="Status"
                    value={
                      contract.availableDay != null &&
                      contract.availableDay > state.day
                        ? `provisions D${contract.availableDay}`
                        : contract.status
                    }
                  />
                </GameCard>
              ))}
              {active.map((lease) => {
                const rival = state.rivals.find((r) => r.id === lease.rivalId);
                return (
                  <GameCard
                    key={lease.id}
                    tone="infer"
                    eyebrow={lease.playerSells ? "You sell" : "You buy"}
                    title={`${rival?.name ?? lease.rivalId} · ${computeMw(pfToMw(lease.pf))}`}
                    actions={
                      <HudButton
                        type="button"
                        variant="danger"
                        onClick={() =>
                          setState(cancelComputeLease(state, lease.id))
                        }
                      >
                        Cancel
                      </HudButton>
                    }
                  >
                    <StatRow
                      label="Rate"
                      value={`${money(pricePerMwDayFromPf(lease.pricePerPfDay))}/MW-day`}
                    />
                    <StatRow label="Left" value={`${lease.daysLeft}d`} />
                  </GameCard>
                );
              })}
              {providerContracts.length === 0 && active.length === 0 ? (
                <EmptyState
                  title="No live contracts"
                  description="Signed provider and rival leases appear here."
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
  </PanelScaffold>
  );
}

/**
 * Negotiated capacity readout. Every visual is derived from the current quote:
 * the bars show the inventory consumed by this package, while the projections
 * show only the signed term and quoted daily rate (never fabricated history).
 */
export function ComputeQuoteCard({
  providerName,
  availablePf,
  capacityPf,
  ramGb,
  dailyCost,
  termDays,
  interruptionRisk,
}: {
  providerName: string;
  availablePf: number;
  capacityPf: number;
  ramGb: number;
  dailyCost: number;
  termDays: number;
  interruptionRisk: number;
}) {
  const available = Math.max(0, availablePf);
  const capacity = Math.max(0, capacityPf);
  const remaining = Math.max(0, available - capacity);
  const total = Math.max(1, available);
  const projections = quoteProjectionSeries(dailyCost, termDays, interruptionRisk);
  const cumulativeCost = Math.max(0, dailyCost * Math.max(1, termDays));
  const cumulativeRisk = projections.risk.points.at(-1)?.y ?? 0;
  return (
    <section
      className="compute-quote-card space-y-2 rounded-lg border border-mint/25 bg-void/45 p-2.5"
      data-testid="compute-quote-card"
      aria-label={`${providerName} quote projection`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-mint">
            Quote snapshot
          </div>
          <p className="mt-0.5 text-[0.6875rem] text-muted">
            Current inventory and term projection for {providerName}.
          </p>
        </div>
        <div className="text-right font-mono text-[0.6875rem] text-muted">
          <div>{computeMw(pfToMw(capacity))} reserved</div>
          <div>{termDays}d term</div>
        </div>
      </div>

      <div className="space-y-1" role="img" aria-label={`${computeMw(pfToMw(capacity))} of ${computeMw(pfToMw(available))} available capacity reserved; ${computeMw(pfToMw(remaining))} remains open`}>
        <div className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted">
          <span>Provider availability</span>
          <span className="font-mono tabular-nums text-bone">
            {computeMw(pfToMw(remaining))} open / {computeMw(pfToMw(available))}
          </span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-panel-2" aria-hidden="true">
          <div className="bg-mint" style={{ width: `${Math.min(100, (capacity / total) * 100)}%` }} />
          <div className="bg-infer/45" style={{ width: `${Math.min(100, (remaining / total) * 100)}%` }} />
        </div>
        <div className="flex justify-between gap-2 font-mono text-[0.625rem] text-muted">
          <span>this quote {computeMw(pfToMw(capacity))}</span>
          <span>RAM {gb(ramGb)}</span>
        </div>
      </div>

      <details className="group rounded-md border border-line/60 bg-panel-2/45">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.6875rem] text-muted marker:hidden">
          <span>Cost &amp; interruption projection</span>
          <span className="shrink-0 font-mono tabular-nums text-bone">
            {money(cumulativeCost)} · {pct(cumulativeRisk, 1)} risk
          </span>
        </summary>
        <div className="grid gap-2 border-t border-line/60 p-2 sm:grid-cols-2">
          <div className="rounded-md border border-line/60 bg-panel-2/70 p-1.5" data-testid="compute-quote-cost-projection">
            <div className="flex items-center justify-between gap-2 text-[0.625rem] uppercase tracking-[0.12em] text-muted">
              <span>Spend projection</span>
              <span className="font-mono normal-case tracking-normal text-bone">
                {money(cumulativeCost)} total
              </span>
            </div>
            <LineChart
              series={[projections.spend]}
              height={78}
              compact
              showAxes={false}
              showPoints={false}
              area
              ariaLabel={`Projected spend reaches ${money(cumulativeCost)} by day ${termDays}`}
              formatX={(value) => `D${Math.round(value)}`}
              formatY={(value) => money(value)}
            />
          </div>
          <div className="rounded-md border border-line/60 bg-panel-2/70 p-1.5" data-testid="compute-quote-risk-projection">
            <div className="flex items-center justify-between gap-2 text-[0.625rem] uppercase tracking-[0.12em] text-muted">
              <span>Risk projection</span>
              <span className="font-mono normal-case tracking-normal text-amber">
                {pct(cumulativeRisk, 1)} cumulative
              </span>
            </div>
            <LineChart
              series={[projections.risk]}
              height={78}
              compact
              showAxes={false}
              showPoints={false}
              area
              ariaLabel={`Projected interruption exposure reaches ${pct(cumulativeRisk, 1)} by day ${termDays}`}
              formatX={(value) => `D${Math.round(value)}`}
              formatY={(value) => pct(value, 1)}
            />
          </div>
        </div>
      </details>

      <div className="grid grid-cols-2 gap-1.5 font-mono text-[0.6875rem] sm:grid-cols-4">
        <QuoteMetric label="Daily" value={money(dailyCost)} />
        <QuoteMetric label="Term" value={`${termDays}d`} />
        <QuoteMetric label="Risk" value={`${(interruptionRisk * 100).toFixed(1)}%`} />
        <QuoteMetric label="RAM" value={gb(ramGb)} />
      </div>
    </section>
  );
}

function QuoteMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line/50 bg-void/40 px-2 py-1.5">
      <div className="text-[0.625rem] uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className="mt-0.5 text-bone">{value}</div>
    </div>
  );
}

/**
 * Owned-vs-rented capacity graphic. The SVG is hard-capped at 88px, the center
 * overlay carries only the compact total, and the long electrical equivalent
 * moved to a truncated caption below the chart so it can never be absolutely
 * positioned beyond the card. Below the narrow breakpoint the donut swaps for
 * a full-width horizontal capacity bar.
 */
export function OwnedRentedDonut({
  owned,
  rented,
}: {
  owned: number;
  rented: number;
}) {
  const ariaLabel = `Owned ${pf(owned)} versus rented ${pf(rented)} compute`;
  const total = Math.max(0, owned) + Math.max(0, rented);
  const electrical = `≈ ${computeMw(pfToMw(total))} electrical`;
  return (
    <ResponsiveDonut
      slices={[
        { id: "owned", label: "Owned", value: owned, color: "var(--color-mint)" },
        { id: "rented", label: "Rented", value: rented, color: "var(--color-infer)" },
      ]}
      centerLabel={pf(total)}
      caption={electrical}
      ariaLabel={ariaLabel}
      valueFormatter={pf}
    />
  );
}
