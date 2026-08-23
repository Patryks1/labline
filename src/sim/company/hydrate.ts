import type { LabId, SimState } from "../types";
import {
  buildCompanies,
  labFromCompany,
  playerFromCompany,
  rivalFromCompany,
} from "./project";
import { playerCompanyId } from "./selectors";
import type { CompanyState } from "./types";

function sanitizeCompany(company: CompanyState): CompanyState {
  const productsById: CompanyState["productsById"] = {};
  for (const [id, product] of Object.entries(company.productsById)) {
    if (
      company.modelsById[product.primaryModelId] &&
      product.modelIds.every((modelId) => company.modelsById[modelId])
    ) {
      productsById[id] = product;
    }
  }
  const deploymentsById: CompanyState["deploymentsById"] = {};
  for (const [id, deployment] of Object.entries(company.deploymentsById)) {
    if (company.modelsById[deployment.modelId]) deploymentsById[id] = deployment;
  }
  return { ...company, productsById, deploymentsById };
}

export function withCanonicalCompanies(state: SimState): SimState {
  const companies: Record<LabId, CompanyState> = {};
  for (const [id, company] of Object.entries(buildCompanies(state))) {
    companies[id] = sanitizeCompany(company);
  }
  return {
    ...state,
    playerCompanyId: state.playerLabId,
    companies,
  };
}

export function projectLegacyFromCompanies(state: SimState): SimState {
  const companies = state.companies;
  if (!companies) return state;
  const playerId = playerCompanyId(state);
  const playerCompany = companies[playerId];
  if (!playerCompany) return state;

  const player = playerFromCompany(playerCompany, state.player);
  const rivals = state.rivals.map((rival) => {
    const company = companies[rival.id];
    return company ? rivalFromCompany(company, rival) : rival;
  });
  const labs: SimState["labs"] = { ...state.labs };
  for (const company of Object.values(companies)) {
    labs[company.id] = labFromCompany(company);
  }
  return {
    ...state,
    playerCompanyId: playerId,
    player,
    rivals,
    labs,
  };
}

export function updateCompany(
  state: SimState,
  companyId: LabId,
  updater: (company: CompanyState) => CompanyState,
): SimState {
  const current = (state.companies ?? buildCompanies(state))[companyId];
  if (!current) throw new Error(`Unknown company ${companyId}`);
  const next = updater(current);
  if (next.id !== companyId) {
    throw new Error(`Company updater changed id ${companyId} → ${next.id}`);
  }
  const companies = {
    ...(state.companies ?? buildCompanies(state)),
    [companyId]: next,
  };
  return projectLegacyFromCompanies({
    ...state,
    playerCompanyId: state.playerLabId,
    companies,
  });
}

export function assertCompanyParity(state: SimState): void {
  const hydrated = withCanonicalCompanies(state);
  const companies = hydrated.companies;
  if (!companies) throw new Error("Missing canonical companies");
  const player = companies[hydrated.playerLabId];
  if (!player) throw new Error("Missing player company");
  if (player.finance.cash !== hydrated.player.cash) {
    throw new Error(
      `Player cash parity failed: company ${player.finance.cash} vs player ${hydrated.player.cash}`,
    );
  }
  if (player.finance.cash !== hydrated.labs[hydrated.playerLabId]?.cash) {
    throw new Error("Player lab cash projection drifted from the canonical company");
  }
  if (player.modelOrder.length !== hydrated.player.models.length) {
    throw new Error("Player model order does not match compatibility models");
  }
  for (const rival of hydrated.rivals) {
    const company = companies[rival.id];
    if (!company) throw new Error(`Missing rival company ${rival.id}`);
    if (company.finance.cash !== rival.cash) {
      throw new Error(`Rival ${rival.id} cash parity failed`);
    }
    if (company.controller !== "rival" || player.controller !== "player") {
      throw new Error("Company controller shape mismatch");
    }
  }
}
