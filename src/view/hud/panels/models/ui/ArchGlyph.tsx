import type { ArchGlyphKind } from "../viewModels/types";

const SIZE_PX = { sm: 16, md: 20 } as const;

const LABELS: Record<ArchGlyphKind, string> = {
  dense: "Dense architecture",
  moe: "Mixture-of-experts architecture",
  omni: "Omni architecture",
  specialist: "Specialist architecture",
};

function DenseGlyph() {
  return <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />;
}

function MoeGlyph() {
  return (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" fill="currentColor" />
      <rect x="14" y="4" width="6" height="6" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="4" y="14" width="6" height="6" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="14" y="14" width="6" height="6" rx="1" fill="currentColor" />
    </>
  );
}

function OmniGlyph() {
  return (
    <>
      <circle cx="10" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="14" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </>
  );
}

function SpecialistGlyph() {
  return (
    <polygon points="12,3 21,12 12,21 3,12" fill="currentColor" />
  );
}

export function ArchGlyph({
  kind,
  size = "md",
}: {
  kind: ArchGlyphKind;
  size?: "sm" | "md";
}) {
  const px = SIZE_PX[size];
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      aria-label={LABELS[kind]}
      role="img"
      className="text-bone"
    >
      {kind === "dense" ? <DenseGlyph /> : null}
      {kind === "moe" ? <MoeGlyph /> : null}
      {kind === "omni" ? <OmniGlyph /> : null}
      {kind === "specialist" ? <SpecialistGlyph /> : null}
    </svg>
  );
}
