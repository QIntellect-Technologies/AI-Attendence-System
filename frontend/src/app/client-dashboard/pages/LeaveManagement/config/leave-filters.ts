/**
 * src/modules/leave/config/leave-filters.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DRY filter configuration for LeaveManagement.
 *
 * Defines all filter types, options builders, and reset behavior.
 * Single source of truth for filter logic across the module.
 *
 * Can be extended for other modules with similar filtering patterns.
 */

import type { LeaveFilterState, LeaveFilterOption } from "../types/leave";
import type { PendingLeaveItem } from "../types/leave";

interface TemplateOptionSource {
  templateConfig?: Record<string, unknown> | null;
  templateFilterKey?: string;
  groupFilterAllLabel?: string;
}

/**
 * Predefined leave types that should always be available as filter options.
 * Can be extended with custom types from actual leave data.
 */
const PREDEFINED_LEAVE_TYPES = [
  "Annual",
  "Casual",
  "Sick",
  "Emergency",
  "Maternity",
  "Paternity",
  "Unpaid",
  "Compensatory",
];

/**
 * Sentinel filter value for "half day only". Half-day is a modifier that
 * can apply to any leave category (Annual, Sick, ...), not a category of
 * its own — so it's a separate option in the same dropdown rather than a
 * ninth entry in PREDEFINED_LEAVE_TYPES, and matches on `halfDayPeriod`
 * presence rather than on `type`. See leaveMatchesFilters below.
 */
export const HALF_DAY_FILTER_VALUE = "__half_day__";

function normalizeLeaveType(type: unknown): string | null {
  if (typeof type === "string") {
    const normalized = type.trim().toLowerCase();
    return normalized || null;
  }
  return null;
}

/**
 * Filter ID type for type-safe filter references.
 */
export type LeaveFilterId =
  | "department"
  | "type"
  | "search"
  | "date"
  | "branch"
  | "reset";

/**
 * All leave filter definitions.
 * Describes what each filter does and how to build its options.
 */
export const LEAVE_FILTER_DEFAULTS: LeaveFilterState = {
  department: null,
  type: null,
  search: "",
};

/**
 * Build department filter options from leaves.
 *
 * - Always includes "All Departments" as first option
 * - Counts how many leaves match each department
 * - Used to populate dropdown
 */
function normalizeTemplateOptionValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function collectTemplateOptionEntries(
  source: unknown,
  preferredKeys: string[],
): Array<{ value: string; label: string }> {
  const entries: Array<{ value: string; label: string }> = [];

  const pushFromRecord = (record: Record<string, unknown>) => {
    Object.entries(record).forEach(([key, entry]) => {
      if (Array.isArray(entry)) {
        entry.forEach((item) => {
          if (typeof item === "string") {
            const label = item.trim();
            if (label) entries.push({ value: label, label });
          } else if (item && typeof item === "object") {
            const itemRecord = item as Record<string, unknown>;
            const value = normalizeTemplateOptionValue(
              itemRecord.value ??
                itemRecord.id ??
                itemRecord.key ??
                itemRecord.name,
            );
            const label = normalizeTemplateOptionValue(
              itemRecord.label ??
                itemRecord.name ??
                itemRecord.title ??
                itemRecord.value,
            );
            if (value && label) {
              entries.push({ value, label });
            }
          }
        });
        return;
      }
      if (entry && typeof entry === "object") {
        const entryRecord = entry as Record<string, unknown>;
        const value = normalizeTemplateOptionValue(
          entryRecord.value ??
            entryRecord.id ??
            entryRecord.key ??
            entryRecord.name ??
            key,
        );
        const label = normalizeTemplateOptionValue(
          entryRecord.label ??
            entryRecord.name ??
            entryRecord.title ??
            entryRecord.value ??
            key,
        );
        if (value && label) entries.push({ value, label });
      }
    });
  };

  if (Array.isArray(source)) {
    source.forEach((item) => {
      if (typeof item === "string") {
        const label = item.trim();
        if (label) entries.push({ value: label, label });
      } else if (item && typeof item === "object") {
        const itemRecord = item as Record<string, unknown>;
        const value = normalizeTemplateOptionValue(
          itemRecord.value ??
            itemRecord.id ??
            itemRecord.key ??
            itemRecord.name,
        );
        const label = normalizeTemplateOptionValue(
          itemRecord.label ??
            itemRecord.name ??
            itemRecord.title ??
            itemRecord.value,
        );
        if (value && label) entries.push({ value, label });
      }
    });
    return entries;
  }

  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    const directEntries = preferredKeys
      .map((key) => record[key])
      .find((value) => value !== undefined && value !== null);
    if (directEntries !== undefined) {
      if (Array.isArray(directEntries)) {
        directEntries.forEach((item) => {
          if (typeof item === "string") {
            const label = item.trim();
            if (label) entries.push({ value: label, label });
          } else if (item && typeof item === "object") {
            const itemRecord = item as Record<string, unknown>;
            const value = normalizeTemplateOptionValue(
              itemRecord.value ??
                itemRecord.id ??
                itemRecord.key ??
                itemRecord.name,
            );
            const label = normalizeTemplateOptionValue(
              itemRecord.label ??
                itemRecord.name ??
                itemRecord.title ??
                itemRecord.value,
            );
            if (value && label) entries.push({ value, label });
          }
        });
        return entries;
      }
      if (directEntries && typeof directEntries === "object") {
        pushFromRecord(directEntries as Record<string, unknown>);
        return entries;
      }
    }
    pushFromRecord(record);
  }

  return entries;
}

function buildTemplateGroupOptions(
  templateConfig: Record<string, unknown> | null | undefined,
  templateFilterKey?: string,
): LeaveFilterOption[] {
  if (!templateConfig) return [];

  // Look for verticalConfig first, which contains class/section/department lists
  const verticalCfg =
    (templateConfig.verticalConfig as Record<string, unknown>) ||
    (templateConfig.vertical_config as Record<string, unknown>);

  if (!verticalCfg) return [];

  // Priority: templateFilterKey > class > section > department > designation
  const lookupKeys = [
    templateFilterKey,
    "classes",
    "class",
    "sections",
    "section",
    "departments",
    "department",
    "designations",
    "designation",
  ].filter((k) => k !== undefined && k !== null);

  let optionsList: unknown[] = [];

  // Find the first matching list in verticalConfig
  for (const key of lookupKeys) {
    const value = verticalCfg[key];
    if (Array.isArray(value)) {
      optionsList = value;
      break;
    }
  }

  if (optionsList.length === 0) return [];

  // Extract values from the list
  const options: LeaveFilterOption[] = [];
  const seen = new Set<string>();

  optionsList.forEach((item) => {
    let value: string | null = null;
    let label: string | null = null;

    // Handle string items
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        value = trimmed;
        label = trimmed;
      }
    }
    // Handle object items
    else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      value = normalizeTemplateOptionValue(
        obj.value ?? obj.id ?? obj.key ?? obj.name,
      );
      label = normalizeTemplateOptionValue(
        obj.label ?? obj.name ?? obj.title ?? obj.value,
      );
    }

    if (value && label && !seen.has(value)) {
      seen.add(value);
      options.push({
        value,
        label,
        description: `Configured option`,
      });
    }
  });

  return options;
}

function buildTemplateLeaveTypes(
  templateConfig: Record<string, unknown> | null | undefined,
): string[] {
  if (!templateConfig) return [];

  // Look for leave types in verticalConfig
  const verticalCfg =
    (templateConfig.verticalConfig as Record<string, unknown>) ||
    (templateConfig.vertical_config as Record<string, unknown>);

  if (!verticalCfg) return [];

  const lookupKeys = [
    "leaveTypes",
    "leave_types",
    "types",
    "leaveCategories",
    "leave_categories",
  ];

  for (const key of lookupKeys) {
    const value = verticalCfg[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            return String(obj.label ?? obj.name ?? obj.value ?? "").trim();
          }
          return "";
        })
        .filter((t) => t.length > 0);
    }
  }

  return [];
}

export function buildDepartmentFilterOptions(
  leaves: PendingLeaveItem[],
  source: TemplateOptionSource = {},
): LeaveFilterOption[] {
  const templateOptions = buildTemplateGroupOptions(
    source.templateConfig,
    source.templateFilterKey,
  );

  const allLabel = source.groupFilterAllLabel ?? "All Options";
  const countsByOption = new Map<string, number>();

  // Count leaves by department to augment options with counts
  leaves.forEach((leave) => {
    const dept = leave.dept || "General";
    countsByOption.set(dept, (countsByOption.get(dept) ?? 0) + 1);
  });

  // If template options exist, use them as the primary source
  // and augment with counts from actual data
  if (templateOptions.length > 0) {
    const enrichedOptions = templateOptions.map((option) => ({
      ...option,
      count: countsByOption.get(option.value) ?? 0,
    }));

    // Also add any departments from data that aren't in template
    const templateValues = new Set(
      templateOptions.map((o) => o.value.toLowerCase()),
    );
    const extraDepts = Array.from(countsByOption.entries())
      .filter(([dept]) => !templateValues.has(dept.toLowerCase()))
      .map(([dept, count]) => ({
        value: dept,
        label: dept,
        description: `${count} pending leave request${count === 1 ? "" : "s"}`,
        count,
      }));

    return [
      {
        value: "__all__",
        label: allLabel,
        count: leaves.length,
        description: `Show leave requests from every configured group`,
      },
      ...enrichedOptions,
      ...extraDepts,
    ];
  }

  // Fallback: build from data only if no template options
  const departmentCounts = new Map<string, number>();

  // Count leaves by department
  leaves.forEach((leave) => {
    const dept = leave.dept || "General";
    departmentCounts.set(dept, (departmentCounts.get(dept) ?? 0) + 1);
  });

  // Sort alphabetically
  const sortedDepts = Array.from(departmentCounts.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return [
    {
      value: "__all__",
      label: allLabel,
      count: leaves.length,
      description: `Show leave requests from every group`,
    },
    ...sortedDepts.map(([dept, count]) => ({
      value: dept,
      label: dept,
      count,
      description: `${count} pending leave request${count === 1 ? "" : "s"}`,
    })),
  ];
}

/**
 * Build leave type filter options from leaves.
 *
 * - Always includes "All Types" as first option
 * - Includes predefined leave types (Annual, Casual, Sick, etc.)
 * - Counts how many leaves match each type
 * - Supplements with custom types found in the actual data
 * - Used to populate dropdown
 */
export function normalizeConfiguredLeaveType(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

export function buildLeaveTypeFilterOptions(
  leaves: PendingLeaveItem[],
  configuredTypes?: string[] | null,
): LeaveFilterOption[] {
  const configured = Array.isArray(configuredTypes)
    ? configuredTypes
        .map(normalizeConfiguredLeaveType)
        .filter((t): t is string => !!t)
    : [];

  const typeCounts = new Map<string, { label: string; count: number }>();

  const addType = (type: string) => {
    const normalized = normalizeLeaveType(type);
    if (!normalized) return;
    if (!typeCounts.has(normalized)) {
      typeCounts.set(normalized, {
        label: type.charAt(0).toUpperCase() + type.slice(1),
        count: 0,
      });
    }
  };

  const configuredSet = new Set<string>();
  if (configured.length > 0) {
    configured.forEach((type) => {
      const normalized = normalizeLeaveType(type);
      if (normalized) {
        configuredSet.add(normalized);
        addType(type);
      }
    });
  } else {
    PREDEFINED_LEAVE_TYPES.forEach(addType);
  }

  let halfDayCount = 0;

  leaves.forEach((leave) => {
    const type = leave.type ? normalizeLeaveType(leave.type) : "leave";
    if (type) {
      if (!typeCounts.has(type)) {
        typeCounts.set(type, {
          label: type.charAt(0).toUpperCase() + type.slice(1),
          count: 0,
        });
      }
      typeCounts.get(type)!.count += 1;
    }
    if (leave.halfDayPeriod) halfDayCount += 1;
  });

  const configuredTypesOrdered =
    configured.length > 0
      ? Array.from(typeCounts.entries())
          .filter(([type]) => configuredSet.has(type))
          .map(([type, entry]) => ({ type, ...entry }))
      : [];

  const extraTypes = Array.from(typeCounts.entries())
    .filter(([type]) => !configuredSet.has(type))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, entry]) => ({ type, ...entry }));

  const sortedTypes =
    configuredTypesOrdered.length > 0
      ? [...configuredTypesOrdered, ...extraTypes]
      : extraTypes;

  return [
    {
      value: "__all__",
      label: "All Types",
      count: leaves.length,
      description: "Show all leave types",
    },
    {
      value: HALF_DAY_FILTER_VALUE,
      label: "Half Day",
      count: halfDayCount,
      description:
        halfDayCount > 0
          ? `${halfDayCount} pending leave request${halfDayCount === 1 ? "" : "s"}`
          : "No current requests",
    },
    ...sortedTypes.map(({ type, label, count }) => ({
      value: type,
      label,
      count,
      description:
        count > 0
          ? `${count} pending leave request${count === 1 ? "" : "s"}`
          : "No current requests",
    })),
  ];
}

/**
 * Check if a leave matches current filter state.
 *
 * Returns true if leave passes ALL active filters.
 * Null/empty filters are ignored (treated as "match all").
 */
export function leaveMatchesFilters(
  leave: PendingLeaveItem,
  filters: LeaveFilterState,
): boolean {
  // Department filter
  if (filters.department && leave.dept !== filters.department) {
    return false;
  }

  // Leave type filter (the Half Day option is a modifier match on
  // halfDayPeriod, not a `type` equality check -- see HALF_DAY_FILTER_VALUE)
  const normalizedLeaveType = normalizeLeaveType(leave.type);
  const normalizedFilterType = normalizeLeaveType(filters.type);
  if (filters.type === HALF_DAY_FILTER_VALUE) {
    if (!leave.halfDayPeriod) return false;
  } else if (
    normalizedFilterType &&
    normalizedLeaveType !== normalizedFilterType
  ) {
    return false;
  }

  // Search filter (matches against multiple fields)
  if (filters.search) {
    const query = filters.search.toLowerCase().trim();
    const matchesName = leave.name.toLowerCase().includes(query);
    const matchesDept = leave.dept.toLowerCase().includes(query);
    const matchesType = leave.type.toLowerCase().includes(query);
    const matchesBranch = leave.branchName.toLowerCase().includes(query);

    if (!matchesName && !matchesDept && !matchesType && !matchesBranch) {
      return false;
    }
  }

  return true;
}

/**
 * Filter leaves by date range.
 *
 * Pending requests are an approval queue, not a historical record tied to
 * one calendar period -- an admin has to be able to find and act on a
 * pending request regardless of which day/week/month happens to be
 * selected, the same way an inbox isn't filtered by "today". So pending
 * leaves always pass this filter, unconditionally.
 *
 * Approved/Rejected leaves ARE historical records, so those stay scoped
 * to the selected period: a leave is relevant to that period if its own
 * [startDate, endDate] span overlaps the selected range at all -- "was
 * this person on leave during this period", not "when was this request
 * filed/decided".
 *
 * ISO "YYYY-MM-DD" strings sort lexicographically in calendar order, so the
 * overlap check is a plain string comparison -- no Date parsing, no
 * timezone conversion, no per-day enumeration required. `dateRange` is
 * assumed sorted ascending (guaranteed by getDatesBetween, its only
 * producer).
 */
export function filterLeavesByDateRange(
  leaves: PendingLeaveItem[],
  dateRange: string[],
  _mode: "daily" | "weekly" | "monthly" | "custom" = "daily",
): PendingLeaveItem[] {
  if (dateRange.length === 0) return [];

  const rangeStart = dateRange[0];
  const rangeEnd = dateRange[dateRange.length - 1];

  return leaves.filter((leave) => {
    if (leave.status === "Pending") return true;

    const start = leave.startDate;
    const end = leave.endDate || start;

    // No date info on this leave at all — nothing to place in any period.
    if (!start) return false;

    return start <= rangeEnd && (end as string) >= rangeStart;
  });
}

/**
 * Build all filter state descriptions for CSV export metadata.
 *
 * Used to document which filters were applied during export.
 */
export function buildFilterMetadata(
  filters: LeaveFilterState,
  dateLabel: string,
  branchName: string,
): Record<string, string | undefined> {
  return {
    Period: dateLabel,
    Branch: branchName,
    Department: filters.department ?? "All",
    "Leave Type": filters.type ?? "All",
    Search: filters.search || undefined, // Omit if empty
  };
}

/**
 * Human-readable description of current filter state.
 *
 * Example output:
 *   "1 filter active" (if department is selected)
 *   "3 filters active" (if dept, type, search are all selected)
 *   "No filters active"
 */
export function describeActiveFilters(filters: LeaveFilterState): string {
  const activeCount = [
    filters.department ? 1 : 0,
    filters.type ? 1 : 0,
    filters.search ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  if (activeCount === 0) return "No filters active";
  return `${activeCount} filter${activeCount === 1 ? "" : "s"} active`;
}
