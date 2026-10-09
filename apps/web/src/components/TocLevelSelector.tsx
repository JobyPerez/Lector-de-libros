import { TOC_MAX_LEVEL_OPTIONS, type TocMaxLevel } from "../app/toc-level";

export function TocLevelSelector({
  id,
  label = "Nivel",
  onChange,
  value
}: {
  id?: string;
  label?: string;
  onChange: (level: TocMaxLevel) => void;
  value: TocMaxLevel;
}) {
  const groupId = id ?? "toc-level";
  return (
    <div className="toc-level-selector" id={groupId}>
      <span className="toc-level-selector-label" id={`${groupId}-label`}>{label}</span>
      <div aria-labelledby={`${groupId}-label`} className="toc-level-segmented" role="radiogroup">
        {TOC_MAX_LEVEL_OPTIONS.map((level) => (
          <button
            aria-checked={value === level}
            aria-label={`Ver hasta T${level}`}
            className={value === level ? "toc-level-option active" : "toc-level-option"}
            key={level}
            onClick={() => onChange(level)}
            role="radio"
            title={`Ver hasta T${level}`}
            type="button"
          >
            T{level}
          </button>
        ))}
      </div>
    </div>
  );
}
