import React, { useState } from "react";
import { X, Copy, CheckCircle2, KeyRound } from "lucide-react";
import type { InstallTokenResult } from "../hooks/useInstallToken";

interface Props {
    token: InstallTokenResult;
    onClose: () => void;
}

export default function InstallTokenModal({ token, onClose }: Props) {
    const [copied, setCopied] = useState(false);

    const copyToken = async () => {
        try {
            await navigator.clipboard.writeText(token.install_token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard API may be blocked; token is still visible to select manually.
        }
    };

    const expiresLabel = new Date(token.expires_at).toLocaleString();

    return (
        <div style={overlay} onClick={onClose}>
            <div style={card} onClick={(e) => e.stopPropagation()}>
                <div style={header}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <KeyRound size={18} color="#0d9488" />
                        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 900, color: "#134471" }}>
                            Install Token Generated
                        </h3>
                    </div>
                    <button type="button" onClick={onClose} style={closeBtn}>
                        <X size={16} />
                    </button>
                </div>

                <p style={{ margin: "10px 0 14px", fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                    Send this token to <strong>{token.organization_name}</strong> ({token.branch_name}).
                    They will paste it into the Local Node activation screen. This token is shown
                    only once and cannot be retrieved again — generate a new one if it's lost.
                </p>

                <div style={tokenBox}>
                    <code style={{ wordBreak: "break-all", fontSize: 13, color: "#134471" }}>
                        {token.install_token}
                    </code>
                </div>

                <button type="button" onClick={copyToken} style={copyBtn}>
                    {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                    {copied ? "Copied" : "Copy token"}
                </button>

                <div style={{ marginTop: 14, fontSize: 11, color: "#92400e", fontWeight: 700 }}>
                    Expires: {expiresLabel} · Single use only
                </div>
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
    width: 460,
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

const tokenBox: React.CSSProperties = {
    background: "#f0fdfa",
    border: "1px solid #99f6e4",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
};

const copyBtn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    border: "none",
    background: "#0d9488",
    color: "#fff",
    borderRadius: 9,
    padding: "8px 14px",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
};