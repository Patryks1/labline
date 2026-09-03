import {
  autoAssignedGymStaffing,
  defaultPostTrainGyms,
  defaultToolSkills,
  ensureModelStudio,
  gymPackageById,
  GYM_PACKAGES,
  gymUnlocked,
  POST_TRAIN_GYM_KINDS,
  normalizeModelRouters,
  normalizePostTrainGyms,
  normalizeToolSkills,
  packageTotalCash,
  routerUnlocked,
  toolPackageById,
  toolPackageUnlocked,
  toolProficiencyFromInvestment,
  toolSkillUnlocked,
  type StudioSpendPackage,
} from "../balance/modelStudio";
import { createRng, hashSeed } from "../rng";
import type {
  ModelRouter,
  ModelRouterLane,
  PostTrainGymKind,
  SimState,
  ToolSkillId,
} from "../types";
import { chargeExpense } from "./financeLedger";
import { dataResearchReservationShare, grossResearchPoolPf } from "./data";
import { availableHqStaff } from "./staffReservations";

function withAlert(
  state: SimState,
  severity: "info" | "warn" | "danger",
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: `studio-${severity}-${state.day}-${message.slice(0, 20)}`,
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

function withStudioPlayer(state: SimState): SimState {
  return {
    ...state,
    player: ensureModelStudio(state.player),
  };
}

function autoAssignUnlockedGyms(state: SimState): SimState {
  const studio = withStudioPlayer(state)
  const unlockedKinds = new Set(
    POST_TRAIN_GYM_KINDS.filter((kind) =>
      gymUnlocked(kind, studio.player.researchUnlocked),
    ),
  )
  const available = availableHqStaff(studio, { exceptAllGyms: true })
  const dataShare = dataResearchReservationShare(studio.player.data)
  const safetyShare = studio.player.safetyCampaign ? 0.4 : 0
  const gyms = autoAssignedGymStaffing({
    gyms: studio.player.postTrainGyms,
    unlockedKinds,
    availableResearchers: available.researchers,
    availableEngineers: available.engineers,
    availableDataStaff: available.dataStaff,
    researchShareBudget: Math.max(0, 0.85 - dataShare - safetyShare),
  })
  return {
    ...studio,
    player: { ...studio.player, postTrainGyms: gyms },
  }
}

function affordOrWarn(
  state: SimState,
  pack: StudioSpendPackage,
  label: string,
): SimState | null {
  const total = packageTotalCash(pack);
  if (state.player.cash + 1e-9 < total) {
    return withAlert(
      state,
      "warn",
      `Need $${total.toLocaleString("en-US")} to fund ${label}.`,
    );
  }
  return null;
}

export function investPostTrainGym(
  state: SimState,
  kind: PostTrainGymKind,
  packageId: string,
): SimState {
  const studio = autoAssignUnlockedGyms(withStudioPlayer(state));
  if (!gymUnlocked(kind, studio.player.researchUnlocked)) {
    return withAlert(
      studio,
      "warn",
      `Research the ${kind} lab before funding it.`,
    );
  }
  const pack = gymPackageById(packageId);
  if (!pack) return withAlert(studio, "warn", "Unknown gym package.");
  const current = normalizePostTrainGyms(studio.player.postTrainGyms).find(
    (gym) => gym.kind === kind,
  );
  if (!current) return withAlert(studio, "warn", "Gym not found.");
  if (current.activePackageId) {
    return withAlert(studio, "warn", `${current.name} already has an upgrade in progress.`);
  }
  if (pack.tier !== (current.tier ?? 0) + 1) {
    const next = GYM_PACKAGES.find((candidate) => candidate.tier === (current.tier ?? 0) + 1);
    return withAlert(
      studio,
      "warn",
      next ? `Build ${next.label} before the later gym tiers.` : `${current.name} is already at full campus tier.`,
    );
  }
  if ((current.assignedResearchers ?? 0) < pack.minResearchers) {
    return withAlert(
      studio,
      "warn",
      `Need ${pack.minResearchers} free HQ researchers for ${pack.label}. Hire or free pods first.`,
    );
  }
  if ((current.researchShare ?? 0) < 0.05) {
    return withAlert(
      studio,
      "warn",
      `Need spare research compute for ${current.name} (data/safety reservations are too high).`,
    );
  }
  const blocked = affordOrWarn(studio, pack, `${kind} gym · ${pack.label}`);
  if (blocked) return blocked;
  const gyms = normalizePostTrainGyms(studio.player.postTrainGyms).map((gym) => {
    if (gym.kind !== kind) return gym;
    return {
      ...gym,
      activePackageId: pack.id,
      progressPfDays: 0,
      targetPfDays: pack.researchPfDays,
      operatingCostPerDay: pack.operatingCostPerDay,
    };
  });
  const charged = chargeExpense(studio, packageTotalCash(pack), "capex");
  return withAlert(
    {
      ...charged,
      player: {
        ...charged.player,
        postTrainGyms: gyms,
      },
    },
    "info",
    `Started ${kind} gym · ${pack.label}. Research staff and PF are now committed.`,
  );
}

export interface PostTrainGymAllocation {
  assignedResearchers?: number;
  assignedEngineers?: number;
  assignedDataStaff?: number;
  researchShare?: number;
  focusBias?: number;
}

/** Reserve real HQ researchers and a slice of the one shared research pool. */
export function setPostTrainGymAllocation(
  state: SimState,
  kind: PostTrainGymKind,
  allocation: PostTrainGymAllocation,
): SimState {
  const studio = withStudioPlayer(state);
  const gyms = normalizePostTrainGyms(studio.player.postTrainGyms);
  const current = gyms.find((gym) => gym.kind === kind);
  if (!current) return withAlert(studio, "warn", "Gym not found.");

  const maxResearchers = availableHqStaff(studio, {
    exceptGymKind: kind,
  }).researchers;
  const assignedResearchers = Math.max(
    0,
    Math.min(
      maxResearchers,
      Math.round(allocation.assignedResearchers ?? current.assignedResearchers ?? 0),
    ),
  );

  const dataShare = dataResearchReservationShare(studio.player.data);
  const safetyShare = studio.player.safetyCampaign ? 0.4 : 0;
  const otherGymShare = gyms.reduce(
    (sum, gym) => sum + (gym.kind === kind ? 0 : Math.max(0, gym.researchShare ?? 0)),
    0,
  );
  // Keep at least 15% available to catalog research after all data, safety,
  // and gym reservations. The gym-only normalizer separately prevents
  // malformed saves from reserving more than its 75% aggregate ceiling.
  const maxShare = Math.max(
    0,
    Math.min(
      0.75 - otherGymShare,
      0.85 - dataShare - safetyShare - otherGymShare,
    ),
  );
  const researchShare = Math.max(
    0,
    Math.min(maxShare, allocation.researchShare ?? current.researchShare ?? 0),
  );

  const focusBias =
    allocation.focusBias == null
      ? current.focusBias ?? 0.5
      : Math.max(0, Math.min(1, allocation.focusBias));
  const assignedEngineers = Math.max(
    0,
    Math.round(allocation.assignedEngineers ?? current.assignedEngineers ?? 0),
  );
  const assignedDataStaff = Math.max(
    0,
    Math.round(allocation.assignedDataStaff ?? current.assignedDataStaff ?? 0),
  );
  const next = gyms.map((gym) =>
    gym.kind === kind
      ? {
          ...gym,
          assignedResearchers,
          assignedEngineers,
          assignedDataStaff,
          researchShare,
          focusBias,
        }
      : gym,
  );
  const wasClamped =
    assignedResearchers !== Math.round(allocation.assignedResearchers ?? assignedResearchers) ||
    Math.abs(researchShare - (allocation.researchShare ?? researchShare)) > 1e-6;
  const updated = {
    ...studio,
    player: { ...studio.player, postTrainGyms: next },
  };
  return wasClamped
    ? withAlert(updated, "warn", "Gym allocation was capped by available HQ staff or research compute.")
    : updated;
}

/** Advance gym construction and continuous curriculum R&D once per game day. */
// V4-DELETE: gym programs move to src/sim/training/postTrain.ts + gyms.ts (WS-C).
export function tickPostTrainGyms(state: SimState): SimState {
  const studio = autoAssignUnlockedGyms(state);
  const normalized = normalizePostTrainGyms(studio.player.postTrainGyms);
  if (
    !normalized.some(
      (gym) =>
        (gym.assignedResearchers ?? 0) > 0 &&
        (gym.researchShare ?? 0) > 0 &&
        (Boolean(gym.activePackageId) || (gym.tier ?? 0) > 0),
    )
  ) {
    return studio;
  }

  const grossResearchPf = grossResearchPoolPf(studio);
  let remainingCash = studio.player.cash;
  let operatingSpend = 0;
  const messages: string[] = [];
  const gyms = normalized.map((gym) => {
    const researchers = Math.max(0, gym.assignedResearchers ?? 0);
    const engineers = Math.max(0, gym.assignedEngineers ?? 0);
    const dataStaff = Math.max(0, gym.assignedDataStaff ?? 0);
    const share = Math.max(0, gym.researchShare ?? 0);
    const activePack = GYM_PACKAGES.find((pack) => pack.id === gym.activePackageId);
    const completedPack = GYM_PACKAGES.find((pack) => pack.tier === (gym.tier ?? 0));
    const minResearchers = activePack?.minResearchers ?? Math.max(1, completedPack?.minResearchers ?? 1);
    if (researchers < minResearchers || share <= 0 || grossResearchPf <= 0) return gym;

    const dailyCost = Math.max(
      0,
      activePack?.operatingCostPerDay ?? completedPack?.operatingCostPerDay ?? gym.operatingCostPerDay ?? 0,
    );
    if (remainingCash + 1e-9 < dailyCost) {
      if (studio.day % 5 === 0) messages.push(`${gym.name} R&D paused — operating budget exhausted.`);
      return gym;
    }
    remainingCash -= dailyCost;
    operatingSpend += dailyCost;
    const crew =
      researchers + engineers * 0.55 + dataStaff * 0.4;
    const staffMult = Math.min(1.35, Math.sqrt(crew / Math.max(1, minResearchers)));
    // The share is the physical PF reservation. Extra staff improves how much
    // research progress that fixed compute produces; it does not draw more PF.
    const reservedPfToday = grossResearchPf * share;
    const effectiveProgressToday = reservedPfToday * staffMult;

    if (activePack) {
      const target = Math.max(0.001, gym.targetPfDays ?? activePack.researchPfDays);
      const progress = Math.min(
        target,
        (gym.progressPfDays ?? 0) + effectiveProgressToday,
      );
      if (progress + 1e-9 >= target) {
        messages.push(`${gym.name} commissioned ${activePack.label}.`);
        return {
          ...gym,
          tier: activePack.tier,
          activePackageId: null,
          progressPfDays: 0,
          targetPfDays: 0,
          investedCash: gym.investedCash + activePack.cash,
          investedComputeCash: gym.investedComputeCash + activePack.computeCash,
          quality: Math.max(gym.quality, activePack.targetQuality),
          operatingCostPerDay: activePack.operatingCostPerDay,
        };
      }
      return { ...gym, progressPfDays: progress };
    }

    // A staffed completed gym keeps learning. Returns diminish toward the
    // tier ceiling, so an expensive campus remains a long-term R&D choice.
    const tier = Math.max(0, gym.tier ?? 0);
    const ceiling = Math.min(0.995, (completedPack?.targetQuality ?? gym.quality) + 0.08);
    const improvement =
      (ceiling - gym.quality) *
      Math.min(0.04, effectiveProgressToday / Math.max(80, tier * 180));
    let quality = Math.min(ceiling, gym.quality + Math.max(0, improvement));
    if (quality < 0.62) {
      const rng = createRng(
        hashSeed(studio.seed, studio.day, gym.id, "gym-quality-jitter"),
      );
      const amplitude = (0.62 - quality) * 0.04;
      quality = Math.max(
        0,
        Math.min(ceiling, quality + rng.range(-amplitude, amplitude * 0.55)),
      );
    }
    return { ...gym, quality };
  });

  let next: SimState = {
    ...studio,
    player: { ...studio.player, postTrainGyms: gyms },
  };
  if (operatingSpend > 0) next = chargeExpense(next, operatingSpend, "research");
  for (const message of messages) next = withAlert(next, "info", message);
  return next;
}

export function teachToolSkill(
  state: SimState,
  skillId: ToolSkillId,
  packageId: string,
): SimState {
  const studio = withStudioPlayer(state);
  const pack = toolPackageById(packageId);
  if (!pack) return withAlert(studio, "warn", "Unknown tool curriculum.");
  if (!toolSkillUnlocked(skillId, studio.player.researchUnlocked)) {
    return withAlert(
      studio,
      "warn",
      `Research the ${skillId} unlock before buying curriculum.`,
    );
  }
  if (!toolPackageUnlocked(packageId, studio.player.researchUnlocked)) {
    return withAlert(
      studio,
      "warn",
      `${pack.label} needs a later alignment node.`,
    );
  }
  const blocked = affordOrWarn(studio, pack, `${skillId} · ${pack.label}`);
  if (blocked) return blocked;
  const toolSkills = normalizeToolSkills(studio.player.toolSkills).map((skill) => {
    if (skill.id !== skillId) return skill;
    const investedCash = skill.investedCash + pack.cash;
    const investedComputeCash = (skill.investedComputeCash ?? 0) + pack.computeCash;
    return {
      ...skill,
      investedCash,
      investedComputeCash,
      proficiency: toolProficiencyFromInvestment(investedCash, investedComputeCash),
    };
  });
  const charged = chargeExpense(studio, packageTotalCash(pack), "training");
  return withAlert(
    {
      ...charged,
      player: {
        ...charged.player,
        toolSkills,
      },
    },
    "info",
    `Taught ${skillId} · ${pack.label}.`,
  );
}

export function createModelRouter(state: SimState, name?: string): SimState {
  const studio = withStudioPlayer(state);
  if (!routerUnlocked(studio.player.researchUnlocked)) {
    return withAlert(
      studio,
      "warn",
      "Research Model Router before mixing specialists.",
    );
  }
  const routers = normalizeModelRouters(studio.player.modelRouters);
  const id = `router-${studio.day}-${routers.length + 1}`;
  const router: ModelRouter = {
    id,
    name: name?.trim() || `Router ${routers.length + 1}`,
    lanes: {},
  };
  return {
    ...studio,
    player: {
      ...studio.player,
      modelRouters: [...routers, router],
      activeModelRouterId: studio.player.activeModelRouterId ?? id,
    },
  };
}

export function setRouterLane(
  state: SimState,
  routerId: string,
  lane: ModelRouterLane,
  modelId: string | null,
): SimState {
  const studio = withStudioPlayer(state);
  const routers = normalizeModelRouters(studio.player.modelRouters);
  const target = routers.find((router) => router.id === routerId);
  if (!target) return withAlert(studio, "warn", "Router not found.");
  const resolvedLane =
    lane === "fast" ? "chat" : lane === "frontier" ? "default" : lane;
  if (modelId) {
    const model = studio.player.models.find((entry) => entry.id === modelId);
    if (!model) return withAlert(studio, "warn", "Assign a model you actually own.");
  }
  return {
    ...studio,
    player: {
      ...studio.player,
      modelRouters: routers.map((router) => {
        if (router.id !== routerId) return router;
        const lanes = { ...router.lanes };
        if (modelId) lanes[resolvedLane] = modelId;
        else delete lanes[resolvedLane];
        return { ...router, lanes };
      }),
    },
  };
}

export function setActiveModelRouter(
  state: SimState,
  routerId: string | null,
): SimState {
  const studio = withStudioPlayer(state);
  if (routerId && !routerUnlocked(studio.player.researchUnlocked)) {
    return withAlert(
      studio,
      "warn",
      "Research Model Router before putting a mix live.",
    );
  }
  if (
    routerId &&
    !normalizeModelRouters(studio.player.modelRouters).some(
      (router) => router.id === routerId,
    )
  ) {
    return withAlert(studio, "warn", "Router not found.");
  }
  return {
    ...studio,
    player: {
      ...studio.player,
      activeModelRouterId: routerId,
    },
  };
}

export function deleteModelRouter(state: SimState, routerId: string): SimState {
  const studio = withStudioPlayer(state);
  const routers = normalizeModelRouters(studio.player.modelRouters).filter(
    (router) => router.id !== routerId,
  );
  return {
    ...studio,
    player: {
      ...studio.player,
      modelRouters: routers,
      activeModelRouterId:
        studio.player.activeModelRouterId === routerId
          ? (routers[0]?.id ?? null)
          : studio.player.activeModelRouterId,
      pricing: {
        ...studio.player.pricing,
        apiRouterIds: studio.player.pricing.apiRouterIds?.filter(
          (id) => id !== routerId,
        ),
        plans: studio.player.pricing.plans.map((plan) => ({
          ...plan,
          routerIds: (plan.routerIds ?? []).filter((id) => id !== routerId),
        })),
      },
    },
  };
}

export function seedModelStudio(state: SimState): SimState {
  return {
    ...state,
    player: {
      ...ensureModelStudio(state.player),
      postTrainGyms:
        state.player.postTrainGyms ?? defaultPostTrainGyms(),
      toolSkills: state.player.toolSkills ?? defaultToolSkills(),
    },
  };
}
