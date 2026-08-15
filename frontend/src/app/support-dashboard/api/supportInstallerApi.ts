/**
 * supportInstallerApi.ts
 * Optional frontend helper for Support Branch Management.
 *
 * Call this from the branch row button instead of showing the raw token.
 * It downloads the installer ZIP returned by:
 * POST /v1/support/organizations/:orgId/branches/:branchId/installer
 */

export async function downloadBranchNodeInstaller(params: {
  apiBaseUrl?: string;
  supportToken: string;
  orgId: string;
  branchId: string;
  nodeLabel?: string;
  ttlDays?: number;
  usePublicIp?: boolean;
}) {
  const base = (params.apiBaseUrl || "").replace(/\/$/, "");
  const response = await fetch(
    `${base}/v1/support/organizations/${encodeURIComponent(params.orgId)}/branches/${encodeURIComponent(params.branchId)}/installer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.supportToken}`,
      },
      body: JSON.stringify({
        node_label: params.nodeLabel,
        ttl_days: params.ttlDays ?? 7,
        use_public_ip: params.usePublicIp ?? false,
        api_base_url: base || window.location.origin,
      }),
    },
  );

  if (!response.ok) {
    let message = `Installer download failed (${response.status})`;
    try {
      const body = await response.json();
      message = body.message || body.error || message;
    } catch {
      message = await response.text();
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8'')?[\"]?([^\";]+)/i);
  const filename = decodeURIComponent(match?.[1] || "qintellect-node-installer.zip");

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
