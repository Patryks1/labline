import { ChatCircleDots } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { HudRange } from './HudPrimitives'

export type NegotiationStatus =
  "idle" | "countered" | "declined" | "agreed" | "signed";

export function NegotiationHeader({
  title,
  subtitle,
  status,
}: {
  title: string;
  subtitle: string;
  status: NegotiationStatus;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-line/70 bg-void/40 px-3 py-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-mint/35 bg-mint/10 text-mint">
        <ChatCircleDots size={17} weight="duotone" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h3 className="truncate text-[0.8125rem] font-semibold text-bone">
            {title}
          </h3>
          <span className="h-1.5 w-1.5 rounded-full bg-mint shadow-[0_0_8px_rgba(61,255,192,0.7)]" />
        </div>
        <p className="truncate text-[0.6875rem] text-muted">{subtitle}</p>
      </div>
      {status !== "idle" ? <NegotiationBadge status={status} /> : null}
    </header>
  );
}

export function NegotiationBadge({ status }: { status: NegotiationStatus }) {
  const style =
    status === "signed" || status === "agreed"
      ? "border-mint/35 bg-mint/10 text-mint"
      : status === "declined"
        ? "border-danger/35 bg-danger/10 text-danger"
        : status === "countered"
          ? "border-amber/35 bg-amber/10 text-amber"
          : "border-line bg-void/60 text-muted";
  const label =
    status === "signed"
      ? "LIVE"
      : status === "agreed"
        ? "AGREED"
        : status === "declined"
          ? "DECLINED"
          : status === "countered"
            ? "COUNTER"
            : "DRAFT";

  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] ${style}`}
    >
      {label}
    </span>
  );
}

export function NegotiationMessage({
  side,
  name,
  status = "idle",
  children,
  timestamp = "Now",
  delivery = side === "player" ? "read" : undefined,
}: {
  side: "provider" | "player";
  name: string;
  status?: NegotiationStatus;
  children: ReactNode;
  timestamp?: string;
  delivery?: "sent" | "delivered" | "read";
}) {
  const outcomeStyle =
    status === "signed"
      ? "border-mint/40 bg-mint/10"
      : status === "declined"
        ? "border-danger/40 bg-danger/10"
        : status === "countered"
          ? "border-amber/40 bg-amber/10"
          : side === "player"
            ? "border-mint/25 bg-mint/5"
            : "border-violet/25 bg-violet/5";

  return (
    <div
      className={`flex ${side === "player" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`w-[92%] rounded-xl border px-2.5 py-2 text-[0.75rem] leading-snug text-bone ${outcomeStyle}`}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
            {name}
          </span>
          {status !== "idle" ? <NegotiationBadge status={status} /> : null}
        </div>
        {children}
        <div className={`mt-1 flex items-center gap-1 font-mono text-[0.5625rem] text-muted/80 ${side === "player" ? "justify-end" : "justify-start"}`}>
          <span>{timestamp}</span>
          {delivery ? <span aria-label={delivery}>{delivery === "sent" ? "✓" : "✓✓"}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function NegotiationComposer({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line/70 bg-void/55 p-2 shadow-[inset_0_1px_rgba(255,255,255,.025)]">
      <div className="mb-1.5 flex items-center justify-between gap-2 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted">
        <span>Compose proposal</span><span>Terms attach below</span>
      </div>
      {children}
    </div>
  );
}

export function NegotiationSlider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  formatValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  formatValue?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const display = formatValue ? formatValue(value) : String(value);
  return (
    <label className="block text-[0.6875rem] text-muted">
      <span className="flex items-center justify-between gap-2">
        <span>{label}</span>
        <span className="font-mono text-bone">
          {display}
          {suffix}
        </span>
      </span>
      <HudRange
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-0.5 w-full accent-mint"
        aria-label={label}
      />
    </label>
  );
}

export function NegotiationMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded border border-line/60 bg-void/40 px-1.5 py-1">
      <span className="block truncate text-muted">{label}</span>
      <span className="block truncate text-bone">{value}</span>
    </div>
  );
}
