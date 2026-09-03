import type { ReactNode } from "react";
import { Lock } from "@phosphor-icons/react";
import { HudButton } from "../../../../ui/HudPrimitives";

export function LockedChoice({
  selected,
  locked,
  reason,
  onClick,
  children,
  className = "",
}: {
  selected: boolean;
  locked: boolean;
  reason?: string | null;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <HudButton
      type="button"
      variant={selected && !locked ? "primary" : "ghost"}
      className={`!min-h-11 ${locked ? "models-v4-action--locked" : ""} ${className}`}
      disabled={locked}
      disabledReason={locked ? (reason ?? "Locked") : undefined}
      aria-pressed={selected}
      aria-disabled={locked || undefined}
      data-locked={locked ? "true" : undefined}
      onClick={locked ? undefined : onClick}
    >
      {locked ? <Lock size="0.75rem" weight="bold" className="shrink-0" aria-hidden /> : null}
      {children}
    </HudButton>
  );
}
