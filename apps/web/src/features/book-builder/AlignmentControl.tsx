import "./alignment-control.css";

export type AlignmentValue = "left" | "center" | "right";

const options: { value: AlignmentValue; label: string }[] = [
  { value: "left", label: "Izquierda" },
  { value: "center", label: "Centro" },
  { value: "right", label: "Derecha" },
];

function AlignmentIcon({ value }: { value: AlignmentValue }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      {value === "left" ? (
        <><path d="M4 6h16" /><path d="M4 10h10" /><path d="M4 14h16" /><path d="M4 18h10" /></>
      ) : value === "center" ? (
        <><path d="M4 6h16" /><path d="M7 10h10" /><path d="M4 14h16" /><path d="M7 18h10" /></>
      ) : (
        <><path d="M4 6h16" /><path d="M10 10h10" /><path d="M4 14h16" /><path d="M10 18h10" /></>
      )}
    </svg>
  );
}

export function AlignmentControl({ value, onChange, disabled }: {
  value: AlignmentValue;
  onChange: (next: AlignmentValue) => void;
  disabled?: boolean;
}) {
  return (
    <div className="alignment-control">
      <span className="alignment-label" id="alignment-control-label">Alineación</span>
      <div className="alignment-icons" role="radiogroup" aria-labelledby="alignment-control-label">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            aria-label={option.label}
            title={option.label}
            disabled={disabled}
            className="alignment-icon-button"
            data-selected={value === option.value ? "" : undefined}
            onClick={() => onChange(option.value)}
          >
            <AlignmentIcon value={option.value} />
          </button>
        ))}
      </div>
    </div>
  );
}
