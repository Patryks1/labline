import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Flask } from "@phosphor-icons/react";
import { HudButton } from "../../ui/HudPrimitives";

export type BenchmarkContext =
  | { kind: "training-run"; id: string }
  | { kind: "checkpoint"; id: string }
  | { kind: "public"; id?: string };

/**
 * Shared visual/action contract for every Benchmark entry point. The owning
 * surface still supplies its existing handler, quote, eligibility and dialog;
 * this component only makes the context explicit and keeps the action label
 * consistent across runs, checkpoints and public evidence.
 */
export function BenchmarkEntryPoint({
  context,
  onOpen,
  children = "Benchmark",
  variant = "secondary",
  icon = true,
  ...buttonProps
}: {
  context: BenchmarkContext;
  onOpen?: () => void;
  children?: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <HudButton
      {...buttonProps}
      type={buttonProps.type ?? "button"}
      variant={variant}
      data-benchmark-entrypoint={context.kind}
      data-benchmark-subject={context.id}
      aria-label={buttonProps["aria-label"] ?? `Benchmark${context.id ? ` ${context.id}` : ""}`}
      onClick={onOpen}
    >
      {icon ? <Flask size="0.875rem" /> : null}
      {children}
    </HudButton>
  );
}
