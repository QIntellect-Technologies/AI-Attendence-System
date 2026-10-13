import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Users } from "lucide-react";
import {
  C,
  GROUP_NAME_MAX_LENGTH,
  BranchTabs,
  ChipList,
  ConfigCard,
  buttonStyle,
  inputStyle,
  sectionTitle,
} from "./SettingsUi";
import {
  createDepartment,
  createDesignation,
  deleteDepartment,
  deleteDesignation,
  listBranchDepartments,
  listDesignations,
  type DepartmentRecord,
  type DesignationRecord,
} from "../StaffManagement/api/attendanceSettingsApi";
import { confirmDialog } from "../../utils/notifications";

type Branch = { id: string; name: string };

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

/** Case/whitespace-insensitive name match — same normalization the backend
 * applies via Postgres `ilike` in create_designation, so "reuse if it
 * already exists" agrees with the server's own duplicate check instead of
 * drifting from it. */
const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function upsertByIdSorted<T extends { id: string; name: string }>(
  items: T[],
  next: T,
): T[] {
  return [...items.filter((item) => item.id !== next.id), next].sort(byName);
}

export default function DepartmentDesignationEditor({
  organizationId,
  branches,
  defaultBranchId,
  hideTabs,
}: {
  organizationId: string | number;
  branches: Branch[];
  defaultBranchId?: string;
  hideTabs?: boolean;
}) {
  const [branchId, setBranchId] = useState(
    defaultBranchId ?? branches[0]?.id ?? "",
  );

  useEffect(() => {
    // If a specific branch is locked (branch dashboard), always keep it.
    if (defaultBranchId) {
      if (branchId !== defaultBranchId) setBranchId(defaultBranchId);
      return;
    }
    if (
      branches.length &&
      (!branchId || !branches.some((b) => b.id === branchId))
    ) {
      setBranchId(branches[0].id);
    }
  }, [branches, branchId, defaultBranchId]);
  const [departments, setDepartments] = useState<DepartmentRecord[]>([]);
  // Designations are branch-scoped and owned by a department. Load each
  // department's rows together so switching departments never waits on a
  // request round trip.
  const [designationsByDepartment, setDesignationsByDepartment] = useState<
    Record<string, DesignationRecord[]>
  >({});
  const [departmentId, setDepartmentId] = useState("");
  const designations = designationsByDepartment[departmentId] ?? [];
  const [newDepartmentName, setNewDepartmentName] = useState("");
  const [newDesignationName, setNewDesignationName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDepartment = useMemo(
    () => departments.find((item) => item.id === departmentId) ?? null,
    [departments, departmentId],
  );

  // Show only the selected department's designation rows.
  const departmentDesignationChips = useMemo(
    () =>
      designations
        .slice()
        .sort(byName)
        .map((item) => ({ id: item.id, name: item.name })),
    [designations],
  );

  const changeDepartment = (nextId: string) => {
    setDepartmentId(nextId);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!organizationId || !branchId) return;
      setLoading(true);
      setError(null);
      try {
        const nextDepartments = await listBranchDepartments(
          branchId,
          organizationId,
        );
        if (cancelled) return;
        const designationEntries = await Promise.all(
          nextDepartments.map(async (department) => [
            department.id,
            await listDesignations(department.id, organizationId),
          ] as const),
        );
        if (cancelled) return;
        setDesignationsByDepartment(Object.fromEntries(designationEntries));
        setDepartments(nextDepartments);
        const nextDepartmentId = nextDepartments.some(
          (item) => item.id === departmentId,
        )
          ? departmentId
          : (nextDepartments[0]?.id ?? "");
        setDepartmentId(nextDepartmentId);
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Failed to load departments and designations.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // Re-runs only when the branch (or org) changes — changeDepartment/
    // departmentId are intentionally not deps, this effect owns the initial
    // pick for a branch and every later selection goes through
    // changeDepartment/addDepartment instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, branchId]);

  const addDepartment = async () => {
    const name = newDepartmentName.trim();
    if (!name || !branchId || saving) return;
    const previousDepartmentId = departmentId;
    const pendingId = `pending-department-${Date.now()}`;
    const pendingDepartment: DepartmentRecord = {
      id: pendingId,
      name,
      branch_id: branchId,
      status: "active",
    };
    setDepartments((items) => upsertByIdSorted(items, pendingDepartment));
    setDepartmentId(pendingId);
    setNewDepartmentName("");
    setSaving(true);
    setError(null);
    try {
      const created = await createDepartment(branchId, organizationId, {
        name,
      });
      setDepartments((items) =>
        upsertByIdSorted(items.filter((item) => item.id !== pendingId), created),
      );
      setDepartmentId(created.id);
      setDesignationsByDepartment((items) => ({ ...items, [created.id]: [] }));
    } catch (cause) {
      setDepartments((items) => items.filter((item) => item.id !== pendingId));
      setDepartmentId(previousDepartmentId);
      setNewDepartmentName(name);
      setError(
        cause instanceof Error ? cause.message : "Failed to add department.",
      );
    } finally {
      setSaving(false);
    }
  };

  const removeDepartment = async (id: string) => {
    if (saving) return;
    const target = departments.find((item) => item.id === id);
    const confirmation = await confirmDialog({
      title: `Delete "${target?.name ?? "this department"}"?`,
      text: "It will also delete its designations.",
      confirmButtonText: "Delete",
      cancelButtonText: "Cancel",
    });
    if (!confirmation.isConfirmed) return;
    setSaving(true);
    setError(null);
    try {
      await deleteDepartment(id, organizationId);
      setDepartments((items) => items.filter((item) => item.id !== id));
      if (departmentId === id) {
        setDepartmentId("");
      }
      setDesignationsByDepartment((items) => {
        const { [id]: _removed, ...remaining } = items;
        return remaining;
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to deactivate department.",
      );
    } finally {
      setSaving(false);
    }
  };

  /**
   * Creates a designation owned by the selected department.
   *
   * The backend remains the source of truth for duplicate validation.
   */
  const addDesignationToDepartment = async () => {
    const name = newDesignationName.trim();
    if (!name || !departmentId || saving) return;
    const pendingId = `pending-designation-${Date.now()}`;
    const pendingDesignation: DesignationRecord = {
      id: pendingId,
      name,
      department_id: departmentId,
      status: "active",
    };
    setDesignationsByDepartment((items) => ({
      ...items,
      [departmentId]: upsertByIdSorted(items[departmentId] ?? [], pendingDesignation),
    }));
    setNewDesignationName("");
    setSaving(true);
    setError(null);
    try {
      const created = await createDesignation(departmentId, organizationId, {
        name,
      });
      setDesignationsByDepartment((items) => ({
        ...items,
        [departmentId]: upsertByIdSorted(
          (items[departmentId] ?? []).filter((item) => item.id !== pendingId),
          created,
        ),
      }));
    } catch (cause) {
      setDesignationsByDepartment((items) => ({
        ...items,
        [departmentId]: (items[departmentId] ?? []).filter(
          (item) => item.id !== pendingId,
        ),
      }));
      setNewDesignationName(name);
      setError(
        cause instanceof Error ? cause.message : "Failed to add designation.",
      );
    } finally {
      setSaving(false);
    }
  };

  const removeDesignationFromDepartment = async (designationId: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await deleteDesignation(designationId, organizationId);
      setDesignationsByDepartment((items) => ({
        ...items,
        [departmentId]: (items[departmentId] ?? []).filter(
          (item) => item.id !== designationId,
        ),
      }));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to remove designation.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfigCard icon={<Users size={18} />} title="Departments & Designations">
      <p style={{ margin: "-6px 0 16px", color: C.textSub, fontSize: 12 }}>
        Add departments for a branch, then add the designations that belong to
        that department.
      </p>
      {error && (
        <p
          style={{
            color: C.danger,
            fontSize: 12,
            fontWeight: 700,
            margin: "0 0 12px",
          }}
        >
          {error}
        </p>
      )}
      <BranchTabs
        branches={branches}
        activeBranchId={branchId}
        onChange={setBranchId}
        hideTabs={hideTabs}
      />
      {loading ? (
        <p
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: C.textSub,
            fontSize: 13,
          }}
        >
          <Loader2 size={16} className="spin" /> Loading departments and
          designations…
        </p>
      ) : (
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}
        >
          <div>
            <h3 style={sectionTitle()}>Departments</h3>
            <div style={{ display: "flex", gap: 10, margin: "12px 0 14px" }}>
              <input
                value={newDepartmentName}
                onChange={(event) => setNewDepartmentName(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && void addDepartment()
                }
                style={inputStyle()}
                maxLength={GROUP_NAME_MAX_LENGTH}
                placeholder="Add department"
                disabled={!branchId || saving}
              />
              <button
                type="button"
                onClick={() => void addDepartment()}
                style={buttonStyle("primary")}
                disabled={saving || !branchId || !newDepartmentName.trim()}
              >
                <Plus size={15} /> Add
              </button>
            </div>
            <ChipList
              items={departments}
              empty="No departments configured for this branch yet."
              onSelect={(id) => void changeDepartment(id)}
              isSelected={(item) => item.id === departmentId}
              onRemove={(id) => void removeDepartment(id)}
              disabled={saving}
            />
          </div>
          <div>
            <h3 style={sectionTitle()}>
              {selectedDepartment
                ? `Designations for ${selectedDepartment.name}`
                : "Designations"}
            </h3>

            <div style={{ display: "flex", gap: 10, margin: "12px 0 14px" }}>
              <input
                value={newDesignationName}
                onChange={(event) => setNewDesignationName(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && void addDesignationToDepartment()
                }
                style={inputStyle()}
                maxLength={GROUP_NAME_MAX_LENGTH}
                placeholder={
                  selectedDepartment
                    ? `Add designation to ${selectedDepartment.name}`
                    : "Select a department first"
                }
                disabled={!departmentId || saving}
              />
              <button
                type="button"
                onClick={() => void addDesignationToDepartment()}
                style={buttonStyle("primary")}
                disabled={saving || !departmentId || !newDesignationName.trim()}
              >
                <Plus size={15} /> Add
              </button>
            </div>
            <ChipList
              items={departmentDesignationChips}
              empty={
                selectedDepartment
                  ? `No designations added to ${selectedDepartment.name} yet.`
                  : "No department selected."
              }
              onRemove={(id) => void removeDesignationFromDepartment(id)}
              disabled={saving}
            />
          </div>
        </div>
      )}
    </ConfigCard>
  );
}
