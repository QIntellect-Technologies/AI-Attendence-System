import { BASE_URL, dashboardAuthHeaders } from "../../../api/api";
import { handleSessionExpired } from "../../../api/sessionExpired";
import { cleanId } from "../../../utils/tenantScope";

export interface DownloadNodeInstallerParams {
  branchId: number | string;
  userId: number | string;
  nodeLabel?: string;
  ttlDays?: number;
  packageType?: "exe" | "zip";
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) return decodeURIComponent(utf8[1].replace(/"/g, ""));
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain?.[1] ? plain[1] : null;
}

async function errorFromResponse(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      return new Error(parsed.message || parsed.error || text);
    } catch {
      return new Error(text);
    }
  }
  return new Error(`Request failed: ${response.status} ${response.statusText}`);
}

export async function downloadClientNodeInstaller({
  branchId,
  userId,
  nodeLabel,
  ttlDays = 7,
  packageType = "exe",
}: DownloadNodeInstallerParams): Promise<void> {
  const cleanBranchId = cleanId(branchId);
  const cleanUserId = cleanId(userId);

  if (!cleanBranchId) throw new Error("branchId is required");
  if (!cleanUserId) throw new Error("userId is required");

  const response = await fetch(
    `${BASE_URL}/api/client/branches/${encodeURIComponent(cleanBranchId)}/node-installer`,
    {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/octet-stream, application/json",
        "Content-Type": "application/json",
        // The backend derives the acting user from this token alone
        // (@require_client_dashboard_auth -> g.dashboard_user). Without it
        // the route 401s with "Authorization header required" before any
        // installer is built. X-Client-User-Id below is advisory/legacy
        // only — it is deliberately ignored server-side.
        ...dashboardAuthHeaders(),
        "X-Client-User-Id": cleanUserId,
      },
      body: JSON.stringify({
        user_id: cleanUserId,
        ttl_days: ttlDays,
        node_label: nodeLabel,
        package_type: packageType,
      }),
    },
  );

  if (!response.ok) {
    const error = await errorFromResponse(response);
    // Same convention as staffApi/apiClient: a 401 here means the stored
    // dashboard token is missing or expired, so prompt a re-login rather
    // than showing a raw auth string in the branch error banner.
    if (response.status === 401) {
      handleSessionExpired(error.message);
    }
    throw error;
  }

  const blob = await response.blob();
  const contentDisposition = response.headers.get("content-disposition");
  const filename =
    filenameFromContentDisposition(contentDisposition) ||
    `QIntellectAttendanceNodeSetup-${cleanBranchId}.${packageType}`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}