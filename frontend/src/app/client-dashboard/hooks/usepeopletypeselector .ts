import { useMemo, useState } from "react";

export interface PeopleTypeOption {
  value: string;
  label: string;
}

export interface UsePeopleTypeSelectorResult {
  /** Always a valid member of `options` (or null if options is empty). */
  selected: string | null;
  setSelected: (value: string) => void;
  options: PeopleTypeOption[];
}

/**
 * Local UI state only — no navigation, no URL param, no persistence.
 * Matches the existing BranchSelector "filter" mode convention: switching
 * people type re-scopes the data request for the current view, nothing
 * more.
 *
 * Resets to the first available option whenever the previously-selected
 * value is no longer in the option list (e.g. branch switch changes which
 * people types are active for that branch).
 */
export function usePeopleTypeSelector(
  options: PeopleTypeOption[],
  defaultValue?: string | null,
): UsePeopleTypeSelectorResult {
  const [manualSelection, setManualSelection] = useState<string | null>(
    defaultValue ?? null,
  );

  const selected = useMemo(() => {
    if (
      manualSelection &&
      options.some((option) => option.value === manualSelection)
    ) {
      return manualSelection;
    }
    return options[0]?.value ?? null;
  }, [manualSelection, options]);

  return { selected, setSelected: setManualSelection, options };
}

export default usePeopleTypeSelector;