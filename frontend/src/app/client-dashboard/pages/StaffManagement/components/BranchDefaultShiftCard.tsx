/**
 * pages/StaffManagement/components/BranchDefaultShiftCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The branch's default shift for ONE people type. Anyone without a personal
 * (or department) shift falls back to this, so every person always resolves to
 * a shift window.
 *
 * Reads/writes through the existing client routes:
 *   GET   /branches/<id>/capture-settings/<people_type>  -> default_shift_id
 *   PATCH /branches/<id>/default-shift/<people_type>     -> set it
 *
 * When force_override=true the backend also bulk-sets shift_id_ref on every
 * staff member in that branch, giving the default shift "parent authority"
 * over any individual-level allocation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { type FC, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Save, ShieldCheck } from "lucide-react";
import { toastError, toastSuccess } from "../../../utils/notifications";
import { T } from "../../../components/ui/theme";
import ModernSelect from "../../../components/ui/ModernSelect";
import { ActionButton } from "../../engine/ModuleShell";
import {
    getCaptureSettings,
    setBranchDefaultShift,
    type ShiftRecord,
} from "../api/attendanceSettingsApi";
import { formatShiftWindow } from "../utils/shiftOverlap";

// ─── Types ────────────────────────────────────────────────────────────────────

type DefaultShiftState = {
    shiftId: string;
    checkInGrace: number | null;
    checkOutGrace: number | null;
};

const EMPTY_STATE: DefaultShiftState = {
    shiftId: "",
    checkInGrace: null,
    checkOutGrace: null,
};

const errorMessage = (error: unknown, fallback: string): string =>
    error instanceof Error ? error.message : fallback;

// ─── Confirmation Modal ───────────────────────────────────────────────────────

const ConfirmModal: FC<{
    shiftLabel: string;
    personPlural: string;
    onConfirm: (forceOverride: boolean) => void;
    onCancel: () => void;
}> = ({ shiftLabel, personPlural, onConfirm, onCancel }) => {
    const overlayRef = useRef<HTMLDivElement>(null);

    // Close on backdrop click
    const handleOverlayClick = (e: React.MouseEvent) => {
        if (e.target === overlayRef.current) onCancel();
    };

    return createPortal(
        <div
            ref={overlayRef}
            onClick={handleOverlayClick}
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 9999,
                background: "rgba(15, 23, 42, 0.55)",
                backdropFilter: "blur(4px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                animation: "fadeIn 0.18s ease",
            }}
        >
            <style>{`
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes slideUp { from { opacity: 0; transform: translateY(18px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
                .bds-btn { transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease; }
                .bds-btn:hover { transform: translateY(-1px); }
                .bds-btn:active { transform: translateY(0); }
                .bds-btn:focus-visible { outline: 2px solid ${T.teal500}; outline-offset: 2px; }
                .bds-cancel:hover { background: ${T.slate100} !important; color: ${T.head} !important; }
                .bds-secondary:hover { background: ${T.teal50} !important; border-color: ${T.teal600} !important; }
                .bds-primary:hover { box-shadow: 0 6px 16px rgba(23,63,103,0.32) !important; }
            `}</style>
            <div
                style={{
                    background: T.card,
                    borderRadius: 20,
                    padding: "28px 28px 24px",
                    maxWidth: 480,
                    width: "calc(100% - 32px)",
                    boxShadow: "0 24px 64px rgba(15,23,42,0.22), 0 4px 16px rgba(15,23,42,0.10)",
                    animation: "slideUp 0.22s ease",
                    border: `1px solid ${T.border}`,
                }}
            >
                {/* Icon + Title */}
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 16 }}>
                    <div
                        style={{
                            width: 44,
                            height: 44,
                            borderRadius: 12,
                            background: `linear-gradient(135deg, ${T.teal100} 0%, ${T.teal200} 100%)`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                        }}
                    >
                        <AlertTriangle size={22} color={T.teal700} />
                    </div>
                    <div>
                        <div style={{ fontSize: 15, fontWeight: 900, color: T.head, lineHeight: 1.3 }}>
                            Apply Branch Default Shift?
                        </div>
                        <div style={{ fontSize: 12, color: T.muted, marginTop: 4, lineHeight: 1.5 }}>
                            You're setting <strong style={{ color: T.head }}>{shiftLabel}</strong> as the default shift for all {personPlural}.
                        </div>
                    </div>
                </div>

                {/* Divider */}
                <div style={{ height: 1, background: T.border, margin: "0 0 16px" }} />

                {/* Options */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                    {/* Option A — set default only */}
                    <div
                        style={{
                            padding: "12px 14px",
                            borderRadius: 12,
                            border: `1.5px solid ${T.border}`,
                            background: T.slate50,
                        }}
                    >
                        <div style={{ fontSize: 12, fontWeight: 800, color: T.head, marginBottom: 3 }}>
                            Set as fallback default only
                        </div>
                        <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>
                            This shift will apply to {personPlural} who have <em>no personal shift</em> assigned.
                            Existing individual allocations are kept unchanged.
                        </div>
                    </div>

                    {/* Option B — force override all */}
                    <div
                        style={{
                            padding: "12px 14px",
                            borderRadius: 12,
                            border: `1.5px solid ${T.teal200}`,
                            background: T.teal50,
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                            <ShieldCheck size={13} color={T.teal700} />
                            <span style={{ fontSize: 12, fontWeight: 800, color: T.navy700 }}>
                                Override everyone (parent authority)
                            </span>
                        </div>
                        <div style={{ fontSize: 11, color: T.body, lineHeight: 1.5 }}>
                            This shift will be assigned directly to <strong>all</strong> {personPlural},
                            replacing any individual-level shift allocations. <strong style={{ color: T.navy700 }}>This action cannot be undone automatically.</strong>
                        </div>
                    </div>
                </div>

                {/* Action buttons */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        flexWrap: "wrap",
                    }}
                >
                    <button
                        type="button"
                        className="bds-btn bds-cancel"
                        onClick={onCancel}
                        style={{
                            height: 40,
                            padding: "0 16px",
                            borderRadius: 10,
                            border: "1px solid transparent",
                            background: "transparent",
                            color: T.muted,
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            whiteSpace: "nowrap",
                        }}
                    >
                        Cancel
                    </button>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                            type="button"
                            className="bds-btn bds-secondary"
                            onClick={() => onConfirm(false)}
                            style={{
                                height: 40,
                                padding: "0 18px",
                                borderRadius: 10,
                                border: `1.5px solid ${T.teal500}`,
                                background: T.card,
                                color: T.teal700,
                                fontSize: 12,
                                fontWeight: 800,
                                cursor: "pointer",
                                fontFamily: "inherit",
                                whiteSpace: "nowrap",
                            }}
                        >
                            Set as Default Only
                        </button>
                        <button
                            type="button"
                            className="bds-btn bds-primary"
                            onClick={() => onConfirm(true)}
                            style={{
                                height: 40,
                                padding: "0 18px",
                                borderRadius: 10,
                                border: "none",
                                background: `linear-gradient(135deg, ${T.navy600} 0%, ${T.navy700} 100%)`,
                                color: "#fff",
                                fontSize: 12,
                                fontWeight: 800,
                                cursor: "pointer",
                                fontFamily: "inherit",
                                whiteSpace: "nowrap",
                                boxShadow: "0 2px 8px rgba(23,63,103,0.28)",
                            }}
                        >
                            Override All {personPlural.charAt(0).toUpperCase() + personPlural.slice(1)}
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
};

// ─── Main Card ────────────────────────────────────────────────────────────────

export const BranchDefaultShiftCard: FC<{
    /** Real backend branch UUID (resolveApiBranchId), not the UI ordinal id. */
    apiBranchId: string | null;
    organizationId: number | string | null;
    peopleType: string;
    /** Lower-case plural for copy, e.g. "students". */
    personPlural: string;
    /** Already loaded by the parent for this branch + people type. */
    shifts: ShiftRecord[];
    isLoadingShifts: boolean;
    /** Called after a successful force-override so the parent can refresh the staff list. */
    onForceOverrideComplete?: () => void;
}> = ({
    apiBranchId,
    organizationId,
    peopleType,
    personPlural,
    shifts,
    isLoadingShifts,
    onForceOverrideComplete,
}) => {
        const [saved, setSaved] = useState<DefaultShiftState>(EMPTY_STATE);
        const [draftShiftId, setDraftShiftId] = useState("");
        const [isLoading, setIsLoading] = useState(false);
        const [isSaving, setIsSaving] = useState(false);
        const [loadError, setLoadError] = useState<string | null>(null);
        const [showConfirm, setShowConfirm] = useState(false);
        // Lets the load effect tell "branch / people type changed" apart from "the
        // shifts list was just refreshed", and compare against the last saved
        // value without making `saved` an effect dependency.
        const savedRef = useRef<DefaultShiftState>(EMPTY_STATE);
        const scopeKeyRef = useRef("");

        useEffect(() => {
            savedRef.current = saved;
        }, [saved]);

        const activeShifts = useMemo(
            () => shifts.filter((shift) => shift.is_active !== false),
            [shifts],
        );

        useEffect(() => {
            if (!apiBranchId || !organizationId) {
                scopeKeyRef.current = "";
                setSaved(EMPTY_STATE);
                setDraftShiftId("");
                return;
            }
            let cancelled = false;
            setIsLoading(true);
            setLoadError(null);
            getCaptureSettings(apiBranchId, peopleType, organizationId)
                .then((row) => {
                    if (cancelled) return;
                    const next: DefaultShiftState = {
                        shiftId: row?.default_shift_id ?? "",
                        checkInGrace: row?.default_check_in_grace_override ?? null,
                        checkOutGrace: row?.default_check_out_grace_override ?? null,
                    };
                    const scopeKey = `${apiBranchId}:${peopleType}`;
                    const scopeChanged = scopeKeyRef.current !== scopeKey;
                    scopeKeyRef.current = scopeKey;
                    const previousSaved = savedRef.current.shiftId;
                    setSaved(next);
                    // Reset the picker when the branch / people type changes, or
                    // when the user hasn't changed it. A reload caused only by the
                    // shifts list refreshing must not wipe a pick they're midway
                    // through making.
                    setDraftShiftId((current) =>
                        scopeChanged || !current || current === previousSaved
                            ? next.shiftId
                            : current,
                    );
                })
                .catch((error) => {
                    if (cancelled) return;
                    setSaved(EMPTY_STATE);
                    setDraftShiftId("");
                    setLoadError(errorMessage(error, "Failed to load the default shift."));
                })
                .finally(() => {
                    if (!cancelled) setIsLoading(false);
                });
            return () => {
                cancelled = true;
            };
        }, [apiBranchId, organizationId, peopleType, shifts]);

        const hasDefault = activeShifts.some((shift) => shift.id === saved.shiftId);
        const isBusy = isLoading || isLoadingShifts || isSaving;
        // Deliberately NOT gated on "the picker differs from the saved default".
        // The saved default can be set without being applied to existing people
        // ("Set as Default Only"); the admin must still be able to come back later,
        // reopen this dialog and choose "Override All" for that same shift.
        const canSave = !!draftShiftId && !isBusy && !!apiBranchId;

        const doSave = async (forceOverride: boolean) => {
            if (!canSave || !apiBranchId || !organizationId) return;
            setShowConfirm(false);
            setIsSaving(true);
            try {
                await setBranchDefaultShift(apiBranchId, peopleType, organizationId, {
                    shift_id: draftShiftId,
                    check_in_grace_override: saved.checkInGrace,
                    check_out_grace_override: saved.checkOutGrace,
                    force_override: forceOverride,
                });
                setSaved((prev) => ({ ...prev, shiftId: draftShiftId }));
                if (forceOverride) {
                    toastSuccess(`Default shift saved and applied to all ${personPlural}.`);
                    // Notify parent to refresh the staff list so shifts show updated values
                    onForceOverrideComplete?.();
                } else {
                    toastSuccess(`Default shift saved for ${personPlural}.`);
                }
            } catch (error) {
                toastError(errorMessage(error, "Failed to save the default shift."));
            } finally {
                setIsSaving(false);
            }
        };

        const handleSaveClick = () => {
            if (!canSave) return;
            setShowConfirm(true);
        };

        const draftShift = activeShifts.find((s) => s.id === draftShiftId);
        const shiftLabel = draftShift
            ? `${draftShift.name} (${formatShiftWindow(draftShift)})`
            : "selected shift";

        const status = (() => {
            if (loadError) return { text: loadError, warn: true };
            if (activeShifts.length === 0 && !isBusy) {
                return {
                    text: "Create at least one shift in Shift Timings first.",
                    warn: true,
                };
            }
            if (!hasDefault && !isBusy) {
                return {
                    text: `No default shift set. Any of your ${personPlural} without a personal shift has no timings until one is chosen.`,
                    warn: true,
                };
            }
            return {
                text: `Applies to ${personPlural} who have no personal shift.`,
                warn: false,
            };
        })();

        return (
            <>
                {showConfirm && (
                    <ConfirmModal
                        shiftLabel={shiftLabel}
                        personPlural={personPlural}
                        onConfirm={doSave}
                        onCancel={() => setShowConfirm(false)}
                    />
                )}

                <div
                    style={{
                        background: T.card,
                        border: `1px solid ${status.warn ? "#fecdd3" : T.border}`,
                        borderRadius: 16,
                        padding: 16,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 16,
                        flexWrap: "wrap",
                        boxShadow: "0 1px 3px rgba(15,45,74,0.06),0 1px 2px rgba(15,45,74,0.04)",
                    }}
                >
                    <div style={{ minWidth: 220, flex: "1 1 260px" }}>
                        <div style={{ fontSize: 15, fontWeight: 900, color: T.head }}>
                            Branch Default Shift
                        </div>
                        <div
                            style={{
                                fontSize: 12,
                                color: status.warn ? "#e11d48" : T.muted,
                                marginTop: 3,
                            }}
                        >
                            {status.text}
                        </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <ModernSelect
                            value={draftShiftId}
                            onChange={setDraftShiftId}
                            options={activeShifts.map((shift) => ({
                                value: shift.id,
                                label: `${shift.name} (${formatShiftWindow(shift)})`,
                            }))}
                            placeholder="Select default shift"
                            ariaLabel="Select branch default shift"
                            minWidth={260}
                            disabled={isBusy || activeShifts.length === 0 || !apiBranchId}
                        />
                        <ActionButton
                            label={isSaving ? "Saving…" : "Save Default"}
                            Icon={Save}
                            onClick={handleSaveClick}
                            disabled={!canSave}
                        />
                    </div>
                </div>
            </>
        );
    };