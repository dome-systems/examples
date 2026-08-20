"use client";

import {
  OPPONENT_SKILLS,
  type OpponentSkill,
} from "@/lib/dome-broker";

type Props = {
  value: OpponentSkill;
  disabled?: boolean;
  routedModel?: string | null;
  routeSource?: "stub" | "dome-broker" | null;
  onChange: (skill: OpponentSkill) => void;
};

export function OpponentSkillPicker({
  value,
  disabled,
  routedModel,
  routeSource,
  onChange,
}: Props) {
  return (
    <div className="rounded-md border border-[var(--line)] bg-white/40 px-3 py-2">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium">Opponent skill</p>
        <p className="text-[11px] text-black/45">
          Standing agent · Dome model routing
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {OPPONENT_SKILLS.map((s) => {
          const active = s.id === value;
          return (
            <button
              key={s.id}
              type="button"
              disabled={disabled}
              title={s.detail}
              onClick={() => onChange(s.id)}
              className={
                active
                  ? "rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs text-white"
                  : "rounded-md border border-[var(--line)] px-2.5 py-1 text-xs text-black/70 hover:bg-white disabled:opacity-40"
              }
            >
              {s.label}
            </button>
          );
        })}
      </div>
      {routedModel ? (
        <p className="mt-2 font-mono text-[11px] text-black/55">
          Broker → {routedModel}
          {routeSource ? (
            <span className="text-black/35"> · {routeSource}</span>
          ) : null}
        </p>
      ) : (
        <p className="mt-2 text-[11px] text-black/45">
          {OPPONENT_SKILLS.find((s) => s.id === value)?.detail}
        </p>
      )}
    </div>
  );
}
