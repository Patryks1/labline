import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { computeSnapshot, remoteAcceleratorRamGb } from "./compute";
import { fleetHostSnapshot } from "./hosting";
import {
  cloudProviderTargetBaselinePf,
  computeContractCashReserve,
  evaluateComputeProviderOffer,
  labContractCapacityPf,
  PROVIDER_MIN_OFFER_PERCENT,
  PROVIDER_RATE_MULTIPLIER,
  providerContractActiveForLab,
  quoteComputeContract,
  signComputeContract,
  terminateComputeContract,
  tickComputeContracts,
  tickRivalCloudPurchases,
} from "./computeContracts";
import { computeLabSnapshot } from "./labEngine";
import { tickMarket } from "./market";
import type { ComputeContract, SimState } from "../types";
import { cloudListPriceEscalation } from "../balance/cloudPricing";

function endStarterContract(state: SimState): SimState {
  const starter = state.computeContracts.find(
    (contract) => contract.status === "active",
  );
  return starter ? terminateComputeContract(state, starter.id) : state;
}

function providerAvailable(state: SimState, providerId: string): number {
  return state.worldMarkets.cloudProviders.find(
    (provider) => provider.id === providerId,
  )!.availablePf;
}

function providerCapacity(state: SimState, providerId: string) {
  return state.worldMarkets.cloudProviders.find(
    (provider) => provider.id === providerId,
  )!;
}

function listEscalation(state: SimState): number {
  const industry = state.worldMarkets.cloudProviders;
  const baseline = industry.reduce((sum, p) => sum + Math.max(0, p.baselinePf), 0);
  const committed = industry.reduce(
    (sum, p) => sum + Math.max(0, p.baselinePf - p.availablePf),
    0,
  );
  return cloudListPriceEscalation(
    state.day,
    baseline > 1e-9 ? committed / baseline : 0,
  );
}

describe("provider compute contracts", () => {
  it("snapshots provider accelerator and numerical-format capabilities", () => {
    const state = endStarterContract(createGame(799));
    const provider = state.worldMarkets.cloudProviders.find(
      (candidate) => candidate.id === "cloud-northstar",
    )!;
    const quote = quoteComputeContract(state, {
      providerId: provider.id,
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: 24,
      termDays: 30,
    });
    expect(provider.acceleratorGeneration).toBe(2);
    expect(provider.supportedTrainingFormats).toContain("fp8_hybrid");
    expect(quote.contract.acceleratorGeneration).toBe(
      provider.acceleratorGeneration,
    );
    expect(quote.contract.supportedTrainingFormats).toEqual(
      provider.supportedTrainingFormats,
    );
    expect(quote.contract.supportedTrainingFormats).not.toBe(
      provider.supportedTrainingFormats,
    );
  });

  it("allows long-running on-demand contracts beyond 180 days", () => {
    const state = endStarterContract(createGame(800));
    const quote = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: 24,
      termDays: 540,
    });
    expect(quote.contract.daysTotal).toBe(540);
    expect(quote.contract.daysLeft).toBe(540);
  });

  it("reserves finite capacity once and returns it once on termination", () => {
    let state = endStarterContract(createGame(801));
    const providerId = "cloud-northstar";
    const before = providerAvailable(state, providerId);
    const quote = quoteComputeContract(state, {
      providerId,
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: 40,
      termDays: 30,
    });
    expect(quote.canSign).toBe(true);

    state = signComputeContract(state, quote);
    expect(providerAvailable(state, providerId)).toBeCloseTo(before - 40, 8);
    expect(labContractCapacityPf(state, state.playerLabId).inboundPf).toBe(40);

    const signed = state.computeContracts.find(
      (contract) => contract.id === quote.contract.id,
    )!;
    state = signComputeContract(state, quote);
    expect(providerAvailable(state, providerId)).toBeCloseTo(before - 40, 8);

    state = terminateComputeContract(state, signed.id);
    expect(providerAvailable(state, providerId)).toBeCloseTo(before, 8);
    state = terminateComputeContract(state, signed.id);
    expect(providerAvailable(state, providerId)).toBeCloseTo(before, 8);
  });

  it("keeps emergency capacity available when the provider pool is exhausted", () => {
    let state = endStarterContract(createGame(802));
    state = {
      ...state,
      worldMarkets: {
        ...state.worldMarkets,
        cloudProviders: state.worldMarkets.cloudProviders.map((provider) =>
          provider.id === "cloud-atlas"
            ? { ...provider, availablePf: 0 }
            : provider,
        ),
      },
    };
    const quote = quoteComputeContract(state, {
      providerId: "cloud-atlas",
      buyerLabId: state.playerLabId,
      kind: "emergency",
      pf: 900,
      termDays: 7,
    });
    expect(quote.canSign).toBe(true);
    state = signComputeContract(state, quote);
    expect(providerAvailable(state, "cloud-atlas")).toBe(0);
    expect(labContractCapacityPf(state, state.playerLabId).inboundPf).toBe(900);
  });

  it("reserves colocation now but provisions it one to two quarters later", () => {
    let state = endStarterContract(createGame(8021));
    const quote = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      kind: "colocation",
      pf: 32,
      termDays: 180,
    });
    expect(quote.contract.availableDay! - state.day).toBeGreaterThanOrEqual(90);
    expect(quote.contract.availableDay! - state.day).toBeLessThanOrEqual(180);
    state = signComputeContract(state, quote);
    expect(labContractCapacityPf(state, state.playerLabId).inboundPf).toBe(0);

    const beforeDelivery = tickComputeContracts({
      ...state,
      day: quote.contract.availableDay! - 1,
      player: { ...state.player, computeLeaseCostToday: 0 },
    });
    expect(beforeDelivery.player.computeLeaseCostToday).toBe(0);
    expect(
      beforeDelivery.computeContracts.find(
        (item) => item.id === quote.contract.id,
      )?.daysLeft,
    ).toBe(180);

    const delivered = tickComputeContracts({
      ...state,
      day: quote.contract.availableDay!,
    });
    expect(
      labContractCapacityPf(delivered, delivered.playerLabId).inboundPf,
    ).toBe(32);
  });

  it("uses deterministic spot interruptions and does not bill interrupted days", () => {
    let state = endStarterContract(createGame(803));
    const quote = quoteComputeContract(state, {
      providerId: "cloud-meridian",
      buyerLabId: state.playerLabId,
      kind: "spot",
      pf: 12,
      termDays: 20,
    });
    state = signComputeContract(state, quote);
    state = {
      ...state,
      player: {
        ...state.player,
        cloudCredits: 50_000,
        computeLeaseCostToday: 0,
      },
      computeContracts: state.computeContracts.map((contract) =>
        contract.id === quote.contract.id
          ? { ...contract, interruptionRisk: 1 }
          : contract,
      ),
    };

    const first = tickComputeContracts(state);
    const second = tickComputeContracts(state);
    expect(first.computeContracts).toEqual(second.computeContracts);
    expect(first.player.cloudCredits).toBe(50_000);
    expect(first.player.computeLeaseCostToday).toBe(0);
    expect(
      first.computeContracts.find(
        (contract) => contract.id === quote.contract.id,
      )?.status,
    ).toBe("interrupted");
    expect(labContractCapacityPf(first, first.playerLabId).inboundPf).toBe(0);
    const beforeProvider = providerCapacity(state, quote.contract.providerId);
    const afterProvider = providerCapacity(first, quote.contract.providerId);
    expect(
      afterProvider.baselinePf - afterProvider.availablePf,
    ).toBeCloseTo(beforeProvider.baselinePf - beforeProvider.availablePf, 8);

    const terminated = terminateComputeContract(first, quote.contract.id);
    const terminatedAgain = terminateComputeContract(
      terminated,
      quote.contract.id,
    );
    expect(
      providerCapacity(terminated, quote.contract.providerId).availablePf,
    ).toBeCloseTo(
      providerCapacity(terminated, quote.contract.providerId).baselinePf,
      8,
    );
    expect(providerCapacity(terminatedAgain, quote.contract.providerId)).toEqual(
      providerCapacity(terminated, quote.contract.providerId),
    );
  });

  it("applies promotional credits before cash cost without creating revenue", () => {
    let state = createGame(804);
    const starter = state.computeContracts.find(
      (contract) => contract.status === "active",
    )!;
    const invoice = starter.pf * starter.pricePerPfDay;
    const revenueBefore = state.player.finance.lifetimeRevenue;
    state = {
      ...state,
      player: {
        ...state.player,
        cloudCredits: invoice - 125,
        computeLeaseCostToday: 0,
      },
    };

    const next = tickComputeContracts(state);
    expect(next.player.cloudCredits).toBe(0);
    expect(next.player.computeLeaseCostToday).toBeCloseTo(125, 8);
    expect(next.player.cash).toBe(state.player.cash);
    expect(next.player.finance.lifetimeRevenue).toBe(revenueBefore);
    expect(next.player.finance.dayRevenue).toBe(
      state.player.finance.dayRevenue,
    );
  });

  it("returns reserved capacity when the final contracted day expires", () => {
    let state = createGame(805);
    const starter = state.computeContracts.find(
      (contract) => contract.status === "active",
    )!;
    const before = providerCapacity(state, starter.providerId);
    state = {
      ...state,
      computeContracts: state.computeContracts.map((contract) =>
        contract.id === starter.id ? { ...contract, daysLeft: 1 } : contract,
      ),
    };

    const next = tickComputeContracts(state);
    expect(
      next.computeContracts.find((contract) => contract.id === starter.id)
        ?.status,
    ).toBe("expired");
    const after = providerCapacity(next, starter.providerId);
    expect(after.baselinePf).toBeGreaterThan(before.baselinePf);
    expect(after.availablePf).toBeCloseTo(after.baselinePf, 8);
  });

  it("expands provider inventory toward a campaign-day ceiling instead of a 1.5× lock", () => {
    expect(cloudProviderTargetBaselinePf(1_200, 1)).toBeGreaterThan(1_200);
    expect(cloudProviderTargetBaselinePf(1_200, 180)).toBeGreaterThan(1_200 * 8);

    let state = endStarterContract(createGame(8051));
    const providerId = "cloud-northstar";
    state = {
      ...state,
      day: 180,
      worldMarkets: {
        ...state.worldMarkets,
        cloudProviders: state.worldMarkets.cloudProviders.map((provider) =>
          provider.id === providerId
            ? {
                ...provider,
                baselinePf: 1_200,
                availablePf: 800,
                maxBaselinePf: 1_800,
                launchBaselinePf: 1_200,
              }
            : provider,
        ),
      },
    };

    const first = tickComputeContracts(state);
    const repeated = tickComputeContracts(state);
    const grown = providerCapacity(first, providerId);
    expect(grown).toEqual(providerCapacity(repeated, providerId));
    expect(grown.baselinePf).toBeGreaterThan(1_800);
    expect(grown.availablePf - 800).toBeCloseTo(grown.baselinePf - 1_200, 8);
    expect(grown.launchBaselinePf).toBe(1_200);
    expect(grown.baselinePf).toBeLessThan(cloudProviderTargetBaselinePf(1_200, 180));
  });

  it("does not return an expired contract twice while provider capacity grows", () => {
    let state = endStarterContract(createGame(8052));
    const providerId = "cloud-northstar";
    const first = quoteComputeContract(state, {
      providerId,
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: 40,
      termDays: 30,
    });
    state = signComputeContract(state, first);
    const second = quoteComputeContract(state, {
      providerId,
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: 30,
      termDays: 30,
    });
    state = signComputeContract(state, second);
    state = {
      ...state,
      computeContracts: state.computeContracts.map((contract) =>
        contract.id === first.contract.id
          ? { ...contract, daysLeft: 1 }
          : contract,
      ),
    };

    const afterExpiry = tickComputeContracts(state);
    const afterAnotherDay = tickComputeContracts(afterExpiry);
    const committedAfterExpiry =
      providerCapacity(afterExpiry, providerId).baselinePf -
      providerCapacity(afterExpiry, providerId).availablePf;
    const committedAfterAnotherDay =
      providerCapacity(afterAnotherDay, providerId).baselinePf -
      providerCapacity(afterAnotherDay, providerId).availablePf;
    expect(committedAfterExpiry).toBeCloseTo(second.contract.pf, 8);
    expect(committedAfterAnotherDay).toBeCloseTo(second.contract.pf, 8);
  });

  it("tracks inbound and outbound PF separately instead of netting them away", () => {
    const state = endStarterContract(createGame(806));
    const rivalId = state.rivals[0]!.id;
    const base: Omit<ComputeContract, "id" | "buyerLabId" | "sellerLabId"> = {
      providerId: "cloud-northstar",
      providerName: "Northstar Compute",
      kind: "rival_resale",
      regionId: "global-cloud",
      pf: 10,
      pricePerPfDay: 500,
      daysLeft: 10,
      daysTotal: 10,
      interruptionRisk: 0,
      terminationFee: 0,
      status: "active",
      signedDay: state.day,
    };
    const contracts: ComputeContract[] = [
      {
        ...base,
        id: "inbound",
        buyerLabId: state.playerLabId,
        sellerLabId: rivalId,
      },
      {
        ...base,
        id: "outbound",
        buyerLabId: rivalId,
        sellerLabId: state.playerLabId,
      },
    ];
    const capacity = labContractCapacityPf(
      { ...state, computeContracts: contracts },
      state.playerLabId,
    );
    expect(capacity).toEqual({ inboundPf: 10, outboundPf: 10, netPf: 0 });
  });

  it("moves rival resale capacity between both lab snapshots and releases it", () => {
    let state = createGame(808);
    const sellerLabId = state.rivals[0]!.id;
    const sellerBefore = computeLabSnapshot(state, sellerLabId).rawFlopsPf;
    const buyerBefore = computeLabSnapshot(state, state.playerLabId).rawFlopsPf;
    const pf = Math.max(1, Math.floor(sellerBefore * 0.2));
    const quote = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      sellerLabId,
      kind: "rival_resale",
      pf,
      termDays: 30,
    });

    expect(quote.canSign).toBe(true);
    state = signComputeContract(state, quote);
    expect(computeLabSnapshot(state, sellerLabId).rawFlopsPf).toBeCloseTo(
      sellerBefore - pf,
      8,
    );
    expect(computeLabSnapshot(state, state.playerLabId).rawFlopsPf).toBeCloseTo(
      buyerBefore + pf,
      8,
    );

    state = terminateComputeContract(state, quote.contract.id);
    expect(computeLabSnapshot(state, sellerLabId).rawFlopsPf).toBeCloseTo(
      sellerBefore,
      8,
    );
    expect(computeLabSnapshot(state, state.playerLabId).rawFlopsPf).toBeCloseTo(
      buyerBefore,
      8,
    );

    const expiryQuote = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      sellerLabId,
      kind: "rival_resale",
      pf,
      termDays: 7,
    });
    state = signComputeContract(state, expiryQuote);
    state = {
      ...state,
      computeContracts: state.computeContracts.map((contract) =>
        contract.id === expiryQuote.contract.id
          ? { ...contract, daysLeft: 1 }
          : contract,
      ),
    };
    state = tickComputeContracts(state);
    expect(
      state.computeContracts.find(
        (contract) => contract.id === expiryQuote.contract.id,
      )?.status,
    ).toBe("expired");
    expect(computeLabSnapshot(state, sellerLabId).rawFlopsPf).toBeCloseTo(
      sellerBefore,
      8,
    );
  });

  it("rejects missing sellers and stale resale quotes that overcommit one lab", () => {
    let state = createGame(809);
    const sellerLabId = state.rivals[0]!.id;
    const availablePf = computeLabSnapshot(state, sellerLabId).rawFlopsPf;
    const firstPf = Math.max(1, Math.ceil(availablePf * 0.6));
    const secondPf = Math.max(1, Math.floor(availablePf - firstPf) + 1);
    const invalidSeller = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      sellerLabId: "missing-lab",
      kind: "rival_resale",
      pf: 1,
      termDays: 30,
    });
    expect(invalidSeller.canSign).toBe(false);

    const first = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      sellerLabId,
      kind: "rival_resale",
      pf: firstPf,
      termDays: 30,
    });
    const staleSecond = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      sellerLabId,
      kind: "rival_resale",
      pf: secondPf,
      termDays: 30,
    });
    expect(first.canSign).toBe(true);
    expect(staleSecond.canSign).toBe(true);

    state = signComputeContract(state, first);
    const afterFirst = state.computeContracts.length;
    state = signComputeContract(state, staleSecond);
    expect(state.computeContracts).toHaveLength(afterFirst);
    expect(state.alerts[0]?.message).toContain("uncommitted compute");

    const freshSecond = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      sellerLabId,
      kind: "rival_resale",
      pf: secondPf,
      termDays: 30,
    });
    expect(freshSecond.canSign).toBe(false);
    expect(freshSecond.reason).toContain("uncommitted compute");
  });

  it("reconciles rival cloud invoices through cash, day finance, and lifetime net once", () => {
    let state = endStarterContract(createGame(810));
    const rivalId = state.rivals[0]!.id;
    const quote = quoteComputeContract(state, {
      providerId: "cloud-meridian",
      buyerLabId: rivalId,
      kind: "on_demand",
      pf: 5,
      termDays: 30,
    });
    expect(quote.canSign).toBe(true);
    state = signComputeContract(state, quote);

    const cashBefore = state.rivals.find((rival) => rival.id === rivalId)!.cash;
    const lifetimeNetBefore = state.rivals.find(
      (rival) => rival.id === rivalId,
    )!.finance!.lifetimeNet;
    const invoice = quote.contract.pf * quote.contract.pricePerPfDay;
    const accrued = tickComputeContracts(state);
    const accruedRival = accrued.rivals.find((rival) => rival.id === rivalId)!;
    expect(accruedRival.cash).toBeCloseTo(cashBefore - invoice, 8);
    expect(accruedRival.computeLeaseCostToday).toBeCloseTo(invoice, 8);
    expect(accruedRival.computeLeaseIncomeToday).toBe(0);

    const settled = tickMarket(accrued);
    const rival = settled.rivals.find((candidate) => candidate.id === rivalId)!;
    expect(rival.cash - cashBefore).toBeCloseTo(rival.finance!.dayNet, 5);
    expect(rival.finance!.lifetimeNet - lifetimeNetBefore).toBeCloseTo(
      rival.finance!.dayNet,
      5,
    );
    expect(rival.finance!.dayTotalOut).toBeGreaterThanOrEqual(invoice);
  });

  it("records rival resale receipts as revenue without applying cash twice", () => {
    let state = createGame(811);
    const sellerLabId = state.rivals[0]!.id;
    const sellerCapacity = computeLabSnapshot(state, sellerLabId).rawFlopsPf;
    const quote = quoteComputeContract(state, {
      providerId: "cloud-northstar",
      buyerLabId: state.playerLabId,
      sellerLabId,
      kind: "rival_resale",
      pf: Math.max(1, Math.floor(sellerCapacity * 0.1)),
      termDays: 30,
    });
    expect(quote.canSign).toBe(true);
    state = signComputeContract(state, quote);

    const sellerBefore = state.rivals.find(
      (rival) => rival.id === sellerLabId,
    )!;
    const cashBefore = sellerBefore.cash;
    const lifetimeRevenueBefore = sellerBefore.finance!.lifetimeRevenue;
    const lifetimeNetBefore = sellerBefore.finance!.lifetimeNet;
    const invoice = quote.contract.pf * quote.contract.pricePerPfDay;
    const accrued = tickComputeContracts(state);
    const accruedSeller = accrued.rivals.find(
      (rival) => rival.id === sellerLabId,
    )!;
    expect(accruedSeller.cash).toBeCloseTo(cashBefore + invoice, 8);
    expect(accruedSeller.computeLeaseIncomeToday).toBeCloseTo(invoice, 8);
    expect(accruedSeller.computeLeaseCostToday).toBe(0);

    const settled = tickMarket(accrued);
    const seller = settled.rivals.find((rival) => rival.id === sellerLabId)!;
    expect(seller.cash - cashBefore).toBeCloseTo(seller.finance!.dayNet, 5);
    expect(seller.finance!.lifetimeNet - lifetimeNetBefore).toBeCloseTo(
      seller.finance!.dayNet,
      5,
    );
    expect(seller.finance!.lifetimeRevenue - lifetimeRevenueBefore).toBeCloseTo(
      seller.finance!.dayRevenue,
      5,
    );
    expect(seller.finance!.dayRevenue).toBeGreaterThanOrEqual(invoice);
  });
});

describe("remote compute integration", () => {
  it("backfills an unused serve reservation into training with zero local racks or power", () => {
    const state = createGame(807);
    expect(state.player.rackFleet).toEqual([]);

    const cloud = computeSnapshot(state);
    const withoutCloud = computeSnapshot({ ...state, computeContracts: [] });
    expect(cloud.rawFlopsPf).toBeGreaterThanOrEqual(24);
    expect(cloud.pools.training).toBeGreaterThan(4);
    expect(cloud.pools.inference).toBe(0);
    expect(cloud.backfilledPf).toBeGreaterThan(0);
    expect(cloud.vramDerateTrain).toBe(1);
    expect(cloud.vramDerateServe).toBe(1);
    expect(cloud.systemRamDerate).toBe(1);
    expect(cloud.cpuDerate).toBe(1);
    expect(cloud.throttled).toBe(false);
    expect(cloud.chipCount).toBeGreaterThan(0);
    expect(cloud.avgTokPerSecPerChip).toBeGreaterThan(0);
    expect(withoutCloud.rawFlopsPf).toBe(0);
    expect(withoutCloud.pools.training).toBe(0);
  });

  it("adds accelerator RAM for provider contracts and bilateral offers", () => {
    const empty = {
      ...createGame(808),
      computeContracts: [],
      computeLeases: [],
    };
    const provider = createGame(808);
    const providerPf = provider.computeContracts
      .filter((contract) => contract.status === "active")
      .reduce((sum, contract) => sum + contract.pf, 0);
    expect(
      computeSnapshot(provider).vramGb - computeSnapshot(empty).vramGb,
    ).toBeCloseTo(remoteAcceleratorRamGb(providerPf), 6);

    const bilateral = {
      ...empty,
      computeLeases: [
        {
          id: "ram-offer",
          rivalId: empty.rivals[0]!.id,
          playerSells: false,
          pf: 14,
          pricePerPfDay: 100,
          daysLeft: 30,
          daysTotal: 30,
          status: "active" as const,
          from: "rival" as const,
        },
      ],
    };
    expect(computeSnapshot(bilateral).vramGb).toBeCloseTo(
      remoteAcceleratorRamGb(14),
      6,
    );
    expect(fleetHostSnapshot(bilateral).vramHave).toBeCloseTo(
      remoteAcceleratorRamGb(14),
      6,
    );
  });
});

describe("provider rate doubling", () => {
  it("doubles the quoted rate across kinds and settles invoices at the doubled price", () => {
    let state = endStarterContract(createGame(8_210));
    const provider = providerCapacity(state, "cloud-northstar");
    const base = provider.basePricePerPfDay;

    const onDemand = quoteComputeContract(state, {
      providerId: provider.id,
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: 10,
      termDays: 30,
    });
    expect(onDemand.contract.pricePerPfDay).toBeCloseTo(
      base * PROVIDER_RATE_MULTIPLIER * listEscalation(state),
      8,
    );
    expect(onDemand.dailyCost).toBeCloseTo(
      10 * base * PROVIDER_RATE_MULTIPLIER * listEscalation(state),
      8,
    );

    const reserved = quoteComputeContract(state, {
      providerId: provider.id,
      buyerLabId: state.playerLabId,
      kind: "reserved",
      pf: 10,
      termDays: 120,
    });
    expect(reserved.contract.pricePerPfDay).toBeCloseTo(
      base * PROVIDER_RATE_MULTIPLIER * 0.78 * listEscalation(state),
      8,
    );

    const colocation = quoteComputeContract(state, {
      providerId: provider.id,
      buyerLabId: state.playerLabId,
      kind: "colocation",
      pf: 10,
      termDays: 180,
    });
    expect(colocation.contract.pricePerPfDay).toBeCloseTo(
      base * PROVIDER_RATE_MULTIPLIER * 0.66 * listEscalation(state),
      8,
    );

    const spot = quoteComputeContract(state, {
      providerId: "cloud-meridian",
      buyerLabId: state.playerLabId,
      kind: "spot",
      pf: 10,
      termDays: 20,
    });
    const spotBase = providerCapacity(state, "cloud-meridian").basePricePerPfDay;
    expect(spot.contract.pricePerPfDay).toBeGreaterThanOrEqual(
      spotBase * PROVIDER_RATE_MULTIPLIER * 0.65 - 1e-9,
    );

    state = signComputeContract(state, onDemand);
    state = tickComputeContracts({
      ...state,
      player: { ...state.player, cloudCredits: 0, computeLeaseCostToday: 0 },
    });
    expect(state.player.computeLeaseCostToday).toBeCloseTo(
      onDemand.dailyCost,
      8,
    );
  });

  it("keeps the locked price on existing contracts while fresh quotes double", () => {
    const state = createGame(8_211);
    const starter = state.computeContracts.find(
      (contract) => contract.status === "active",
    )!;
    const provider = providerCapacity(state, starter.providerId);
    const fresh = quoteComputeContract(state, {
      providerId: starter.providerId,
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: starter.pf,
      termDays: 30,
    });
    expect(fresh.contract.pricePerPfDay).toBeCloseTo(
      provider.basePricePerPfDay * PROVIDER_RATE_MULTIPLIER * listEscalation(state),
      8,
    );
    expect(starter.pricePerPfDay).toBeLessThan(fresh.contract.pricePerPfDay);

    const settled = tickComputeContracts({
      ...state,
      player: { ...state.player, cloudCredits: 0, computeLeaseCostToday: 0 },
    });
    expect(settled.player.computeLeaseCostToday).toBeCloseTo(
      starter.pf * starter.pricePerPfDay,
      8,
    );
  });

  it("quotes and bills rival buyers at the doubled rate too", () => {
    let state = endStarterContract(createGame(8_212));
    const rivalId = state.rivals[0]!.id;
    const provider = providerCapacity(state, "cloud-meridian");
    const quote = quoteComputeContract(state, {
      providerId: provider.id,
      buyerLabId: rivalId,
      kind: "on_demand",
      pf: 5,
      termDays: 30,
    });
    expect(quote.contract.pricePerPfDay).toBeCloseTo(
      provider.basePricePerPfDay * PROVIDER_RATE_MULTIPLIER * listEscalation(state),
      8,
    );

    state = signComputeContract(state, quote);
    const cashBefore = state.rivals.find((rival) => rival.id === rivalId)!.cash;
    state = tickComputeContracts(state);
    const invoice = quote.dailyCost;
    expect(state.rivals.find((rival) => rival.id === rivalId)!.cash).toBeCloseTo(
      cashBefore - invoice,
      8,
    );
  });
});

describe("compute provider negotiation kernel", () => {
  const deskInputs = {
    reliability: 0.95,
    pf: 24,
    availablePf: 400,
    termDays: 90,
  };

  it("agrees at strong offers, counters close offers, and declines below the seller floor", () => {
    const agreed = evaluateComputeProviderOffer({
      ...deskInputs,
      offerPercent: 100,
    });
    expect(agreed.outcome).toBe("agreed");
    expect(agreed.belowFloor).toBe(false);

    const countered = evaluateComputeProviderOffer({
      ...deskInputs,
      offerPercent: 88,
    });
    expect(countered.outcome).toBe("countered");
    expect(countered.counter).toBeDefined();
    expect(countered.counter!.offerPercent).toBeGreaterThan(88);
    expect(countered.counter!.pf).toBeLessThanOrEqual(deskInputs.pf);
    expect(countered.counter!.termDays).toBeGreaterThanOrEqual(
      deskInputs.termDays,
    );

    const floored = evaluateComputeProviderOffer({
      ...deskInputs,
      offerPercent: PROVIDER_MIN_OFFER_PERCENT - 5,
    });
    expect(floored.outcome).toBe("declined");
    expect(floored.belowFloor).toBe(true);
    expect(floored.floorOfferPercent).toBe(PROVIDER_MIN_OFFER_PERCENT);
  });

  it("turns a negotiated agreement into a real active contract", () => {
    let state = endStarterContract(createGame(8_213));
    const provider = providerCapacity(state, "cloud-northstar");
    const quote = quoteComputeContract(state, {
      providerId: provider.id,
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: 20,
      termDays: 60,
    });
    expect(quote.canSign).toBe(true);

    const evaluation = evaluateComputeProviderOffer({
      reliability: provider.reliability,
      pf: quote.contract.pf,
      availablePf: Math.max(1, provider.availablePf),
      termDays: quote.contract.daysTotal,
      offerPercent: 100,
    });
    expect(evaluation.outcome).toBe("agreed");
    expect(
      providerContractActiveForLab(state, provider.id, state.playerLabId),
    ).toBe(false);

    state = signComputeContract(state, quote);
    const active = state.computeContracts.find(
      (contract) => contract.id === quote.contract.id,
    )!;
    expect(active.status).toBe("active");
    expect(active.pricePerPfDay).toBeCloseTo(quote.contract.pricePerPfDay, 8);
    expect(
      providerContractActiveForLab(state, provider.id, state.playerLabId),
    ).toBe(true);
    expect(labContractCapacityPf(state, state.playerLabId).inboundPf).toBe(20);
  });

  it("caps the signing cash reserve at thirty days of billing", () => {
    expect(
      computeContractCashReserve({ pf: 10, pricePerPfDay: 240, daysTotal: 90 }),
    ).toBe(10 * 240 * 30);
    expect(
      computeContractCashReserve({ pf: 10, pricePerPfDay: 240, daysTotal: 14 }),
    ).toBe(10 * 240 * 14);
  });

  it("lets rivals reserve finite provider inventory on a staggered cadence", () => {
    const base = endStarterContract(createGame(8_130));
    const before = Object.fromEntries(
      base.worldMarkets.cloudProviders.map((provider) => [
        provider.id,
        provider.availablePf,
      ]),
    );
    const purchased = Array.from({ length: 24 }, (_, offset) =>
      tickRivalCloudPurchases({ ...base, day: 3 + offset }),
    ).find((state) =>
      state.computeContracts.some(
        (contract) =>
          contract.buyerLabId !== state.playerLabId &&
          contract.status === "active" &&
          !contract.sellerLabId,
      ),
    );
    expect(purchased).toBeTruthy();
    const contract = purchased!.computeContracts.find(
      (entry) =>
        entry.buyerLabId !== purchased!.playerLabId &&
        entry.status === "active" &&
        !entry.sellerLabId,
    )!;
    expect(contract.kind).toBe("on_demand");
    expect(contract.pf).toBeGreaterThanOrEqual(8);
    expect(providerAvailable(purchased!, contract.providerId)).toBeLessThan(
      before[contract.providerId]!,
    );
    expect(
      labContractCapacityPf(purchased!, contract.buyerLabId).inboundPf,
    ).toBe(contract.pf);

    const replay = tickRivalCloudPurchases({ ...base, day: purchased!.day });
    expect(
      replay.computeContracts.map((entry) => ({
        id: entry.id,
        buyerLabId: entry.buyerLabId,
        pf: entry.pf,
      })),
    ).toEqual(
      purchased!.computeContracts.map((entry) => ({
        id: entry.id,
        buyerLabId: entry.buyerLabId,
        pf: entry.pf,
      })),
    );
  });

  it("quotes contracts larger than 1 MW when the provider has the inventory", () => {
    const state = endStarterContract(createGame(8_131));
    const provider = providerCapacity(state, "cloud-northstar");
    expect(provider.availablePf).toBeGreaterThan(1_000);
    const quote = quoteComputeContract(state, {
      providerId: provider.id,
      buyerLabId: state.playerLabId,
      kind: "on_demand",
      pf: Math.floor(provider.availablePf),
      termDays: 90,
    });
    expect(quote.canSign).toBe(true);
    expect(quote.contract.pf).toBe(Math.floor(provider.availablePf));
  });
});
