import {
  defaultPostTrainGyms,
  defaultToolSkills,
  ensureModelStudio,
  gymPackageById,
  gymQualityFromInvestment,
  gymUnlocked,
  normalizeModelRouters,
  normalizePostTrainGyms,
  normalizeToolSkills,
  packageTotalCash,
  routerUnlocked,
  toolPackageById,
  toolProficiencyFromInvestment,
  type StudioSpendPackage,
} from "../balance/modelStudio";
import type {
  ModelRouter,
  ModelRouterLane,
  PostTrainGymKind,
  SimState,
  ToolSkillId,
} from "../types";
import { chargeExpense } from "./financeLedger";

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
  const studio = withStudioPlayer(state);
  if (!gymUnlocked(kind, studio.player.researchUnlocked)) {
    return withAlert(
      studio,
      "warn",
      `Research the ${kind} lab before funding it.`,
    );
  }
  const pack = gymPackageById(packageId);
  if (!pack) return withAlert(studio, "warn", "Unknown gym package.");
  const blocked = affordOrWarn(studio, pack, `${kind} gym · ${pack.label}`);
  if (blocked) return blocked;
  const gyms = normalizePostTrainGyms(studio.player.postTrainGyms).map((gym) => {
    if (gym.kind !== kind) return gym;
    const investedCash = gym.investedCash + pack.cash;
    const investedComputeCash = gym.investedComputeCash + pack.computeCash;
    return {
      ...gym,
      investedCash,
      investedComputeCash,
      quality: gymQualityFromInvestment(investedCash, investedComputeCash),
    };
  });
  const charged = chargeExpense(studio, packageTotalCash(pack), "training");
  return withAlert(
    {
      ...charged,
      player: {
        ...charged.player,
        postTrainGyms: gyms,
      },
    },
    "info",
    `Funded ${kind} gym · ${pack.label}.`,
  );
}

export function teachToolSkill(
  state: SimState,
  skillId: ToolSkillId,
  packageId: string,
): SimState {
  const studio = withStudioPlayer(state);
  const pack = toolPackageById(packageId);
  if (!pack) return withAlert(studio, "warn", "Unknown tool curriculum.");
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
