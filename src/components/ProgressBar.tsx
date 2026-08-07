interface ProgressBarProps {
  label: string;
  value: number;
  max: number;
  tone?: "accent" | "success" | "kappa";
}

export function ProgressBar({ label, value, max, tone = "accent" }: ProgressBarProps) {
  const safeMax = Math.max(max, 1);
  const percent = Math.min(100, Math.max(0, (value / safeMax) * 100));

  return (
    <div className={`progress-bar ${tone}`}>
      <div className="progress-label">
        <span>{label}</span>
        <strong>
          {value}/{max}
        </strong>
      </div>
      <div aria-label={label} aria-valuemax={max} aria-valuemin={0} aria-valuenow={value} role="progressbar">
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

