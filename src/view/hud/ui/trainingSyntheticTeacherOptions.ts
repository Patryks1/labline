import type { DataDomain, Model } from "../../../sim/types";
import { modelCanCurateDataDomain } from "../../../sim/systems/modelEligibility";
import {
  availableSyntheticTeacherRecipes,
  SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK,
  syntheticTeacherGenerationEconomics,
} from "../../../sim/balance/syntheticTeacherEffort";

const TEACHER_EFFORT_SEPARATOR = "::effort::";

export interface SyntheticTeacherSelectOption {
  value: string;
  teacherId: string;
  effortId: string;
  label: string;
  effectiveCapability: number;
  effortQuality: number;
  billedTokenMultiplier: number;
  computeIntensityMultiplier: number;
  cashPerAcceptedMTok: number;
  computePfDaysPerAcceptedMTok: number;
}

export function syntheticTeacherSelectValue(
  teacherId: string,
  effortId: string,
): string {
  return `${teacherId}${TEACHER_EFFORT_SEPARATOR}${effortId}`;
}

function compactMoney(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(value >= 100 ? 0 : 1)}`;
}

function compactPf(value: number): string {
  if (value < 0.01) return value.toFixed(4);
  if (value < 1) return value.toFixed(3);
  return value.toFixed(2);
}

export function syntheticTeacherSelectOptions(
  teachers: Model[],
  domain: DataDomain,
): SyntheticTeacherSelectOption[] {
  return teachers
    .filter((teacher) => modelCanCurateDataDomain(teacher, domain))
    .flatMap((teacher) =>
      availableSyntheticTeacherRecipes(teacher).map((recipe) => {
        const economics = syntheticTeacherGenerationEconomics({
          model: teacher,
          domain,
          effortId: recipe.id,
          acceptedMTok: 1,
        });
        return {
          value: syntheticTeacherSelectValue(teacher.id, recipe.id),
          teacherId: teacher.id,
          effortId: recipe.id,
          effectiveCapability: economics.effectiveDomainCapability,
          effortQuality: economics.effortQuality,
          billedTokenMultiplier: economics.billedTokenMultiplier,
          computeIntensityMultiplier: economics.computeIntensityMultiplier,
          cashPerAcceptedMTok: economics.cashPerAcceptedMTok,
          computePfDaysPerAcceptedMTok:
            economics.computePfDaysPerAcceptedMTok,
          label: `${teacher.name} · ${recipe.name} · cap ${economics.effectiveDomainCapability.toFixed(1)} / q ${Math.round(economics.effortQuality * 100)}% · ${economics.billedTokenMultiplier.toFixed(1)}× billed · ${economics.computeIntensityMultiplier.toFixed(2)}× PF intensity · ${compactMoney(SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK)}/billed MTok → ${compactMoney(economics.cashPerAcceptedMTok)}/accepted MTok · ${compactPf(economics.computePfDaysPerAcceptedMTok)} PF/accepted MTok`,
        };
      }),
    );
}

export function parseSyntheticTeacherSelectValue(value: string): {
  teacherId: string;
  effortId: string;
} | null {
  const separator = value.lastIndexOf(TEACHER_EFFORT_SEPARATOR);
  if (separator < 0) return null;
  const teacherId = value.slice(0, separator);
  const effortId = value.slice(separator + TEACHER_EFFORT_SEPARATOR.length);
  return teacherId && effortId ? { teacherId, effortId } : null;
}
