import React, { useState } from "react";
import { Download, GitBranch } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useInstallToken } from "../../hooks/useInstallToken";
import InstallTokenModal from "../../components/InstallTokenModal";
import { SupportPageShell } from "../../components/SupportPageShell";
import { SupportToolbar } from "../../components/SupportToolbar";
import {
  SupportTable,
  type SupportColumn,
} from "../../components/SupportTable";
import { SupportPagination } from "../../components/SupportPagination";
import { SupportStatusBadge } from "../../components/SupportStatusBadge";
import { SupportErrorBanner } from "../../components/SupportErrorBanner";
import { useBranchesPage } from "./hooks/useBranchesPage";
import { branchesPageApi, type GlobalBranchRow } from "./api/branchesApi";

const isLocalAttendance = (value?: string | null): boolean =>
  String(value || "")
    .trim()
    .toLowerCase() === "local";

export default function BranchesPage() {
  const nav = useNavigate();
  const state = useBranchesPage();
  const { token, isGenerating, error: tokenError, generate, clear } = useInstallToken(
    (orgId, branchId) => branchesPageApi.createInstallToken(orgId, branchId),
  );
  const [generatingBranchId, setGeneratingBranchId] = React.useState<string | null>(null);

  const handleGenerateToken = async (branch: GlobalBranchRow) => {
    if (!isLocalAttendance(branch.attendance_mode)) return;
    setGeneratingBranchId(branch.id);
    await generate(branch.org_id, branch.branch_id || branch.id);
    setGeneratingBranchId(null);
  };

  const actionStyle: React.CSSProperties = {
    border: "1px solid #dbe4ef",
    background: "#fff",
    borderRadius: 9,
    padding: "7px 10px",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  }
}
