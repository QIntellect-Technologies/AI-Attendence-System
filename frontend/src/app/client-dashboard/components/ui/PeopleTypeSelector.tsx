/**
 * components/ui/PeopleTypeSelector.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic, controlled dropdown for selecting a "person type" (e.g. Staff,
 * Worker, Student). Deliberately has no knowledge of attendance, org config,
 * or any specific vertical — it only renders the options it's given and
 * reports selection changes. Callers own:
 *   - what options are available (filtering, ordering, restrictions)
 *   - what the default/selected value is
 *
 * Implementation note: this is intentionally a thin wrapper around
 * ModernSelect rather than a separate dropdown implementation. ModernSelect
 * owns the actual portal/positioning/transition/a11y logic (see its header
 * comment for why the panel is portaled to document.body with fixed
 * coordinates). Duplicating that logic here would mean two places to fix
 * the same class of stacking-context bugs and two visual styles to keep in
 * sync — this wrapper just maps the narrower "person type" API onto it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from "react";
import ModernSelect, { ModernSelectOption } from "./ModernSelect";

export interface PeopleTypeOption {
  value: string;
  label: string;
  description?: string;
  /** Optional per-option icon, rendered in place of the default check mark. */
  icon?: React.ReactNode;
}

export interface PeopleTypeSelectorProps {
  /** Options to render. Caller is responsible for any filtering (e.g. excluding an "all" option). */
  options: PeopleTypeOption[];
  /** Currently selected value. Should match one of options[].value. */
  value: string;
  /** Called with the newly selected option's value. */
  onChange: (value: string) => void;
  /** Optional leading icon rendered inside the trigger button. */
  icon?: React.ReactNode;
  /** Accessible label for the control (not visibly rendered). Defaults to "Select type". */
  ariaLabel?: string;
  disabled?: boolean;
  /** Applied to the wrapping element (ModernSelect itself takes no className — it's styled via inline theme tokens). */
  className?: string;
  minWidth?: number;
  /** Stacking order for the portaled panel. Passed straight through to ModernSelect. */
  zIndex?: number;
}

export default function PeopleTypeSelector({
  options,
  value,
  onChange,
  icon,
  ariaLabel = "Select type",
  disabled = false,
  className = "",
  minWidth = 180,
  zIndex,
}: PeopleTypeSelectorProps) {
  // ModernSelectOption is a superset of PeopleTypeOption (adds nothing extra
  // here), so this is a type-safe identity mapping — no runtime cost beyond
  // memoizing against the array reference.
  const modernOptions: ModernSelectOption[] = useMemo(() => options, [options]);

  return (
    <div className={className}>
      <ModernSelect
        value={value}
        options={modernOptions}
        onChange={onChange}
        ariaLabel={ariaLabel}
        disabled={disabled}
        minWidth={minWidth}
        leadingIcon={icon}
        {...(zIndex !== undefined ? { zIndex } : {})}
      />
    </div>
  );
}
