import type {
  ActiveLoan,
  Allocation,
  CapitalStack,
  ChipInventory,
  ComputeContract,
  DataSupplierContract,
  FabProject,
  LabController,
  LabData,
  LabFinance,
  LabId,
  MarketingChannels,
  Model,
  ModelRouter,
  PlayerState,
  PostTrainGym,
  PrivateEvaluationJob,
  ProductOffer,
  ProductPricing,
  RackDesign,
  RackInstall,
  ResearchLead,
  ResearchPod,
  ResearchProgram,
  ResearchProgress,
  RivalArchetype,
  RivalLab,
  RivalReleaseMilestone,
  RivalTrainJob,
  SafetyCampaign,
  ServePrecision,
  StaffHeadcount,
  ToolSkill,
  TrainingCheckpointCandidate,
  TrainingJob,
  TrainingProgram,
} from "../types";
import type { TrainingState } from "../training/types";

export type CompanyController = LabController;

export interface CompanyIdentity {
  name: string;
  archetype: RivalArchetype | "player";
  regionId: string;
  color: number;
}

export interface CompanyOrganisation {
  staff: StaffHeadcount;
  researchLeads?: ResearchLead[];
  researchPods?: ResearchPod[];
  wagesPerDay: number;
  talent?: number;
}

export interface CompanyResearch {
  unlocked: string[];
  active: ResearchProgress | string | null;
  queue: string[];
  programQueue?: string[];
  programs?: ResearchProgram[];
  trainingPrograms?: TrainingProgram[];
}

export interface CompanyData {
  inventory: LabData;
  quality: number;
}

export interface CompanyInfrastructure {
  allocation: Allocation;
  utilCap: number;
  servingEfficiency: number;
  trainEfficiency: number;
  pue: number;
  rackFleet: RackInstall[];
  rackDesigns: RackDesign[];
  fab: FabProject;
  computeContracts?: ComputeContract[];
  chips?: ChipInventory[];
  abstractFlopsPf?: number;
  abstractChipCount?: number;
}

export type DeploymentStatus = "planned" | "warming" | "live" | "degraded";

export interface ModelDeployment {
  id: string;
  modelId: string;
  precision: ServePrecision;
  kvCachePrecision: "fp16" | "bf16" | "fp8" | "int8";
  targetContextTokens: number;
  targetConcurrency: number;
  reservedPf: number;
  regionId: string;
  hardwarePoolIds: string[];
  replicas: number;
  status: DeploymentStatus;
}

export interface RivalStrategyState {
  archetype: RivalArchetype | "player";
  releaseMilestones?: RivalReleaseMilestone[];
  rivalTrainingJob?: RivalTrainJob | null;
  dataMTok?: number;
  domainMTok?: RivalLab["domainMTok"];
  researchProgress?: number;
  researchDaysSpent?: number;
  dayRevenue?: number;
  lastDemandPf?: number;
  lastCapacityPf?: number;
  lastUnserved?: number;
  trainPreferSynthHQ?: boolean;
  trainAllowSynthLQ?: boolean;
  publicEstimate?: RivalLab["publicEstimate"];
}

export interface CompanyOps {
  loans: ActiveLoan[];
  capital?: CapitalStack;
  pricing: ProductPricing;
  brandTrust: number;
  servicePain: number;
  speedStrain?: number;
  apiSpeedStrain?: number;
  subSpeedStrain?: number;
  apiSurgeLevel?: number;
  marketShare: number;
  marketingSpendPerDay: number;
  marketingRevenueMultiple?: number;
  marketingChannels?: MarketingChannels;
  enterpriseContracts: number;
  cloudCredits?: number;
  starterHqGrant?: boolean;
  trainingCheckpoints?: TrainingCheckpointCandidate[];
  privateEvaluationJobs?: PrivateEvaluationJob[];
  postTrainGyms?: PostTrainGym[];
  toolSkills?: ToolSkill[];
  modelRouters?: ModelRouter[];
  activeModelRouterId?: string | null;
  safetyCampaign?: SafetyCampaign | null;
  dataSupplierContracts?: DataSupplierContract[];
  dataSupplierOffers?: DataSupplierContract[];
  powerExportEnabled?: boolean;
  computeLeaseIncomeToday?: number;
  computeLeaseCostToday?: number;
  researchCashBurnToday?: number;
  powerEfficiencyHistory?: PlayerState["powerEfficiencyHistory"];
  marketingOutcome?: PlayerState["marketingOutcome"];
  /** V4 training slice; projected verbatim so company round-trips never drop it. */
  training?: TrainingState;
}

export interface CompanyState {
  id: LabId;
  controller: CompanyController;
  identity: CompanyIdentity;
  finance: LabFinance;
  organisation: CompanyOrganisation;
  research: CompanyResearch;
  data: CompanyData;
  modelsById: Record<string, Model>;
  modelOrder: string[];
  trainingJobsById: Record<string, TrainingJob>;
  trainingJobOrder: string[];
  deploymentsById: Record<string, ModelDeployment>;
  productsById: Record<string, ProductOffer>;
  infrastructure: CompanyInfrastructure;
  ops: CompanyOps;
  strategy?: RivalStrategyState;
}
