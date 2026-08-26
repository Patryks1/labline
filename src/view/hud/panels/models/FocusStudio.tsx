import type { FocusAxis, SpecializationFocus } from "../../../../sim/types";
import {
  emptySpecializationFocus,
  normalizeFocus,
} from "../../../../sim/balance/modelProduct";
import { SliderField } from "../../ui/SliderField";

const AXES: readonly {
  id: FocusAxis;
  label: string;
  hint: string;
}[] = [
  { id: "coding", label: "Coding", hint: "Repos, SWE traces, and math tokens." },
  { id: "science", label: "Science", hint: "Papers, lab notebooks, STEM." },
  {
    id: "research",
    label: "Research",
    hint: "Longer reasoning traces and process data.",
  },
  {
    id: "personality",
    label: "Personality",
    hint: "Style and steerability. Does not raise capability.",
  },
  { id: "chat", label: "Chat", hint: "Instruction following and dialogue." },
];

export function FocusStudio({
  focus,
  onChange,
}: {
  focus: SpecializationFocus;
  onChange: (next: SpecializationFocus) => void;
}) {
  const value = normalizeFocus(focus);
  return (
    <details
      className="group rounded-md border border-line/60 bg-void/30"
      data-focus-studio="true"
      data-mobile-default-collapsed="true"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint/60 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="hud-eyebrow block">Specialize mix</span>
          <span className="mt-0.5 block text-[0.625rem] text-muted">
            Optional domain bias
          </span>
        </span>
        <span className="font-mono text-[0.625rem] text-muted">
          <span className="group-open:hidden">Configure</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <div className="border-t border-line/40 p-2.5">
      <p className="text-[0.6875rem] leading-5 text-muted">
        Push coding, science, research, or personality. Personality never
        rerolls capability — it only changes how people stay subscribed.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {AXES.map((axis) => (
          <SliderField
            key={axis.id}
            label={axis.label}
            value={value[axis.id]}
            min={0}
            max={1}
            step={0.01}
            hint
            hoverContent={
              <p className="text-[0.6875rem] leading-5 text-muted">{axis.hint}</p>
            }
            onChange={(next) =>
              onChange({
                ...emptySpecializationFocus(),
                ...value,
                [axis.id]: next,
              })
            }
          />
        ))}
      </div>
      </div>
    </details>
  );
}
