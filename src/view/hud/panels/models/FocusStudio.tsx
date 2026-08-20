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
    <div
      className="rounded-md border border-line/60 bg-void/30 p-2.5"
      data-focus-studio="true"
    >
      <p className="hud-eyebrow">Specialize mix</p>
      <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
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
  );
}
