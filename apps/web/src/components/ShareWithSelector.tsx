type ShareWithSelectorProps = {
  disabled?: boolean;
  emptyLabel: string;
  label: string;
  onChange: (userIds: string[]) => void;
  options: { displayName: string | null; userId: string; username: string }[];
  selected: string[];
};

export function ShareWithSelector({ disabled = false, emptyLabel, label, onChange, options, selected }: ShareWithSelectorProps) {
  function toggle(userId: string) {
    if (selected.includes(userId)) {
      onChange(selected.filter((id) => id !== userId));
    } else {
      onChange([...selected, userId]);
    }
  }

  return (
    <div className="reader-share-with">
      <p className="reader-share-with-label">{label}</p>
      <div className="reader-share-with-chips">
        {options.map((option) => {
          const isSelected = selected.includes(option.userId);
          return (
            <button
              aria-pressed={isSelected}
              className={["reader-share-with-chip", isSelected ? "is-selected" : ""].filter(Boolean).join(" ")}
              disabled={disabled}
              key={option.userId}
              onClick={() => toggle(option.userId)}
              type="button"
            >
              @{option.username}
              {isSelected ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      <p className="subdued">{selected.length === 0 ? emptyLabel : `${selected.length} usuario(s) además de ti.`}</p>
    </div>
  );
}
