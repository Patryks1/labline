import type {
  LabFinance,
  LabId,
  LabState,
  Model,
  PlayerState,
  ProductOffer,
  RivalLab,
  SimState,
  TrainingJob,
} from "../types";
import { createEmptyLabData } from "../balance/data";
import { emptyStaff } from "../balance/staff";
import { recordsFromOrder, orderedFromRecord } from "./maps";
import type {
  CompanyState,
  ModelDeployment,
  RivalStrategyState,
} from "./types";

const EMPTY_FAB = {
  phase: "idle" as const,
  daysInPhase: 0,
  daysRequired: 0,
  cashSunk: 0,
  yieldRate: 0.35,
  designPerfPerWatt: 2.2,
  chipsProduced: 0,
  failed: false,
  designFocus: "balanced" as const,
  designTechIds: [],
};

function financeWithCash(finance: LabFinance | undefined, cash: number): LabFinance {
  if (finance) return { ...finance, cash };
  return {
    cash,
    dayRevenue: 0,
    dayCogs: 0,
    dayEnergyCost: 0,
    dayWageCost: 0,
    dayChipAmort: 0,
    dayBuildingOpex: 0,
    dayMarketing: 0,
    dayLoanPayment: 0,
    dayEnergyOther: 0,
    dayChipAmortOther: 0,
    apiRevenue: 0,
    subRevenue: 0,
    enterpriseRevenue: 0,
    apiCogs: 0,
    subCogs: 0,
    dayGrossProfit: 0,
    dayNet: 0,
    dayTotalOut: 0,
    marginPerSub: 0,
    marginPerMTok: 0,
    totalShare: 0,
    valuation: Math.max(1, cash),
    lifetimeRevenue: 0,
    lifetimeNet: 0,
    lifetimeProductCogs: 0,
    peakCash: cash,
    lowestCash: cash,
    runwayDays: Infinity,
    debtOutstanding: 0,
  };
}

export function deploymentsFromModels(
  models: readonly Model[],
): Record<string, ModelDeployment> {
  const deployments: Record<string, ModelDeployment> = {};
  for (const model of models) {
    for (const artifact of model.deploymentArtifacts ?? []) {
      deployments[artifact.id] = {
        id: artifact.id,
        modelId: model.id,
        precision: artifact.precision,
        kvCachePrecision: artifact.kvCachePrecision,
        targetContextTokens: 8_192,
        targetConcurrency: 8,
        reservedPf: 0,
        regionId: "home",
        hardwarePoolIds: [],
        replicas: 1,
        status: artifact.supported ? "live" : "planned",
      };
    }
  }
  return deployments;
}

function productFromPlan(
  labId: LabId,
  plan: NonNullable<PlayerState["pricing"]["plans"]>[number],
  fallbackModelId: string | null,
): ProductOffer | null {
  const modelIds = [...(plan.modelIds ?? [])];
  const primary = modelIds[0] ?? fallbackModelId;
  if (!primary) return null;
  if (!modelIds.includes(primary)) modelIds.unshift(primary);
  return {
    id: plan.id,
    labId,
    channel: plan.pricePerMonth <= 0 ? "free_assistant" : "consumer_pro",
    name: plan.name,
    promoted: plan.enabled,
    sourcePlanId: plan.id,
    primaryModelId: primary,
    modelIds,
    targetSegments: [],
    pricing: {
      billingModel: plan.pricePerMonth <= 0 ? "free" : "subscription",
      monthlyUsd: plan.pricePerMonth,
      includedMTokPerMonth: plan.includedMTokPerMonth ?? null,
      inputUsdPerMTok: null,
      outputUsdPerMTok: null,
      overageInputUsdPerMTok: null,
      overageOutputUsdPerMTok: null,
      minimumCommitmentUsd: null,
    },
    delivery: "shared",
    capacityPriority: 0.5,
    servePrecision: plan.servePrecision ?? "bf16",
    capability: 0,
    reliability: 0,
    modalities: ["text"],
  };
}

function productsFromPricing(
  labId: LabId,
  pricing: PlayerState["pricing"] | RivalLab["pricing"],
  models: readonly Model[],
): Record<string, ProductOffer> {
  const live = models.find((model) => model.release === "released")?.id ?? models[0]?.id ?? null;
  const products: Record<string, ProductOffer> = {};
  for (const plan of pricing.plans ?? []) {
    const offer = productFromPlan(labId, plan, live);
    if (offer) products[offer.id] = offer;
  }
  for (const model of models) {
    if (!model.commerciallyOffered && model.release !== "released") continue;
    const id = `api:${model.id}`;
    if (products[id]) continue;
    products[id] = {
      id,
      labId,
      channel: "payg_api",
      name: model.name,
      promoted: model.commerciallyOffered === true,
      sourcePlanId: null,
      primaryModelId: model.id,
      modelIds: [model.id],
      targetSegments: [],
      pricing: {
        billingModel: "usage",
        monthlyUsd: null,
        includedMTokPerMonth: null,
        inputUsdPerMTok: model.apiPriceInPerMTok,
        outputUsdPerMTok: model.apiPriceOutPerMTok,
        overageInputUsdPerMTok: null,
        overageOutputUsdPerMTok: null,
        minimumCommitmentUsd: null,
      },
      delivery: "shared",
      capacityPriority: 0.68,
      servePrecision: "bf16",
      capability: model.capability,
      reliability: model.quality?.reliability ?? 50,
      modalities: model.modalities ?? ["text"],
    };
  }
  return products;
}

function jobsForPlayer(player: PlayerState): TrainingJob[] {
  if (player.trainingJobs?.length) return player.trainingJobs;
  return player.trainingJob ? [player.trainingJob] : [];
}

function jobsForRival(rival: RivalLab): TrainingJob[] {
  return rival.trainingJobs ?? [];
}

export function companyFromPlayer(state: SimState, player = state.player): CompanyState {
  const models = recordsFromOrder(player.models);
  const jobs = recordsFromOrder(jobsForPlayer(player));
  const cash = player.finance?.cash ?? player.cash;
  return {
    id: state.playerLabId,
    controller: "player",
    identity: {
      name: player.name,
      archetype: "player",
      regionId: state.map.activeRegionId,
      color: 0x48d7d1,
    },
    finance: financeWithCash(player.finance, cash),
    organisation: {
      staff: player.staff ?? emptyStaff(),
      researchLeads: player.researchLeads,
      researchPods: player.researchPods,
      wagesPerDay: player.wagesPerDay,
      talent: player.talent,
    },
    research: {
      unlocked: [...player.researchUnlocked],
      active: player.activeResearch,
      queue: [...player.researchQueue],
      programQueue: player.researchProgramQueue,
      programs: player.researchPrograms,
      trainingPrograms: player.trainingPrograms,
    },
    data: {
      inventory: player.data,
      quality: player.dataQuality,
    },
    modelsById: models.byId,
    modelOrder: models.order,
    trainingJobsById: jobs.byId,
    trainingJobOrder: jobs.order,
    deploymentsById: deploymentsFromModels(player.models),
    productsById: productsFromPricing(state.playerLabId, player.pricing, player.models),
    infrastructure: {
      allocation: { ...player.allocation },
      utilCap: player.utilCap,
      servingEfficiency: player.servingEfficiency,
      trainEfficiency: player.trainEfficiency,
      pue: player.pue,
      rackFleet: player.rackFleet,
      rackDesigns: player.rackDesigns,
      fab: player.fab,
      computeContracts: player.computeContracts,
      chips: player.chips,
      abstractFlopsPf: 0,
      abstractChipCount: 0,
    },
    ops: {
      loans: [...(player.loans ?? [])],
      capital: player.capital,
      pricing: player.pricing,
      brandTrust: player.brandTrust,
      servicePain: player.servicePain,
      speedStrain: player.speedStrain,
      apiSpeedStrain: player.apiSpeedStrain,
      subSpeedStrain: player.subSpeedStrain,
      apiSurgeLevel: player.apiSurgeLevel,
      marketShare: player.finance.totalShare,
      marketingSpendPerDay: player.marketingSpendPerDay,
      marketingRevenueMultiple: player.marketingRevenueMultiple,
      marketingChannels: player.marketingChannels,
      enterpriseContracts: player.enterpriseContracts,
      cloudCredits: player.cloudCredits,
      starterHqGrant: player.starterHqGrant,
      trainingCheckpoints: player.trainingCheckpoints,
      privateEvaluationJobs: player.privateEvaluationJobs,
      postTrainGyms: player.postTrainGyms,
      toolSkills: player.toolSkills,
      modelRouters: player.modelRouters,
      activeModelRouterId: player.activeModelRouterId,
      safetyCampaign: player.safetyCampaign,
      dataSupplierContracts: player.dataSupplierContracts,
      dataSupplierOffers: player.dataSupplierOffers,
      powerExportEnabled: player.powerExportEnabled,
      computeLeaseIncomeToday: player.computeLeaseIncomeToday,
      computeLeaseCostToday: player.computeLeaseCostToday,
      researchCashBurnToday: player.researchCashBurnToday,
      powerEfficiencyHistory: player.powerEfficiencyHistory,
      marketingOutcome: player.marketingOutcome,
    },
    strategy: {
      archetype: "player",
    },
  };
}

export function companyFromRival(_state: SimState, rival: RivalLab): CompanyState {
  const models = recordsFromOrder(rival.models);
  const jobs = recordsFromOrder(jobsForRival(rival));
  const strategy: RivalStrategyState = {
    archetype: rival.archetype,
    releaseMilestones: rival.releaseMilestones,
    rivalTrainingJob: rival.trainingJob ?? null,
    dataMTok: rival.dataMTok,
    domainMTok: rival.domainMTok,
    researchProgress: rival.researchProgress,
    researchDaysSpent: rival.researchDaysSpent,
    dayRevenue: rival.dayRevenue,
    lastDemandPf: rival.lastDemandPf,
    lastCapacityPf: rival.lastCapacityPf,
    lastUnserved: rival.lastUnserved,
    trainPreferSynthHQ: rival.trainPreferSynthHQ,
    trainAllowSynthLQ: rival.trainAllowSynthLQ,
    publicEstimate: rival.publicEstimate,
  };
  return {
    id: rival.id,
    controller: "rival",
    identity: {
      name: rival.name,
      archetype: rival.archetype,
      regionId: rival.regionId,
      color: rival.color,
    },
    finance: financeWithCash(rival.finance, rival.cash),
    organisation: {
      staff: rival.staff ?? emptyStaff(),
      researchLeads: rival.researchLeads,
      researchPods: rival.researchPods,
      wagesPerDay: rival.wagesPerDay ?? 0,
    },
    research: {
      unlocked: [...rival.researchUnlocked],
      active: rival.activeResearch,
      queue: [...(rival.researchQueue ?? [])],
      programs: rival.researchPrograms,
      trainingPrograms: rival.trainingPrograms,
    },
    data: {
      inventory: rival.data ?? createEmptyLabData(),
      quality: rival.dataQuality,
    },
    modelsById: models.byId,
    modelOrder: models.order,
    trainingJobsById: jobs.byId,
    trainingJobOrder: jobs.order,
    deploymentsById: deploymentsFromModels(rival.models),
    productsById: productsFromPricing(rival.id, rival.pricing, rival.models),
    infrastructure: {
      allocation: { ...rival.allocation },
      utilCap: rival.utilCap,
      servingEfficiency: rival.servingEfficiency,
      trainEfficiency: rival.trainEfficiency ?? 0.6,
      pue: rival.pue ?? 1.42,
      rackFleet: rival.rackFleet ?? [],
      rackDesigns: rival.rackDesigns ?? [],
      fab: rival.fab ?? EMPTY_FAB,
      computeContracts: rival.computeContracts,
      abstractFlopsPf: rival.flopsPf,
      abstractChipCount: rival.chips,
    },
    ops: {
      loans: [...(rival.loans ?? [])],
      capital: rival.capital,
      pricing: rival.pricing,
      brandTrust: rival.brandTrust,
      servicePain: rival.servicePain ?? 0,
      speedStrain: rival.speedStrain,
      marketShare: rival.marketShare,
      marketingSpendPerDay: rival.marketingSpendPerDay ?? 0,
      marketingRevenueMultiple: rival.marketingRevenueMultiple,
      marketingChannels: rival.marketingChannels,
      marketingOutcome: rival.marketingOutcome,
      enterpriseContracts: rival.enterpriseContracts ?? 0,
      computeLeaseIncomeToday: rival.computeLeaseIncomeToday,
      computeLeaseCostToday: rival.computeLeaseCostToday,
    },
    strategy,
  };
}

export function labFromCompany(company: CompanyState): LabState {
  const jobs = orderedFromRecord(company.trainingJobsById, company.trainingJobOrder);
  return {
    id: company.id,
    name: company.identity.name,
    controller: company.controller,
    archetype: company.identity.archetype,
    regionId: company.identity.regionId,
    color: company.identity.color,
    cash: company.finance.cash,
    finance: company.finance,
    loans: company.ops.loans,
    capital: company.ops.capital,
    computeContracts: company.infrastructure.computeContracts,
    allocation: company.infrastructure.allocation,
    utilCap: company.infrastructure.utilCap,
    servingEfficiency: company.infrastructure.servingEfficiency,
    trainEfficiency: company.infrastructure.trainEfficiency,
    pue: company.infrastructure.pue,
    staff: company.organisation.staff,
    researchLeads: company.organisation.researchLeads,
    researchPods: company.organisation.researchPods,
    researchPrograms: company.research.programs,
    trainingPrograms: company.research.trainingPrograms,
    dataQuality: company.data.quality,
    data: company.data.inventory,
    brandTrust: company.ops.brandTrust,
    servicePain: company.ops.servicePain,
    speedStrain: company.ops.speedStrain,
    researchUnlocked: company.research.unlocked,
    activeResearch: company.research.active,
    researchQueue: company.research.queue,
    models: orderedFromRecord(company.modelsById, company.modelOrder),
    trainingJob: jobs[0] ?? company.strategy?.rivalTrainingJob ?? null,
    pricing: company.ops.pricing,
    modelRouters: company.ops.modelRouters,
    activeModelRouterId: company.ops.activeModelRouterId,
    rackFleet: company.infrastructure.rackFleet,
    rackDesigns: company.infrastructure.rackDesigns,
    fab: company.infrastructure.fab,
    marketingSpendPerDay: company.ops.marketingSpendPerDay,
    marketingRevenueMultiple: company.ops.marketingRevenueMultiple,
    marketingChannels: company.ops.marketingChannels,
    marketingOutcome: company.ops.marketingOutcome,
    enterpriseContracts: company.ops.enterpriseContracts,
    wagesPerDay: company.organisation.wagesPerDay,
    abstractFlopsPf: company.infrastructure.abstractFlopsPf ?? 0,
    abstractChipCount: company.infrastructure.abstractChipCount ?? 0,
    marketShare: company.ops.marketShare,
    publicEstimate: company.strategy?.publicEstimate,
  };
}

export function playerFromCompany(company: CompanyState, previous: PlayerState): PlayerState {
  const jobs = orderedFromRecord(company.trainingJobsById, company.trainingJobOrder);
  return {
    ...previous,
    name: company.identity.name,
    cash: company.finance.cash,
    chips: company.infrastructure.chips ?? previous.chips,
    rackFleet: company.infrastructure.rackFleet,
    rackDesigns: company.infrastructure.rackDesigns,
    allocation: company.infrastructure.allocation,
    utilCap: company.infrastructure.utilCap,
    servingEfficiency: company.infrastructure.servingEfficiency,
    trainEfficiency: company.infrastructure.trainEfficiency,
    pue: company.infrastructure.pue,
    talent: company.organisation.talent ?? previous.talent,
    staff: company.organisation.staff,
    starterHqGrant: company.ops.starterHqGrant,
    researchLeads: company.organisation.researchLeads,
    researchPods: company.organisation.researchPods,
    researchPrograms: company.research.programs,
    trainingPrograms: company.research.trainingPrograms,
    researchCashBurnToday: company.ops.researchCashBurnToday,
    powerExportEnabled: company.ops.powerExportEnabled,
    computeLeaseIncomeToday: company.ops.computeLeaseIncomeToday,
    computeLeaseCostToday: company.ops.computeLeaseCostToday,
    computeContracts: company.infrastructure.computeContracts,
    cloudCredits: company.ops.cloudCredits,
    dataQuality: company.data.quality,
    data: company.data.inventory,
    brandTrust: company.ops.brandTrust,
    servicePain: company.ops.servicePain,
    speedStrain: company.ops.speedStrain,
    apiSpeedStrain: company.ops.apiSpeedStrain,
    subSpeedStrain: company.ops.subSpeedStrain,
    apiSurgeLevel: company.ops.apiSurgeLevel,
    researchUnlocked: company.research.unlocked,
    activeResearch:
      typeof company.research.active === "string"
        ? previous.activeResearch
        : company.research.active,
    researchQueue: company.research.queue,
    researchProgramQueue: company.research.programQueue,
    models: orderedFromRecord(company.modelsById, company.modelOrder),
    trainingCheckpoints: company.ops.trainingCheckpoints,
    privateEvaluationJobs: company.ops.privateEvaluationJobs,
    trainingJobs: jobs,
    trainingJob: jobs[0] ?? null,
    safetyCampaign: company.ops.safetyCampaign ?? null,
    postTrainGyms: company.ops.postTrainGyms,
    toolSkills: company.ops.toolSkills,
    modelRouters: company.ops.modelRouters,
    activeModelRouterId: company.ops.activeModelRouterId,
    dataSupplierContracts: company.ops.dataSupplierContracts,
    dataSupplierOffers: company.ops.dataSupplierOffers,
    pricing: company.ops.pricing,
    finance: company.finance,
    wagesPerDay: company.organisation.wagesPerDay,
    fab: company.infrastructure.fab,
    marketingSpendPerDay: company.ops.marketingSpendPerDay,
    marketingRevenueMultiple: company.ops.marketingRevenueMultiple,
    marketingChannels: company.ops.marketingChannels,
    marketingOutcome: company.ops.marketingOutcome,
    enterpriseContracts: company.ops.enterpriseContracts,
    loans: company.ops.loans,
    capital: company.ops.capital,
    powerEfficiencyHistory: company.ops.powerEfficiencyHistory,
  };
}

export function rivalFromCompany(company: CompanyState, previous: RivalLab): RivalLab {
  const jobs = orderedFromRecord(company.trainingJobsById, company.trainingJobOrder);
  return {
    ...previous,
    id: company.id,
    name: company.identity.name,
    archetype:
      company.identity.archetype === "player"
        ? previous.archetype
        : company.identity.archetype,
    cash: company.finance.cash,
    chips: company.infrastructure.abstractChipCount ?? previous.chips,
    flopsPf: company.infrastructure.abstractFlopsPf ?? previous.flopsPf,
    utilCap: company.infrastructure.utilCap,
    servingEfficiency: company.infrastructure.servingEfficiency,
    allocation: company.infrastructure.allocation,
    researchUnlocked: company.research.unlocked,
    models: orderedFromRecord(company.modelsById, company.modelOrder),
    releaseMilestones: company.strategy?.releaseMilestones,
    pricing: company.ops.pricing,
    brandTrust: company.ops.brandTrust,
    activeResearch:
      typeof company.research.active === "string" || company.research.active == null
        ? company.research.active
        : company.research.active.nodeId,
    researchProgress: company.strategy?.researchProgress ?? previous.researchProgress,
    researchDaysSpent: company.strategy?.researchDaysSpent,
    marketShare: company.ops.marketShare,
    regionId: company.identity.regionId,
    color: company.identity.color,
    dataMTok: company.strategy?.dataMTok ?? company.data.inventory.lifetimeProcessed,
    dataQuality: company.data.quality,
    domainMTok: company.strategy?.domainMTok,
    data: company.data.inventory,
    trainingJob: company.strategy?.rivalTrainingJob,
    trainingJobs: jobs,
    researchQueue: company.research.queue,
    servicePain: company.ops.servicePain,
    speedStrain: company.ops.speedStrain,
    dayRevenue: company.strategy?.dayRevenue,
    computeLeaseIncomeToday: company.ops.computeLeaseIncomeToday,
    computeLeaseCostToday: company.ops.computeLeaseCostToday,
    lastDemandPf: company.strategy?.lastDemandPf,
    lastCapacityPf: company.strategy?.lastCapacityPf,
    lastUnserved: company.strategy?.lastUnserved,
    trainPreferSynthHQ: company.strategy?.trainPreferSynthHQ,
    trainAllowSynthLQ: company.strategy?.trainAllowSynthLQ,
    staff: company.organisation.staff,
    controller: "rival",
    loans: company.ops.loans,
    finance: company.finance,
    capital: company.ops.capital,
    computeContracts: company.infrastructure.computeContracts,
    trainEfficiency: company.infrastructure.trainEfficiency,
    pue: company.infrastructure.pue,
    researchLeads: company.organisation.researchLeads,
    researchPods: company.organisation.researchPods,
    researchPrograms: company.research.programs,
    trainingPrograms: company.research.trainingPrograms,
    rackFleet: company.infrastructure.rackFleet,
    rackDesigns: company.infrastructure.rackDesigns,
    fab: company.infrastructure.fab,
    marketingSpendPerDay: company.ops.marketingSpendPerDay,
    marketingRevenueMultiple: company.ops.marketingRevenueMultiple,
    marketingChannels: company.ops.marketingChannels,
    marketingOutcome: company.ops.marketingOutcome,
    enterpriseContracts: company.ops.enterpriseContracts,
    wagesPerDay: company.organisation.wagesPerDay,
    publicEstimate: company.strategy?.publicEstimate,
  };
}

export function buildCompanies(state: SimState): Record<LabId, CompanyState> {
  const companies: Record<LabId, CompanyState> = {
    [state.playerLabId]: companyFromPlayer(state),
  };
  for (const rival of state.rivals) {
    companies[rival.id] = companyFromRival(state, rival);
  }
  return companies;
}
