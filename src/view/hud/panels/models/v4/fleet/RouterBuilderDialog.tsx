import { useEffect, useMemo, useState } from "react";
import type { CapabilityDomain, ModelCapabilities, ServePrecision } from "../../../../../../sim/types";
import type {
  Checkpoint,
  Endpoint,
  EndpointMember,
  EndpointMemberRole,
  RouterPolicy,
  TrainingUnlock,
} from "../../../../../../sim/training/types";
import { modifiersForLab } from "../../../../../../sim/training/modifiers";
import { compositeCapabilities, endpointHbmGB } from "../../../../../../sim/training/endpoints";
import { trainingStateOf } from "../../../../../../sim/training/state";
import { useGameStore } from "../../../../../../store/gameStore";
import { ConsoleDialog } from "../../../../ui/ConsoleDialog";
import {
  HudButton,
  HudInput,
  HudSelect,
  StatusChip,
} from "../../../../ui/HudPrimitives";
import { SegmentedTabs } from "../../../../ui/kit";
import { RadarChart } from "../../../../ui/RadarChart";
import { gb } from "../../../../format";
import { ArchGlyph } from "../../ui/ArchGlyph";
import { CapabilityBandChip } from "../../ui/CapabilityBandChip";
import { glyphFor, sizeLabel } from "../../viewModels/selectors";
import {
  bestSingleCapabilities,
  capabilitiesToRadarScores,
  CAPABILITY_DOMAINS,
  compositeFallbackCapabilities,
  eligibleCheckpoints,
  ensureOnePrimary,
  estimateMembersHbmGB,
  POLICY_LABEL,
  trySim,
  validateRouterDraft,
  type RouterDraft,
  type RouterDraftMember,
} from "./fleetModel";

const POLICIES: RouterPolicy[] = ["single", "domain", "cascade", "modality"];
const ROLES: EndpointMemberRole[] = ["primary", "member", "fallback"];
const DEFAULT_PRECISION: ServePrecision = "bf16";

function unlocksFor(state: Parameters<typeof modifiersForLab>[0]): TrainingUnlock[] {
  return trySim(() => modifiersForLab(state, state.playerLabId).unlocks, []);
}

function draftEndpoint(
  state: Parameters<typeof compositeCapabilities>[0],
  draft: RouterDraft,
  endpointId: string | undefined,
  precision: ServePrecision,
): Endpoint {
  const members: EndpointMember[] = draft.members.map((member) => ({
    checkpointId: member.checkpointId,
    role: member.role,
    domains: member.domains,
  }));
  return {
    id: endpointId ?? "draft-router",
    labId: state.playerLabId,
    name: draft.name.trim() || "Router",
    members,
    policy: draft.policy,
    tiers: [{ budget: 1, served: true }],
    precision,
    status: "live",
    releaseDay: state.day,
    pricing: { inPerMTok: null, outPerMTok: null },
    openWeights: false,
    modelId: endpointId ?? "draft-router",
  };
}

function memberTruths(checkpoints: Checkpoint[], members: RouterDraftMember[]): ModelCapabilities[] {
  const byId = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const truths: ModelCapabilities[] = [];
  for (const member of members) {
    const checkpoint = byId.get(member.checkpointId);
    if (checkpoint) truths.push(checkpoint.truth);
  }
  return truths;
}

function loadDraft(endpoint: Endpoint | undefined): RouterDraft {
  if (!endpoint) {
    return { name: "Router", members: [], policy: "domain" };
  }
  return {
    name: endpoint.name,
    policy: endpoint.policy === "single" ? "domain" : endpoint.policy,
    members: ensureOnePrimary(
      endpoint.members.map((member) => ({
        checkpointId: member.checkpointId,
        role: member.role,
        domains: member.domains,
      })),
    ),
  };
}

export function RouterBuilderDialog({
  open,
  onClose,
  endpointId,
}: {
  open: boolean;
  onClose: () => void;
  endpointId?: string;
}) {
  const state = useGameStore((s) => s.state);
  const createRouter = useGameStore((s) => s.createRouter);
  const updateEndpoint = useGameStore((s) => s.updateEndpoint);
  const [draft, setDraft] = useState<RouterDraft>(() => loadDraft(undefined));
  const [error, setError] = useState<string | null>(null);

  const training = trainingStateOf(state, state.playerLabId);
  const pool = eligibleCheckpoints(training.checkpoints);
  const existing = training.endpoints.find((endpoint) => endpoint.id === endpointId);

  useEffect(() => {
    if (!open) return;
    setDraft(loadDraft(existing));
    setError(null);
  }, [open, endpointId, existing]);

  const unlocks = unlocksFor(state);
  const domainUnlocked = unlocks.includes("router_domain");
  const cascadeUnlocked = unlocks.includes("router_cascade");
  const selected = new Set(draft.members.map((member) => member.checkpointId));
  const selectedCheckpoints = pool.filter((checkpoint) => selected.has(checkpoint.id));
  const truths = memberTruths(pool, draft.members);

  const composite = useMemo(() => {
    if (draft.members.length === 0) return null;
    const endpoint = draftEndpoint(state, draft, endpointId, existing?.precision ?? DEFAULT_PRECISION);
    return trySim(
      () => compositeCapabilities(state, endpoint),
      compositeFallbackCapabilities(truths),
    );
  }, [draft, endpointId, existing?.precision, state, truths]);

  const bestSingle = truths.length > 0 ? bestSingleCapabilities(truths) : null;

  const hbmGB = useMemo(() => {
    if (selectedCheckpoints.length === 0) return 0;
    const endpoint = draftEndpoint(state, draft, endpointId, existing?.precision ?? DEFAULT_PRECISION);
    return trySim(
      () => endpointHbmGB(state, endpoint),
      estimateMembersHbmGB(selectedCheckpoints, existing?.precision ?? DEFAULT_PRECISION),
    );
  }, [draft, endpointId, existing?.precision, selectedCheckpoints, state]);

  const toggleMember = (checkpointId: string) => {
    setDraft((current) => {
      const exists = current.members.some((member) => member.checkpointId === checkpointId);
      if (exists) {
        return {
          ...current,
          members: ensureOnePrimary(
            current.members.filter((member) => member.checkpointId !== checkpointId),
          ),
        };
      }
      const role: EndpointMemberRole = current.members.length === 0 ? "primary" : "member";
      return {
        ...current,
        members: [...current.members, { checkpointId, role, domains: [] }],
      };
    });
    setError(null);
  };

  const setRole = (checkpointId: string, role: EndpointMemberRole) => {
    setDraft((current) => {
      const next = current.members.map((member) => {
        if (member.checkpointId === checkpointId) return { ...member, role };
        if (role === "primary" && member.role === "primary") {
          return { ...member, role: "member" as const };
        }
        return member;
      });
      return { ...current, members: ensureOnePrimary(next as RouterDraftMember[]) };
    });
  };

  const toggleDomain = (checkpointId: string, domain: CapabilityDomain) => {
    setDraft((current) => ({
      ...current,
      members: current.members.map((member) => {
        if (member.checkpointId !== checkpointId) return member;
        const domains = member.domains ?? [];
        const next = domains.includes(domain)
          ? domains.filter((item) => item !== domain)
          : [...domains, domain];
        return { ...member, domains: next };
      }),
    }));
  };

  const setPolicy = (policy: RouterPolicy) => {
    if (policy === "single") return;
    if (policy === "domain" && !domainUnlocked && existing?.policy !== "domain") return;
    if (policy === "cascade" && !cascadeUnlocked && existing?.policy !== "cascade") return;
    setDraft((current) => ({ ...current, policy }));
  };

  const submit = () => {
    const validated = validateRouterDraft(draft);
    if (!validated.ok) {
      setError(validated.reason);
      return;
    }
    const members: EndpointMember[] = draft.members.map((member) => ({
      checkpointId: member.checkpointId,
      role: member.role,
      domains: draft.policy === "domain" ? member.domains : undefined,
    }));
    const name = draft.name.trim() || "Router";
    if (endpointId) {
      const ok = trySim(() => {
        updateEndpoint(endpointId, { name, members, policy: draft.policy });
        return true as const;
      }, false as const);
      if (!ok) {
        setError("Could not update endpoint.");
        return;
      }
      onClose();
      return;
    }
    const result = trySim(
      () => createRouter({ name, members, policy: draft.policy }),
      { ok: false as const, reason: "Could not create router." },
    );
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    onClose();
  };

  const policyLockedNote =
    draft.policy === "domain" && !domainUnlocked
      ? "Domain routing is locked until the domain router unlock is researched."
      : draft.policy === "cascade" && !cascadeUnlocked
        ? "Cascade routing is locked until the cascade router unlock is researched."
        : null;

  return (
    <ConsoleDialog
      open={open}
      titleId="router-builder-title"
      eyebrow="Fleet"
      title={endpointId ? "Edit router" : "New router"}
      description="Compose kept or released checkpoints. All members stay HBM-resident."
      onClose={onClose}
      maxWidthClass="max-w-4xl"
      footer={
        <div className="flex flex-wrap justify-end gap-1.5">
          <HudButton variant="ghost" className="min-h-11" onClick={onClose}>
            Cancel
          </HudButton>
          <HudButton variant="primary" className="min-h-11" onClick={submit}>
            {endpointId ? "Update" : "Create"}
          </HudButton>
        </div>
      }
    >
      <div className="space-y-4" data-router-builder={endpointId ?? "new"}>
        <label className="block text-[0.6875rem] text-muted">
          Name
          <HudInput
            className="mt-1"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>

        <div>
          <p className="mb-1.5 text-[0.6875rem] text-muted">Policy</p>
          <SegmentedTabs
            ariaLabel="Router policy"
            active={draft.policy}
            onChange={(id) => setPolicy(id as RouterPolicy)}
            items={POLICIES.map((policy) => {
              const locked =
                (policy === "domain" && !domainUnlocked && existing?.policy !== "domain") ||
                (policy === "cascade" && !cascadeUnlocked && existing?.policy !== "cascade");
              return {
                id: policy,
                label: POLICY_LABEL[policy],
                disabled: policy === "single" || locked,
                title:
                  policy === "single"
                    ? "Single is for one-checkpoint endpoints"
                    : locked
                      ? "Needs research unlock"
                      : undefined,
              };
            })}
          />
          {policyLockedNote ? (
            <p className="mt-1.5 text-[0.6875rem] text-amber" data-policy-lock={draft.policy}>
              {policyLockedNote}
            </p>
          ) : null}
        </div>

        <div>
          <p className="mb-1.5 text-[0.6875rem] text-muted">Members</p>
          {pool.length === 0 ? (
            <p className="text-[0.75rem] text-muted">No kept or released checkpoints.</p>
          ) : (
            <ul className="space-y-1.5">
              {pool.map((checkpoint) => {
                const on = selected.has(checkpoint.id);
                const member = draft.members.find((item) => item.checkpointId === checkpoint.id);
                return (
                  <li
                    key={checkpoint.id}
                    className="rounded-md border border-line/60 bg-void/30 p-2"
                    data-member-row={checkpoint.id}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <HudButton
                        variant={on ? "primary" : "ghost"}
                        className="min-h-11"
                        aria-pressed={on}
                        onClick={() => toggleMember(checkpoint.id)}
                      >
                        {on ? "Added" : "Add"}
                      </HudButton>
                      <ArchGlyph kind={glyphFor(checkpoint.arch)} size="sm" />
                      <span className="min-w-0 truncate text-[0.8125rem] text-bone">
                        {checkpoint.name}
                      </span>
                      <span className="font-mono text-[0.6875rem] text-muted">
                        {sizeLabel(checkpoint.arch)}
                      </span>
                      <CapabilityBandChip band={null} />
                      {on && member ? (
                        <HudSelect
                          className="min-h-11 w-32"
                          value={member.role}
                          aria-label={`Role for ${checkpoint.name}`}
                          onChange={(event) =>
                            setRole(checkpoint.id, event.target.value as EndpointMemberRole)
                          }
                        >
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </HudSelect>
                      ) : null}
                    </div>
                    {on && draft.policy === "domain" ? (
                      <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Domain lanes">
                        {CAPABILITY_DOMAINS.map((domain) => {
                          const active = member?.domains?.includes(domain) === true;
                          return (
                            <HudButton
                              key={domain}
                              variant={active ? "primary" : "ghost"}
                              className="min-h-11"
                              aria-pressed={active}
                              onClick={() => toggleDomain(checkpoint.id, domain)}
                            >
                              {domain}
                            </HudButton>
                          );
                        })}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="neutral">
            HBM {gb(hbmGB)}
          </StatusChip>
          <span className="text-[0.6875rem] text-muted">All members resident</span>
        </div>

        {composite && bestSingle ? (
          <div data-router-radar="true">
            <RadarChart
              suiteId="language"
              scores={capabilitiesToRadarScores(composite)}
              comparison={capabilitiesToRadarScores(bestSingle)}
              comparisonLabel="Best member"
              ariaLabel="Router composite versus best single member"
              compact
            />
          </div>
        ) : null}

        {error ? (
          <p className="text-[0.75rem] text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ConsoleDialog>
  );
}
