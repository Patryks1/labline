import type { TrainingCheckpointBranchDirection } from "../../../../sim/types";

export interface CheckpointBranchDirectionOption {
  id: TrainingCheckpointBranchDirection;
  label: string;
  description: string;
  dataHint: string;
}

/** Canonical player-facing branch specialisations shared by capture and launch UI. */
export const CHECKPOINT_BRANCH_DIRECTIONS: readonly CheckpointBranchDirectionOption[] = [
  {
    id: "general",
    label: "General",
    description: "Keep the source model balanced while exploring a separate run.",
    dataHint: "Source mix",
  },
  {
    id: "code",
    label: "Code",
    description: "Bias the child toward programming, tools, and mathematical work.",
    dataHint: "Code + math",
  },
  {
    id: "cyber",
    label: "Cyber",
    description: "Specialise for secure code, threat analysis, and policy reasoning.",
    dataHint: "Code + law + chat",
  },
  {
    id: "chat",
    label: "Chat",
    description: "Optimise conversation quality and instruction following.",
    dataHint: "Chat",
  },
  {
    id: "agents",
    label: "Agents",
    description: "Develop tool-use and multi-step execution behavior.",
    dataHint: "Code + chat",
  },
  {
    id: "reasoning",
    label: "Reasoning",
    description: "Push planning, mathematics, and scientific problem solving.",
    dataHint: "Math + science",
  },
  {
    id: "safety",
    label: "Safety",
    description: "Explore alignment, policy, health, and refusal behavior.",
    dataHint: "Law + health + chat",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Start from the source mix and edit domain shares before launch.",
    dataHint: "Editable mix",
  },
] as const;

export function checkpointBranchDirectionLabel(
  direction: TrainingCheckpointBranchDirection,
): string {
  return (
    CHECKPOINT_BRANCH_DIRECTIONS.find((option) => option.id === direction)
      ?.label ?? "Branch"
  );
}

export function suggestedCheckpointBranchName(
  sourceRunName: string,
  direction: TrainingCheckpointBranchDirection,
): string {
  const suffix =
    direction === "general"
      ? "Branch"
      : checkpointBranchDirectionLabel(direction);
  return `${sourceRunName} · ${suffix}`;
}
