import type { ComputeSnapshot } from "../systems/compute";

export type PlacementDomain = "local" | "cloud";

export interface PlacementMemoryGate {
  ok: boolean;
  domain: PlacementDomain | null;
  requiredHbmGb: number;
  requiredHostRamGb: number;
  localHbmGb: number;
  cloudHbmGb: number;
  chosenHbmGb: number;
  reason?: string;
}

/**
 * One indivisible training job must fit in a single placement domain.
 * Local campus HBM and rented cloud HBM are never added together.
 */
export function largestSingleDomainHbmGb(
  snapshot: Pick<ComputeSnapshot, "localVramGb" | "remoteVramGb">,
): { domain: PlacementDomain; hbmGb: number } {
  const local = Math.max(0, snapshot.localVramGb ?? 0);
  const cloud = Math.max(0, snapshot.remoteVramGb ?? 0);
  if (cloud > local) return { domain: "cloud", hbmGb: cloud };
  return { domain: "local", hbmGb: local };
}

export function trainingFitsPlacementDomain(input: {
  requiredHbmGb: number;
  requiredHostRamGb?: number;
  snapshot: Pick<
    ComputeSnapshot,
    "localVramGb" | "remoteVramGb" | "localSystemRamGb" | "remoteSystemRamGb"
  >;
  preferred?: PlacementDomain;
}): PlacementMemoryGate {
  const requiredHbmGb = Math.max(0, input.requiredHbmGb);
  const requiredHostRamGb = Math.max(0, input.requiredHostRamGb ?? 0);
  const localHbmGb = Math.max(0, input.snapshot.localVramGb ?? 0);
  const cloudHbmGb = Math.max(0, input.snapshot.remoteVramGb ?? 0);
  const localRam = Math.max(0, input.snapshot.localSystemRamGb ?? 0);
  const cloudRam = Math.max(0, input.snapshot.remoteSystemRamGb ?? 0);

  const candidates: Array<{
    domain: PlacementDomain;
    hbmGb: number;
    ramGb: number;
  }> = [
    { domain: "local", hbmGb: localHbmGb, ramGb: localRam },
    { domain: "cloud", hbmGb: cloudHbmGb, ramGb: cloudRam },
  ];
  const ordered = input.preferred
    ? [
        ...candidates.filter((candidate) => candidate.domain === input.preferred),
        ...candidates.filter((candidate) => candidate.domain !== input.preferred),
      ]
    : [...candidates].sort((a, b) => b.hbmGb - a.hbmGb);

  for (const candidate of ordered) {
    const hbmOk = candidate.hbmGb + 1e-9 >= requiredHbmGb;
    const ramOk = requiredHostRamGb <= 0 || candidate.ramGb + 1e-9 >= requiredHostRamGb;
    if (hbmOk && ramOk) {
      return {
        ok: true,
        domain: candidate.domain,
        requiredHbmGb,
        requiredHostRamGb,
        localHbmGb,
        cloudHbmGb,
        chosenHbmGb: candidate.hbmGb,
      };
    }
  }

  const best = largestSingleDomainHbmGb(input.snapshot);
  return {
    ok: false,
    domain: null,
    requiredHbmGb,
    requiredHostRamGb,
    localHbmGb,
    cloudHbmGb,
    chosenHbmGb: best.hbmGb,
    reason: `Training needs ${requiredHbmGb.toFixed(0)} GB HBM in one placement domain; largest domain has ${best.hbmGb.toFixed(0)} GB. Local and cloud memory cannot be pooled for one job.`,
  };
}
