function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function ProgressRing({
  value,
  size = 28,
  label,
}: {
  value: number;
  size?: number;
  label?: string;
}) {
  const t = clamp01(value);
  const stroke = Math.max(2, size / 8);
  const radius = (size - stroke) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - t);
  const pct = Math.round(t * 100);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="text-train"
    >
      <circle
        cx={cx}
        cy={cx}
        r={radius}
        fill="none"
        stroke="var(--color-line)"
        strokeWidth={stroke}
      />
      <circle
        cx={cx}
        cy={cx}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cx})`}
      />
    </svg>
  );
}
