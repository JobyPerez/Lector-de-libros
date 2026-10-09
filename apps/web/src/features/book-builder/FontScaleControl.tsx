import "./font-scale-control.css";

const presets = [1, 2, 3];

export function FontScaleControl({ value, onChange, disabled, simple = false }: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  simple?: boolean;
}) {
  const current = value ?? 1;
  return (
    <div className="font-scale-control">
      <span className="font-scale-label" id="font-scale-control-label">Escala de fuente: {current}</span>
      {!simple ? <input
        type="range"
        aria-labelledby="font-scale-control-label"
        min={0.5}
        max={3}
        step={0.05}
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      /> : null}
      <div className="font-scale-presets" role="group" aria-label="Valores rápidos de escala">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={disabled}
            aria-pressed={current === preset}
            data-selected={current === preset ? "" : undefined}
            onClick={() => onChange(preset)}
          >
            {preset}
          </button>
        ))}
      </div>
    </div>
  );
}
