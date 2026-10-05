import React, { useEffect, useState } from "react";
import { X, Workflow as WorkflowIcon, Loader2 } from "lucide-react";
import { branchesApi, extractApiError } from "../api/organizationsApi";
import AttendanceWorkflowSelector from "./AttendanceWorkflowSelector";

type AttendanceWorkflow = "scenario_based" | "simple";

type AttendanceWorkflowSetting = {
    people_type: string;
    attendance_workflow: AttendanceWorkflow;
};

interface Props {
    orgId: string;
    branchId: string;
    branchName: string;
    onClose: () => void;
}

function titleCase(value: string): string {
    return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function AttendanceWorkflowModal({
    orgId,
    branchId,
    branchName,
    onClose,
}: Props) {
    const [settings, setSettings] = useState<AttendanceWorkflowSetting[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [savingPeopleType, setSavingPeopleType] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);
        branchesApi
            .getAttendanceWorkflows(orgId, branchId)
            .then((rows) => {
                if (!cancelled) setSettings(rows);
            })
            .catch((err) => {
                if (!cancelled) setError(extractApiError(err, "Failed to load attendance workflow"));
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [orgId, branchId]);

    const handleChange = async (peopleType: string, next: AttendanceWorkflow) => {
        setSavingPeopleType(peopleType);
        setError(null);
        try {
            const updated = await branchesApi.setAttendanceWorkflow(orgId, branchId, peopleType, next);
            setSettings((current) =>
                current.map((row) => (row.people_type === peopleType ? updated : row)),
            );
        } catch (err) {
            setError(extractApiError(err, "Failed to save attendance workflow"));
        } finally {
            setSavingPeopleType(null);
        }
    };

    return (
        <div style={overlay} onClick={onClose}>
            <div style={card} onClick={(e) => e.stopPropagation()}>
                <div style={header}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <WorkflowIcon size={18} color="#0d9488" />
                        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 900, color: "#134471" }}>
                            Attendance Workflow — {branchName}
                        </h3>
                    </div>
                    <button type="button" onClick={onClose} style={closeBtn}>
                        <X size={16} />
                    </button>
                </div>

                <p style={{ margin: "10px 0 14px", fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                    Chooses how this branch's Local Node marks attendance for each
                    people type — see the two options below for what each means.
                </p>

                {error && <div style={errorBox}>{error}</div>}

                {isLoading ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "20px 0", color: "#64748b", fontSize: 13 }}>
                        <Loader2 size={16} className="spin" /> Loading…
                    </div>
                ) : settings.length === 0 ? (
                    <div style={{ padding: "20px 0", color: "#64748b", fontSize: 13 }}>
                        No people type has attendance enabled for this branch yet.
                        Enable attendance for at least one people type first.
                    </div>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                        {settings.map((setting) => (
                            <div key={setting.people_type}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: "#134471", marginBottom: 6 }}>
                                    {titleCase(setting.people_type)}
                                </div>
                                <AttendanceWorkflowSelector
                                    value={setting.attendance_workflow}
                                    onChange={(next) => void handleChange(setting.people_type, next)}
                                    disabled={savingPeopleType === setting.people_type}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>
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