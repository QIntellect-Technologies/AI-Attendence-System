import React from "react";
import { Search } from "lucide-react";
import { supportTheme } from "./SupportPageShell";

interface Option { value: string; label: string }

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  filters?: Array<{ value: string; onChange: (value: string) => void; options: Option[]; label?: string }>;
}

export const SupportToolbar: React.FC<Props> = ({ search, onSearchChange, searchPlaceholder = "Search…", filters = [] }) => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
    <div style={{ position: "relative", flex: "1 1 320px", minWidth: 240 }}>
      <Search size={15} color={supportTheme.light} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }} />
      <input value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder={searchPlaceholder} style={{ width: "100%", height: 38, borderRadius: 10, border: `1px solid ${supportTheme.border}`, padding: "0 12px 0 36px", fontSize: 12, outline: "none", background: "#fff" }} />
    </div>
    {filters.map((filter, idx) => (
      <select key={idx} value={filter.value} onChange={(e) => filter.onChange(e.target.value)} aria-label={filter.label} style={{ height: 38, borderRadius: 10, border: `1px solid ${supportTheme.border}`, padding: "0 12px", fontSize: 12, fontWeight: 700, color: supportTheme.text, background: "#fff" }}>
        {filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    ))}
  </div>
);
