import type { LabId, SimState } from "../types";
import { companyFromPlayer, companyFromRival } from "./project";
import type { CompanyState } from "./types";

export function playerCompanyId(state: SimState): LabId {
  return state.playerCompanyId ?? state.playerLabId;
}

export function selectCompany(state: SimState, companyId: LabId): CompanyState {
  const indexed = state.companies?.[companyId];
  if (indexed) return indexed;
  if (companyId === playerCompanyId(state) || companyId === state.playerLabId) {
    return companyFromPlayer(state);
  }
  const rival = state.rivals.find((entry) => entry.id === companyId);
  if (!rival) throw new Error(`Unknown company ${companyId}`);
  return companyFromRival(state, rival);
}

export function selectPlayerCompany(state: SimState): CompanyState {
  return selectCompany(state, playerCompanyId(state));
}

export function selectCompanyModels(state: SimState, companyId: LabId) {
  const company = selectCompany(state, companyId);
  return company.modelOrder
    .map((id) => company.modelsById[id])
    .filter((model) => model != null);
}

export function selectCompanyJobs(state: SimState, companyId: LabId) {
  const company = selectCompany(state, companyId);
  return company.trainingJobOrder
    .map((id) => company.trainingJobsById[id])
    .filter((job) => job != null);
}
