import React from "react";
import { Filter, RotateCcw, Search } from "lucide-react";
import { T } from "./theme";
import ModernSelect from "./ModernSelect";

export type AmountOperator = "all" | "lt" | "lte" | "eq" | "gte" | "gt";
export type SortDirection = "none" | "asc" | "desc";

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
  description?: string;
  icon?: React.ReactNode;
}

interface BaseFilterSection {
  id: string;
  label?: string;
  grow?: boolean;
  minWidth?: number | string;
  width?: number | string;
  hidden?: boolean;
}

export interface CustomFilterSection extends BaseFilterSection {
  type: "custom";
  render: React.ReactNode;
}

export interface SearchFilterSection extends BaseFilterSection {
  type: "search";
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

export interface SelectFilterSection extends BaseFilterSection {
  type: "select";
  value: string;
  options: FilterOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}

export interface ChipGroupFilterSection extends BaseFilterSection {
  type: "chipGroup";
  value: string | null;
  allLabel?: string;
  allCount?: number;
  options: FilterOption[];
  onChange: (value: string | null) => void;
  maxInlineOptions?: number;
}

export interface ResetFilterSection extends BaseFilterSection {
  type: "reset";
  label?: string;
  onClick: () => void;
}

export type DynamicFilterSection =
  | CustomFilterSection
  | SearchFilterSection
  | SelectFilterSection
  | ChipGroupFilterSection
  | ResetFilterSection;

export interface DynamicFilterToolbarProps {
  sections: DynamicFilterSection[];
  actions?: React.ReactNode;
  bordered?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const controlBase: React.CSSProperties = {
  height: 38,
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  background: T.card,
  color: T.head,
  fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
  fontSize: 12,
  fontWeight: 700,
  outline: "none",
  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
};

const labelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  fontWeight: 900,
  color: T.muted,
  whiteSpace: "nowrap",
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 30,
  padding: "6px 13px",
  borderRadius: 999,
  border: `1px solid ${active ? T.teal600 : T.border}`,
  background: active ? T.teal600 : T.card,
  color: active ? "#fff" : T.head,
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
  fontFamily: "inherit",
  boxShadow: active ? "0 5px 14px rgba(13,148,136,0.18)" : "none",
  transition: "all .16s ease",
});

const countStyle = (active: boolean): React.CSSProperties => ({
  fontSize: 10,
  padding: "1px 7px",
  borderRadius: 999,
  background: active ? "rgba(255,255,255,0.24)" : T.slate100,
  color: active ? "#fff" : T.muted,
  fontWeight: 900,
});

const DynamicFilterToolbar: React.FC<DynamicFilterToolbarProps> = ({
  sections,
  actions,
  bordered = true,
  className,
  style,
}) => {
  const visibleSections = sections.filter((section) => !section.hidden);

  const renderSection = (section: DynamicFilterSection) => {
    if (section.type === "custom") return section.render;

    if (section.type === "search") {
      return (
        <div
          style={{
            ...controlBase,
            width: section.width,
            minWidth: section.minWidth ?? 260,
            flex: section.grow ? "1 1 280px" : "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
          }}
        >
          <Search size={14} color={T.muted} />
          <input
            value={section.value}
            onChange={(event) => section.onChange(event.target.value)}
            placeholder={section.placeholder ?? "Search..."}
            style={{
              border: "none",
              outline: "none",
              background: "transparent",
              color: T.head,
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 600,
              width: "100%",
              minWidth: 0,
            }}
          />
        </div>
      );
    }

    if (section.type === "select") {
      return (
        <ModernSelect
          value={section.value}
          options={section.options.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
            icon: option.icon,
          }))}
          onChange={section.onChange}
          placeholder={section.placeholder ?? section.label ?? "Select"}
          ariaLabel={section.label}
          width={section.width}
          minWidth={section.minWidth ?? 150}
        />
      );
    }

    if (section.type === "chipGroup") {
      const visibleOptions = section.maxInlineOptions
        ? section.options.slice(0, section.maxInlineOptions)
        : section.options;

      return (
        <div
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {section.label && (
            <span style={labelStyle}>
              <Filter size={12} />
              {section.label}
            </span>
          )}

          <button
            type="button"
            onClick={() => section.onChange(null)}
            style={chipStyle(section.value === null)}
          >
            {section.allLabel ?? "All"}
            {section.allCount !== undefined && (
              <span style={countStyle(section.value === null)}>
                {section.allCount}
              </span>
            )}
          </button>

          {visibleOptions.map((option) => {
            const active = section.value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => section.onChange(active ? null : option.value)}
                style={chipStyle(active)}
              >
                {option.label}
                {option.count !== undefined && (
                  <span style={countStyle(active)}>{option.count}</span>
                )}
              </button>
            );
          })}
        </div>
      );
    }

    return (
      <button
        type="button"
        onClick={section.onClick}
        style={{
          ...controlBase,
          padding: "0 14px",
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          cursor: "pointer",
          color: T.muted,
        }}
      >
        <RotateCcw size={14} color={T.teal600} />
        {section.label ?? "Reset"}
      </button>
    );
  };

  return (
    <div
      className={className}
      style={{
        background: bordered ? T.card : "transparent",
        border: bordered ? `1px solid ${T.border}` : "none",
        borderRadius: bordered ? 16 : 0,
        boxShadow: bordered
          ? "0 1px 3px rgba(15,45,74,0.07),0 1px 2px rgba(15,45,74,0.04)"
          : "none",
        padding: bordered ? 16 : 0,
        marginBottom: 16,
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          width: "100%",
        }}
      >
        {visibleSections
          .filter((section) => section.type !== "chipGroup")
          .map((section) => (
            <React.Fragment key={section.id}>
              {renderSection(section)}
            </React.Fragment>
          ))}

        {actions && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {actions}
          </div>
        )}
      </div>

      {visibleSections.some((section) => section.type === "chipGroup") && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginTop: 12,
          }}
        >
          {visibleSections
            .filter((section) => section.type === "chipGroup")
            .map((section) => (
              <React.Fragment key={section.id}>
                {renderSection(section)}
              </React.Fragment>
            ))}
        </div>
      )}
    </div>
  );
};

export default DynamicFilterToolbar;
