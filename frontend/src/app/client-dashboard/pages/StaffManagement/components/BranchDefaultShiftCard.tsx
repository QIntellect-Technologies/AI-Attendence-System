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
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { type FC, useEffect, useMemo, useState } from "react";
import { Save } from "lucide-react";
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

// The PATCH route resets both grace overrides to NULL when they're omitted,
// so they're read alongside the shift id and sent back unchanged. Without
// this, changing the default shift would silently wipe existing overrides.
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
}> = ({
    apiBranchId,
    organizationId,
    peopleType,
    personPlural,
    shifts,
    isLoadingShifts,
}) => {
        const [saved, setSaved] = useState<DefaultShiftState>(EMPTY_STATE);
        const [draftShiftId, setDraftShiftId] = useState("");
        const [isLoading, setIsLoading] = useState(false);
        const [isSaving, setIsSaving] = useState(false);
        const [loadError, setLoadError] = useState<string | null>(null);

        const activeShifts = useMemo(
            () => shifts.filter((shift) => shift.is_active !== false),
            [shifts],
        );

        // `shifts` is a dependency on purpose: deleting a shift clears it as a
        // default on the server, so a shift reload must re-read the saved value.
        useEffect(() => {
            if (!apiBranchId || !organizationId) {
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
                    setSaved(next);
                    setDraftShiftId(next.shiftId);
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
        const isDirty = draftShiftId !== saved.shiftId;
        const isBusy = isLoading || isLoadingShifts || isSaving;
        const canSave = !!draftShiftId && isDirty && !isBusy && !!apiBranchId;

        const handleSave = async () => {
            if (!canSave || !apiBranchId || !organizationId) return;
            setIsSaving(true);
            try {
                await setBranchDefaultShift(apiBranchId, peopleType, organizationId, {
                    shift_id: draftShiftId,
                    check_in_grace_override: saved.checkInGrace,
                    check_out_grace_override: saved.checkOutGrace,
                });
                setSaved((prev) => ({ ...prev, shiftId: draftShiftId }));
                toastSuccess(`Default shift saved for ${personPlural}.`);
            } catch (error) {
                toastError(errorMessage(error, "Failed to save the default shift."));
            } finally {
                setIsSaving(false);
            }
        };

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
                        onClick={handleSave}
                        disabled={!canSave}
                    />
                </div>
            </div>
        );
    };