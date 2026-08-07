import { Minus, Plus } from "lucide-react";

import { IconButton } from "./IconButton";

interface QuantityStepperProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  compact?: boolean;
}

export function QuantityStepper({
  label,
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  onChange,
  compact = false,
}: QuantityStepperProps) {
  const setClamped = (next: number) => onChange(Math.min(max, Math.max(min, next)));

  return (
    <div
      aria-label={label}
      className={`quantity-stepper${compact ? " compact" : ""}`}
      role="group"
    >
      <IconButton label={`${label} 감소`} onClick={() => setClamped(value - 1)} disabled={value <= min}>
        <Minus aria-hidden="true" size={14} />
      </IconButton>
      <input
        aria-label={label}
        inputMode="numeric"
        max={max}
        min={min}
        onChange={(event) => setClamped(Number(event.target.value) || min)}
        type="number"
        value={value}
      />
      <IconButton label={`${label} 증가`} onClick={() => setClamped(value + 1)} disabled={value >= max}>
        <Plus aria-hidden="true" size={14} />
      </IconButton>
    </div>
  );
}
