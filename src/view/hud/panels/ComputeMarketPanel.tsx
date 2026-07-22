import { useMemo, useState } from "react";
import { Handshake, PaperPlaneTilt } from "@phosphor-icons/react";
import {
  acceptComputeOffer,
  activeLeases,
  cancelComputeLease,
  openOffers,
  rejectComputeOffer,
} from "../../../sim/systems/computeMarket";
import { useGameStore } from "../../../store/gameStore";
import { useUiStore } from "../../../store/uiStore";
import {
  computeMw,
  computeMwValue,
  gb,
  money,
  mwToPf,
  pct,
  pfToMw,
  pricePerMwDayFromPf,
} from "../format";
import {
  quoteComputeContract,
  signComputeContract,
  terminateComputeContract,
} from "../../../sim/systems/computeContracts";
import { computeLabSnapshot } from "../../../sim/systems/labEngine";
import { remoteAcceleratorRamGb } from "../../../sim/systems/compute";
import { CapacitySalesCeilingCard } from "../ui/CapacitySalesCeilingCard";
import {
  NegotiationHeader,
  NegotiationMessage,
  NegotiationMetric,
  NegotiationSlider,
  type NegotiationStatus,
} from "../ui/NegotiationRoom";
import {
  EmptyState,
  HudButton,
  PanelScaffold,
  StatusChip,
} from "../ui/HudPrimitives";
import { BlockerList, GameCard, SegmentedTabs, StatRow } from "../ui/kit";

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
  const [cloudPf, setCloudPf] = useState(24);
  const [cloudTerm, setCloudTerm] = useState(90);
  const [offerPercent, setOfferPercent] = useState(95);
  const [negotiationStatus, setNegotiationStatus] =
    useState<NegotiationStatus>("idle");
  const [negotiationMessage, setNegotiationMessage] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatLine[]>([]);
  const [failedAttemptsByProvider, setFailedAttemptsByProvider] = useState<
    Record<string, number>
  >({});
  const [contactAgainByProvider, setContactAgainByProvider] = useState<
    Record<string, number>
  >({});
  const clearNegotiation = () => {
    setNegotiationStatus("idle");
    setNegotiationMessage("");
    setChatHistory([]);
  };
  const continueNegotiation = () => {
    setNegotiationStatus("idle");
    setNegotiationMessage("");
  };
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
  const providerSatisfaction = clamp(
    0,
    100,
    42 +
      ((selectedProvider?.reliability ?? 0.9) - 0.88) * 100 +
      Math.min(12, cloudTerm / 30) +
      (offerPercent - 90) * 0.9 -
      (cloudPf / Math.max(1, selectedProvider?.availablePf ?? 1)) * 25 +
      dealEvent.satisfactionDelta,
  );
  const failedAttempts = failedAttemptsByProvider[cloudProviderId] ?? 0;
  const contactAgainDay = contactAgainByProvider[cloudProviderId] ?? 0;
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

  const blockers =
    !negotiatedQuote.canSign && negotiatedQuote.reason
      ? [{ text: negotiatedQuote.reason, tone: "warning" as const }]
      : [];

  return (
    <PanelScaffold
      eyebrow="Compute"
      title="Compute market"
      description="Cloud, reserved, spot & rival compute capacity."
    >
      <div className="space-y-3">
        <GameCard eyebrow="Capacity mix" title="Owned vs rented" tone="mint">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <OwnedRentedDonut owned={ownedPf} rented={rentedPf} />
            <div className="min-w-0 space-y-1.5">
              <StatRow
                label="Owned"
                value={computeMw(pfToMw(ownedPf))}
                tone="positive"
                strong
              />
              <StatRow label="Rented" value={computeMw(pfToMw(rentedPf))} tone="serve" />
              <StatRow
                label="Rented RAM"
                value={gb(remoteAcceleratorRamGb(rentedPf))}
                tone="serve"
              />
              <StatRow
                label="$/MW-day"
                value={pricePerPfDay > 0 ? money(pricePerMwDayFromPf(pricePerPfDay)) : "—"}
                tone="warning"
              />
              <StatRow label="Local util" value={pct(util, 0)} />
            </div>
          </div>
        </GameCard>

        <CapacitySalesCeilingCard state={state} />

        <SegmentedTabs
          ariaLabel="Compute market views"
          active={tab}
          onChange={(id) => {
            const nextTab = id as MarketTab;
            if (tab === "negotiate" && nextTab !== "negotiate") {
              clearNegotiation();
            }
            setTab(nextTab);
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

              <div className="space-y-2 p-2.5">
                <label className="flex items-center gap-2 rounded-md border border-line/70 bg-void/55 px-2 py-1.5">
                  <span className="shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                    Chat with
                  </span>
                  <select
                    value={cloudProviderId}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      const nextProvider =
                        state.worldMarkets.cloudProviders.find(
                          (provider) => provider.id === nextId,
                        );
                      setCloudProviderId(nextId);
                      setCloudPf((current) =>
                        Math.max(
                          1,
                          Math.min(
                            current,
                            Math.floor(nextProvider?.availablePf ?? 1),
                          ),
                        ),
                      );
                      clearNegotiation();
                    }}
                    className="min-w-0 flex-1 bg-transparent text-right text-[0.8125rem] font-medium text-bone outline-none"
                    aria-label="Compute provider"
                  >
                    {state.worldMarkets.cloudProviders.map((provider) => (
                      <option
                        key={provider.id}
                        value={provider.id}
                        className="bg-void"
                      >
                        {provider.name} · {computeMw(pfToMw(provider.availablePf))}
                        open
                      </option>
                    ))}
                  </select>
                </label>

                <div className="space-y-2 rounded-lg border border-line/60 bg-void/35 p-2">
                  <NegotiationMessage
                    side="provider"
                    name={selectedProvider?.name ?? "Provider"}
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
                    <div className="rounded-lg border border-line/70 bg-void/45 p-2">
                      <div className="space-y-1.5">
                        <NegotiationSlider
                          label="Compute"
                          value={Number(pfToMw(cloudPf).toFixed(3))}
                          min={Number(pfToMw(1).toFixed(3))}
                          max={Number(
                            pfToMw(
                              Math.max(
                                1,
                                Math.min(
                                  1000,
                                  Math.floor(selectedProvider?.availablePf ?? 1),
                                ),
                              ),
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
                                  1000,
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
                    </div>

                    <div className="grid grid-cols-5 gap-1 font-mono text-[0.6875rem]">
                      <NegotiationMetric
                        label="Capacity"
                        value={computeMw(pfToMw(negotiatedQuote.contract.pf))}
                      />
                      <NegotiationMetric
                        label="RAM"
                        value={gb(remoteAcceleratorRamGb(negotiatedQuote.contract.pf))}
                      />
                      <NegotiationMetric
                        label="Daily"
                        value={money(negotiatedQuote.dailyCost)}
                      />
                      <NegotiationMetric
                        label="Term"
                        value={`${negotiatedQuote.contract.daysTotal}d`}
                      />
                      <NegotiationMetric
                        label="Risk"
                        value={`${(negotiatedQuote.contract.interruptionRisk * 100).toFixed(1)}%`}
                      />
                    </div>
                    {contactLocked ? (
                      <BlockerList
                        items={[
                          {
                            text: `Vendor unavailable until day ${contactAgainDay}.`,
                            tone: "danger",
                          },
                        ]}
                      />
                    ) : null}
                    <BlockerList items={blockers} />
                  </>
                ) : null}

                {negotiationStatus === "idle" && (
                  <HudButton
                    type="button"
                    variant="primary"
                    disabled={!negotiatedQuote.canSign || contactLocked}
                    title={
                      !negotiatedQuote.canSign
                        ? negotiatedQuote.reason
                        : undefined
                    }
                    className="flex w-full items-center justify-center gap-1.5"
                    onClick={() => {
                      const proposal = `${computeMw(pfToMw(cloudPf))} for ${cloudTerm} days at ${offerPercent}% of list.`;
                      setChatHistory((history) => [
                        ...history,
                        { side: "player", text: proposal },
                      ]);
                      if (providerSatisfaction >= 58) {
                        const agreement =
                          "We agree to these terms. Accept to activate the contract, or decline to keep negotiating.";
                        setChatHistory((history) => [
                          ...history,
                          {
                            side: "provider",
                            text: agreement,
                            status: "agreed",
                          },
                        ]);
                        setNegotiationStatus("agreed");
                        setNegotiationMessage(agreement);
                        return;
                      }
                      if (providerSatisfaction < 30) {
                        const failures = failedAttempts + 1;
                        setFailedAttemptsByProvider((current) => ({
                          ...current,
                          [cloudProviderId]: failures,
                        }));
                        const refusal =
                          "That offer is too low. Improve the price or reduce the capacity.";
                        setChatHistory((history) => [
                          ...history,
                          {
                            side: "provider",
                            text: refusal,
                            status: "declined",
                          },
                        ]);
                        if (failures >= 3) {
                          setContactAgainByProvider((current) => ({
                            ...current,
                            [cloudProviderId]: state.day + 30,
                          }));
                          const lockMsg = `We are ending talks. Contact us again on day ${state.day + 30}.`;
                          setChatHistory((history) => [
                            ...history,
                            {
                              side: "provider",
                              text: lockMsg,
                              status: "declined",
                            },
                          ]);
                          setNegotiationStatus("declined");
                          setNegotiationMessage(lockMsg);
                        }
                        return;
                      }
                      const counter = Math.min(
                        115,
                        offerPercent +
                          Math.max(
                            2,
                            Math.ceil((58 - providerSatisfaction) / 2),
                          ),
                      );
                      const counterPf = Math.max(1, Math.floor(cloudPf * 0.9));
                      const counterTerm = Math.max(
                        30,
                        Math.min(720, cloudTerm + 30),
                      );
                      setOfferPercent(counter);
                      setCloudPf(counterPf);
                      setCloudTerm(counterTerm);
                      const counterText = `We can do ${computeMw(pfToMw(counterPf))} for ${counterTerm} days at ${counter}% of list. Accept or decline.`;
                      setChatHistory((history) => [
                        ...history,
                        {
                          side: "provider",
                          text: counterText,
                          status: "countered",
                        },
                      ]);
                      setNegotiationStatus("countered");
                      setNegotiationMessage(counterText);
                    }}
                  >
                    <PaperPlaneTilt size={15} weight="fill" />
                    Send proposal
                  </HudButton>
                )}
                {negotiationStatus === "countered" && (
                  <div className="grid grid-cols-2 gap-2">
                    <HudButton
                      variant="primary"
                      disabled={!negotiatedQuote.canSign || contactLocked}
                      title={
                        !negotiatedQuote.canSign
                          ? negotiatedQuote.reason
                          : undefined
                      }
                      onClick={() => {
                        const signed = signComputeContract(
                          state,
                          negotiatedQuote,
                        );
                        setState(signed);
                        const activeMsg = `Contract active. ${computeMw(pfToMw(negotiatedQuote.contract.pf))} is online.`;
                        setChatHistory([]);
                        setNegotiationStatus("signed");
                        setNegotiationMessage(activeMsg);
                      }}
                    >
                      Accept counter
                    </HudButton>
                    <HudButton
                      variant="ghost"
                      onClick={() => {
                        setChatHistory((history) => [
                          ...history,
                          {
                            side: "player",
                            text: "Declining that counter. Adjusting the package.",
                          },
                        ]);
                        setNegotiationStatus("idle");
                        setNegotiationMessage("");
                      }}
                    >
                      Decline
                    </HudButton>
                  </div>
                )}
                {negotiationStatus === "agreed" && (
                  <div className="grid grid-cols-2 gap-2">
                    <HudButton
                      variant="primary"
                      onClick={() => {
                        const signed = signComputeContract(
                          state,
                          negotiatedQuote,
                        );
                        setState(signed);
                        const activeMsg = `Contract active. ${computeMw(pfToMw(negotiatedQuote.contract.pf))} is online.`;
                        setChatHistory([]);
                        setNegotiationStatus("signed");
                        setNegotiationMessage(activeMsg);
                      }}
                    >
                      Accept agreement
                    </HudButton>
                    <HudButton
                      variant="ghost"
                      onClick={() => {
                        setChatHistory((history) => [
                          ...history,
                          {
                            side: "player",
                            text: "Declining those terms. I want to revise the package.",
                          },
                        ]);
                        setNegotiationStatus("idle");
                        setNegotiationMessage("");
                      }}
                    >
                      Decline
                    </HudButton>
                  </div>
                )}
                {negotiationStatus === "signed" && (
                  <div className="flex items-center justify-center gap-1.5 rounded-md border border-mint/35 bg-mint/10 px-2 py-1.5 text-[0.8125rem] font-medium text-mint">
                    <Handshake size={16} weight="duotone" />
                    Contract active · compute online
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
                          onClick={() =>
                            setState(acceptComputeOffer(state, o.id))
                          }
                        >
                          Accept
                        </HudButton>
                        <HudButton
                          type="button"
                          variant="ghost"
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

function OwnedRentedDonut({
  owned,
  rented,
}: {
  owned: number;
  rented: number;
}) {
  const total = Math.max(0, owned) + Math.max(0, rented);
  const ownedPct = total > 0 ? owned / total : 1;
  const rentedPct = total > 0 ? rented / total : 0;
  const r = 34;
  const c = 2 * Math.PI * r;
  const ownedLen = c * ownedPct;
  const rentedLen = c * rentedPct;
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg
        viewBox="0 0 88 88"
        className="h-24 w-24"
        role="img"
        aria-label="Owned versus rented compute"
      >
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke="rgba(139,171,181,.22)"
          strokeWidth="10"
        />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke="#56e1dc"
          strokeWidth="10"
          strokeDasharray={`${ownedLen} ${c - ownedLen}`}
          strokeDashoffset={c * 0.25}
          strokeLinecap="butt"
        />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke="#7aa2ff"
          strokeWidth="10"
          strokeDasharray={`${rentedLen} ${c - rentedLen}`}
          strokeDashoffset={c * 0.25 - ownedLen}
          strokeLinecap="butt"
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <strong className="font-mono text-sm font-semibold tabular-nums text-bone">
          {computeMw(pfToMw(total))}
        </strong>
        <span className="text-[0.625rem] uppercase tracking-[0.12em] text-muted">
          total
        </span>
      </div>
    </div>
  );
}
