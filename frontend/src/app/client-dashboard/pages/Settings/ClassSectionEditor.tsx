import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, GraduationCap } from "lucide-react";
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
  createClass,
  createSection,
  deleteClass,
  deleteSection,
  listBranchClasses,
  listSections,
  type ClassRecord,
  type SectionRecord,
} from "../StaffManagement/api/attendanceSettingsApi";

type Branch = { id: string; name: string };

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export default function ClassSectionEditor({
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
  const [branchId, setBranchId] = useState(defaultBranchId ?? branches[0]?.id ?? "");

  useEffect(() => {
    if (defaultBranchId) {
      if (branchId !== defaultBranchId) setBranchId(defaultBranchId);
      return;
    }
    if (branches.length && (!branchId || !branches.some((b) => b.id === branchId))) {
      setBranchId(branches[0].id);
    }
  }, [branches, branchId, defaultBranchId]);

  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [sections, setSections] = useState<SectionRecord[]>([]);
  const [classId, setClassId] = useState("");
  const [newClassName, setNewClassName] = useState("");
  const [newSectionName, setNewSectionName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedClass = useMemo(
    () => classes.find((item) => item.id === classId) ?? null,
    [classes, classId],
  );

  const changeClass = async (nextId: string) => {
    setClassId(nextId);
    if (!nextId) { setSections([]); return; }
    try {
      setSections(await listSections(nextId, organizationId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load sections.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!organizationId || !branchId) return;
      setLoading(true);
      setError(null);
      try {
        const nextClasses = await listBranchClasses(branchId, organizationId);
        if (cancelled) return;
        setClasses(nextClasses);
        const nextClassId = nextClasses.some((item) => item.id === classId)
          ? classId
          : (nextClasses[0]?.id ?? "");
        setClassId(nextClassId);
        setSections(nextClassId ? await listSections(nextClassId, organizationId) : []);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load classes and sections.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, branchId]);

  const addClass = async () => {
    const name = newClassName.trim();
    if (!name || !branchId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createClass(branchId, organizationId, { name });
      setClasses((items) => [...items, created].sort(byName));
      setNewClassName("");
      await changeClass(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to add class.");
    } finally {
      setSaving(false);
    }
  };

  const removeClass = async (id: string) => {
    if (saving) return;
    const target = classes.find((item) => item.id === id);
    const confirmed = window.confirm(
      `Deactivate "${target?.name ?? "this class"}"?\n\nIt will no longer be selectable for new students or sections. Existing students and sections are not deleted.`,
    );
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      await deleteClass(id, organizationId);
      setClasses((items) => items.filter((item) => item.id !== id));
      if (classId === id) { setClassId(""); setSections([]); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to deactivate class.");
    } finally {
      setSaving(false);
    }
  };

  const addSection = async () => {
    const name = newSectionName.trim();
    if (!name || !classId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createSection(classId, organizationId, { name });
      setSections((items) => [...items, created].sort(byName));
      setNewSectionName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to add section.");
    } finally {
      setSaving(false);
    }
  };

  const removeSection = async (sectionId: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await deleteSection(sectionId, organizationId);
      setSections((items) => items.filter((item) => item.id !== sectionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to remove section.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfigCard icon={<GraduationCap size={18} />} title="Classes & Sections">
      <p style={{ margin: "-6px 0 16px", color: C.textSub, fontSize: 12 }}>
        Add classes for a branch, then add the sections that belong to each
        one directly. A class always belongs to this branch only — when a
        new branch is added later, it starts with no classes of its own.
      </p>
      {error && (
        <p style={{ color: C.danger, fontSize: 12, fontWeight: 700, margin: "0 0 12px" }}>
          {error}
        </p>
      )}
      <BranchTabs branches={branches} activeBranchId={branchId} onChange={setBranchId} hideTabs={hideTabs} />
      {loading ? (
        <p style={{ display: "flex", alignItems: "center", gap: 8, color: C.textSub, fontSize: 13 }}>
          <Loader2 size={16} className="spin" /> Loading classes and sections…
        </p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <div>
            <h3 style={sectionTitle()}>Classes</h3>
            <div style={{ display: "flex", gap: 10, margin: "12px 0 14px" }}>
              <input
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addClass()}
                style={inputStyle()}
                maxLength={GROUP_NAME_MAX_LENGTH}
                placeholder="Add class"
                disabled={!branchId || saving}
              />
              <button type="button" onClick={() => void addClass()} style={buttonStyle("primary")}
                disabled={saving || !branchId || !newClassName.trim()}>
                <Plus size={15} /> Add
              </button>
            </div>
            <ChipList
              items={classes}
              empty="No classes configured for this branch yet."
              onSelect={(id) => void changeClass(id)}
              isSelected={(item) => item.id === classId}
              onRemove={(id) => void removeClass(id)}
              disabled={saving}
            />
          </div>
          <div>
            <h3 style={sectionTitle()}>
              {selectedClass ? `Sections for ${selectedClass.name}` : "Sections"}
            </h3>
            <p style={{ margin: "8px 0 12px", color: C.textSub, fontSize: 12 }}>
              {selectedClass ? `${sections.length} section(s) in ${selectedClass.name}.` : "Select a class on the left to add its sections."}
            </p>
            <div style={{ display: "flex", gap: 10, margin: "0 0 14px" }}>
              <input
                value={newSectionName}
                onChange={(e) => setNewSectionName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addSection()}
                style={inputStyle()}
                maxLength={GROUP_NAME_MAX_LENGTH}
                placeholder={selectedClass ? `Add section to ${selectedClass.name}` : "Select a class first"}
                disabled={!classId || saving}
              />
              <button type="button" onClick={() => void addSection()} style={buttonStyle("primary")}
                disabled={saving || !classId || !newSectionName.trim()}>
                <Plus size={15} /> Add
              </button>
            </div>
            <ChipList
              items={sections}
              empty={selectedClass ? `No sections added to ${selectedClass.name} yet.` : "No class selected."}
              onRemove={(id) => void removeSection(id)}
              disabled={saving}
            />
          </div>
        </div>
      )}
    </ConfigCard>
  );
}