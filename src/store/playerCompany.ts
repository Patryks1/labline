import { useGameStore } from "./gameStore";
import {
  playerCompanyId,
  selectCompanyModels,
  selectPlayerCompany,
} from "../sim/company";

export function usePlayerCompany() {
  return useGameStore((s) => selectPlayerCompany(s.state));
}

export function usePlayerModels() {
  return useGameStore((s) =>
    selectCompanyModels(s.state, playerCompanyId(s.state)),
  );
}

export function usePlayerCash() {
  return useGameStore((s) => selectPlayerCompany(s.state).finance.cash);
}
