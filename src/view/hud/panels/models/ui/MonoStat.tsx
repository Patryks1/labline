const TONE_CLASS = {
  default: "neutral",
  good: "positive",
  warn: "warning",
  bad: "danger",
} as const;

export function MonoStat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  return (
    <div className={`metric-tile metric-tile--${TONE_CLASS[tone]}`}>
      <span className="metric-tile__label">{label}</span>
      <strong className="metric-tile__value">{value}</strong>
      {hint ? <span className="metric-tile__detail">{hint}</span> : null}
    </div>
  );
}
