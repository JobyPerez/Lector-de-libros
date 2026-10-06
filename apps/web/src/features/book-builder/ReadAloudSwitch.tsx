import "./read-aloud-switch.css";

export function ReadAloudSwitch({ checked, onChange, disabled, onLabel = "Leer en voz alta", offLabel = "No leer en voz alta" }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  const label = checked ? onLabel : offLabel;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="read-aloud-switch"
      data-on={checked ? "" : undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="read-aloud-track" aria-hidden="true">
        <span className="read-aloud-thumb" />
      </span>
      <span className="read-aloud-text">{label}</span>
    </button>
  );
}
