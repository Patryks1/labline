import {
  signCityPowerContract,
  signPowerExportContract,
} from "../../../sim/systems/facilities";
import type { SimState } from "../../../sim/types";

/** Re-sign an expiring city import without charging an early-exit fee. */
export function renewCityPowerContract(
  state: SimState,
  contractId: string,
): SimState {
  const contract = (state.cityPowerContracts ?? []).find(
    (candidate) => candidate.id === contractId,
  );
  if (!contract) return state;
  const released = {
    ...state,
    cityPowerContracts: (state.cityPowerContracts ?? []).filter(
      (candidate) => candidate.id !== contractId,
    ),
  };
  const attempt = signCityPowerContract(
    released,
    contract.cityId,
    contract.mw,
    contract.daysTotal,
    contract.pricePerMWh,
  );
  if (attempt.cityPowerContracts.length > released.cityPowerContracts.length) {
    return attempt;
  }
  return { ...attempt, cityPowerContracts: state.cityPowerContracts };
}

/** Re-sign an expiring export offtake without charging an early-exit fee. */
export function renewPowerExportContract(
  state: SimState,
  contractId: string,
): SimState {
  const contract = (state.powerExportContracts ?? []).find(
    (candidate) => candidate.id === contractId,
  );
  if (!contract) return state;
  const released = {
    ...state,
    powerExportContracts: (state.powerExportContracts ?? []).filter(
      (candidate) => candidate.id !== contractId,
    ),
  };
  const attempt = signPowerExportContract(
    released,
    contract.cityId,
    contract.mw,
    contract.daysTotal,
    contract.pricePerMWh,
  );
  if (attempt.powerExportContracts.length > released.powerExportContracts.length) {
    return attempt;
  }
  return { ...attempt, powerExportContracts: state.powerExportContracts };
}
