import React, { useEffect, useMemo, useState } from "react";
import { X, Camera as CameraIcon, Loader2, Plus, Tag as TagIcon } from "lucide-react";
import {
  cameraAssignmentsApi,
  type BranchActiveNode,
  type BranchCameraWithAssignment,
  type CameraContextAssignment,
  type CameraContextType,
  type ContextTarget,
} from "../modules/organizations/api/cameraAssignmentsApi";
import { extractApiError } from "../modules/organizations/api/organizationsApi";

interface Props {
  orgId: string;
  branchId: string;
  branchName: string;
  onClose: () => void;
}

const UNASSIGNED = "";

export default function CameraAssignmentModal({
  orgId,
  branchId,
  branchName,
  onClose,
}: Props) {
  const [nodes, setNodes] = useState<BranchActiveNode[]>([]);
  const [cameras, setCameras] = useState<BranchCameraWithAssignment[]>([]);
  const [departments, setDepartments] = useState<ContextTarget[]>([]);
  const [classes, setClasses] = useState<ContextTarget[]>([]);
  const [sections, setSections] = useState<ContextTarget[]>([]);
  const [assignments, setAssignments] = useState<CameraContextAssignment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingCameraId, setSavingCameraId] = useState<string | null>(null);
  const [taggingCameraId, setTaggingCameraId] = useState<string | null>(null);
  const [savingTagKey, setSavingTagKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    Promise.all([
      cameraAssignmentsApi.listNodes(orgId, branchId),
      cameraAssignmentsApi.listCameras(orgId, branchId),
      cameraAssignmentsApi.listDepartments(orgId, branchId),
      cameraAssignmentsApi.listClasses(orgId, branchId),
      cameraAssignmentsApi.listBranchSections(orgId, branchId),
      cameraAssignmentsApi.listBranchContextAssignments(orgId, branchId),
    ])
      .then(([nodeList, cameraList, departmentList, classList, sectionList, assignmentList]) => {
        if (cancelled) return;
        setNodes(nodeList);
        setCameras(cameraList);
        setDepartments(departmentList);
        setClasses(classList);
        setSections(sectionList);
        setAssignments(assignmentList);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(extractApiError(err, "Failed to load cameras"));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, branchId]);

  const departmentsById = useMemo(
    () => Object.fromEntries(departments.map((d) => [d.id, d])),
    [departments],
  );
  const classesById = useMemo(
    () => Object.fromEntries(classes.map((c) => [c.id, c])),
    [classes],
  );
  const sectionsById = useMemo(
    () => Object.fromEntries(sections.map((s) => [s.id, s])),
    [sections],
  );

  // Section options carry their class's name in the label, since a bare
  // section name ("A", "B") is meaningless without knowing which class.
  const sectionOptions = useMemo(
    () =>
      sections.map((s) => ({
        id: s.id,
        label: s.class_id && classesById[s.class_id]
          ? `${classesById[s.class_id].name} — ${s.name}`
          : s.name,
      })),
    [sections, classesById],
  );

  const assignmentsByCamera = useMemo(() => {
    const map: Record<string, CameraContextAssignment[]> = {};
    for (const assignment of assignments) {
      if (!map[assignment.camera_id]) map[assignment.camera_id] = [];
      map[assignment.camera_id].push(assignment);
    }
    return map;
  }, [assignments]);

  const tagLabel = (assignment: CameraContextAssignment): string => {
    if (assignment.context_type === "department") {
      return `Dept: ${(assignment.department_id && departmentsById[assignment.department_id]?.name) || "Unknown"}`;
    }
    if (assignment.context_type === "class") {
      return `Class: ${(assignment.class_id && classesById[assignment.class_id]?.name) || "Unknown"}`;
    }
    const section = assignment.section_id ? sectionsById[assignment.section_id] : undefined;
    const parentClass = section?.class_id ? classesById[section.class_id] : undefined;
    return `Section: ${parentClass ? `${parentClass.name} — ` : ""}${section?.name || "Unknown"}`;
  };

  const addTag = async (
    camera: BranchCameraWithAssignment,
    contextType: CameraContextType,
    targetId: string,
  ) => {
    const key = `${camera.id}:new`;
    setSavingTagKey(key);
    setError(null);
    try {
      const payload =
        contextType === "department"
          ? { context_type: contextType, department_id: targetId }
          : contextType === "class"
            ? { context_type: contextType, class_id: targetId }
            : { context_type: contextType, section_id: targetId };
      const created = await cameraAssignmentsApi.createContextAssignment(
        orgId,
        branchId,
        camera.id,
        payload,
      );
      setAssignments((prev) => [...prev, created]);
      setTaggingCameraId(null);
    } catch (err) {
      setError(extractApiError(err, "Failed to add tag"));
    } finally {
      setSavingTagKey(null);
    }
  };

  const removeTag = async (assignment: CameraContextAssignment) => {
    setSavingTagKey(assignment.id);
    setError(null);
    try {
      await cameraAssignmentsApi.deactivateContextAssignment(
        orgId,
        branchId,
        assignment.id,
      );
      setAssignments((prev) => prev.filter((a) => a.id !== assignment.id));
    } catch (err) {
      setError(extractApiError(err, "Failed to remove tag"));
    } finally {
      setSavingTagKey(null);
    }
  };

  const handleNodeChange = async (
    camera: BranchCameraWithAssignment,
    nodeId: string,
  ) => {
    setSavingCameraId(camera.id);
    setError(null);
    try {
      const updated =
        nodeId === UNASSIGNED
          ? await cameraAssignmentsApi.unassignCameraFromNode(
            orgId,
            branchId,
            camera.id,
          )
          : await cameraAssignmentsApi.assignCameraToNode(
            orgId,
            branchId,
            camera.id,
            nodeId,
          );
      setCameras((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    } catch (err) {
      setError(extractApiError(err, "Failed to update camera assignment"));
    } finally {
      setSavingCameraId(null);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <CameraIcon size={18} color="#0d9488" />
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 900, color: "#134471" }}>
              Camera Assignments — {branchName}
            </h3>
          </div>
          <button type="button" onClick={onClose} style={closeBtn}>
            <X size={16} />
          </button>
        </div>

        <p style={{ margin: "10px 0 14px", fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
          Assign each camera to the node responsible for pulling its stream —
          an unassigned camera is processed by no node — and tag it to the
          department, class, or section a recognition on it should count
          toward.
        </p>

        {error && (
          <div style={errorBox}>{error}</div>
        )}

        {isLoading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "20px 0", color: "#64748b", fontSize: 13 }}>
            <Loader2 size={16} className="spin" /> Loading…
          </div>
        ) : cameras.length === 0 ? (
          <div style={{ padding: "20px 0", color: "#64748b", fontSize: 13 }}>
            No cameras configured on this branch.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto" }}>
            {cameras.map((camera) => {
              const saving = savingCameraId === camera.id;
              const cameraTags = assignmentsByCamera[camera.id] ?? [];
              const isTagging = taggingCameraId === camera.id;
              return (
                <div key={camera.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={row}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#134471" }}>
                        {camera.camera_name}
                      </div>
                      <div style={{ fontSize: 11, color: "#64748b" }}>
                        Ch {camera.channel} · {camera.camera_type}
                        {camera.location ? ` · ${camera.location}` : ""}
                        {!camera.enabled ? " · disabled" : ""}
                      </div>
                    </div>
                    <select
                      value={camera.assigned_node_id ?? UNASSIGNED}
                      disabled={saving}
                      onChange={(e) => void handleNodeChange(camera, e.target.value)}
                      style={select}
                    >
                      <option value={UNASSIGNED}>Unassigned</option>
                      {nodes.map((node) => (
                        <option key={node.node_id} value={node.node_id}>
                          {node.node_label || node.node_id}
                        </option>
                      ))}
                    </select>
                    {saving && <Loader2 size={14} className="spin" color="#64748b" />}
                  </div>

                  <div style={tagsRow}>
                    {cameraTags.map((assignment) => (
                      <span key={assignment.id} style={tagChip}>
                        {tagLabel(assignment)}
                        <button
                          type="button"
                          onClick={() => void removeTag(assignment)}
                          disabled={savingTagKey === assignment.id}
                          style={tagChipRemove}
                          title="Remove tag"
                        >
                          {savingTagKey === assignment.id ? (
                            <Loader2 size={10} className="spin" />
                          ) : (
                            <X size={10} />
                          )}
                        </button>
                      </span>
                    ))}
                    {isTagging ? (
                      <AddContextTagForm
                        departments={departments}
                        classes={classes}
                        sectionOptions={sectionOptions}
                        isSaving={savingTagKey === `${camera.id}:new`}
                        onAdd={(contextType, targetId) => void addTag(camera, contextType, targetId)}
                        onCancel={() => setTaggingCameraId(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setTaggingCameraId(camera.id)}
                        style={addTagBtn}
                      >
                        <TagIcon size={11} /> Add tag
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {nodes.length === 0 && !isLoading && (
          <div style={{ marginTop: 12, fontSize: 11, color: "#92400e", fontWeight: 700 }}>
            No active nodes on this branch — activate a Local Node before assigning cameras.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline "add a tag" control for one camera. Deliberately its own component
 * (rather than more state on the parent) since the context-type/target
 * selection is self-contained and only one of these is ever open at once.
 */
function AddContextTagForm({
  departments,
  classes,
  sectionOptions,
  isSaving,
  onAdd,
  onCancel,
}: {
  departments: ContextTarget[];
  classes: ContextTarget[];
  sectionOptions: { id: string; label: string }[];
  isSaving: boolean;
  onAdd: (contextType: CameraContextType, targetId: string) => void;
  onCancel: () => void;
}) {
  const [contextType, setContextType] = useState<CameraContextType>("department");
  const [targetId, setTargetId] = useState("");

  const options =
    contextType === "department"
      ? departments.map((d) => ({ id: d.id, label: d.name }))
      : contextType === "class"
        ? classes.map((c) => ({ id: c.id, label: c.name }))
        : sectionOptions;

  const handleTypeChange = (next: CameraContextType) => {
    setContextType(next);
    setTargetId(""); // options change with type — a stale id from the old list would submit silently wrong
  };

  return (
    <div style={addTagForm}>
      <select
        value={contextType}
        disabled={isSaving}
        onChange={(e) => handleTypeChange(e.target.value as CameraContextType)}
        style={addTagSelect}
      >
        <option value="department">Department</option>
        <option value="class">Class</option>
        <option value="section">Section</option>
      </select>
      <select
        value={targetId}
        disabled={isSaving || options.length === 0}
        onChange={(e) => setTargetId(e.target.value)}
        style={{ ...addTagSelect, minWidth: 140 }}
      >
        <option value="">
          {options.length === 0 ? "None available" : "Select…"}
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => targetId && onAdd(contextType, targetId)}
        disabled={isSaving || !targetId}
        style={addTagConfirmBtn}
      >
        {isSaving ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} Add
      </button>
      <button type="button" onClick={onCancel} disabled={isSaving} style={addTagCancelBtn}>
        <X size={12} />
      </button>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15,45,74,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const card: React.CSSProperties = {
  background: "#fff",
  borderRadius: 16,
  padding: 22,
  width: 560,
  maxWidth: "92vw",
  boxShadow: "0 12px 40px rgba(15,45,74,0.25)",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const closeBtn: React.CSSProperties = {
  border: "none",
  background: "#f1f5f9",
  borderRadius: 8,
  padding: 6,
  cursor: "pointer",
  color: "#64748b",
};

const errorBox: React.CSSProperties = {
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: 10,
  padding: "8px 12px",
  fontSize: 12,
  fontWeight: 700,
  marginBottom: 12,
};

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  background: "#f8fafc",
};

const select: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  padding: "6px 8px",
  fontSize: 12,
  fontWeight: 700,
  color: "#134471",
  minWidth: 160,
};

const tagsRow: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  padding: "0 12px 4px",
};

const tagChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "3px 6px 3px 9px",
  borderRadius: 999,
  background: "#f0fdfa",
  border: "1px solid #99f6e4",
  color: "#0d9488",
  fontSize: 11,
  fontWeight: 800,
};

const tagChipRemove: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "transparent",
  color: "#0d9488",
  cursor: "pointer",
  padding: 2,
  borderRadius: "50%",
};

const addTagBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: "1px dashed #cbd5e1",
  background: "transparent",
  color: "#64748b",
  borderRadius: 999,
  padding: "3px 9px",
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const addTagForm: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 6px",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  background: "#f8fafc",
};

const addTagSelect: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  padding: "4px 6px",
  fontSize: 11,
  fontWeight: 700,
  color: "#134471",
};

const addTagConfirmBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: "none",
  background: "#0d9488",
  color: "#fff",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const addTagCancelBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid #e2e8f0",
  background: "#fff",
  color: "#64748b",
  borderRadius: 6,
  padding: 4,
  cursor: "pointer",
};