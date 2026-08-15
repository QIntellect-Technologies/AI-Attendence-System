/**
 * BranchFilterSelect.tsx
 *
 * Global branch filter dropdown.
 * When `showAllOption` is true (default), renders an "All Branches" entry
 * whose value is the sentinel string "all".  The parent receives `undefined`
 * when "All Branches" is selected so it can reset to the global accumulation.
 */

import React from "react";
import { T } from "../../ui/theme";

interface BranchOption {
  id: number;
  name: string;
}

interface BranchFilterSelectProps {
  /** Currently selected branch id, or undefined = "All Branches" */
  value?: number;
  options: BranchOption[];
  /** Called with undefined when "All Branches" is chosen */
  onChange: (branchId: number | undefined) => void;
  /** Show the "All Branches" sentinel option (default: true) */
  showAllOption?: boolean;
}

const BranchFilterSelect: React.FC<BranchFilterSelectProps> = ({
  value,
  options,
  onChange,
  showAllOption = true,
}) => {
  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const raw = event.target.value;
    onChange(raw === "all" ? undefined : Number(raw));
  };

  return (
    <select
      value={value ?? "all"}
      onChange={handleChange}
      style={{
        border: "none",
        outline: "none",
        background: T.teal100,
        color: T.head,
        padding: "9px 12px",
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: "'DM Sans', sans-serif",
        maxWidth: 170,
      }}
    >
      {showAllOption && <option value="all">All Branches</option>}
      {options.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.name}
        </option>
      ))}
    </select>
  );
};

export default React.memo(BranchFilterSelect);
