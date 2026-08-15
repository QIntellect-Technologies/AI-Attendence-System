import React from "react";
import { UserCircle2 } from "lucide-react";
import { useAuth } from "../../contexts/useAuth";
import { ChangePasswordCard } from "../../components/ui/ChangePasswordCard";
import { C } from "../Settings/Settings";

/**
 * AccountSettings
 * ─────────────────────────────────────────────────────────────────────────
 * "My Account" — personal, self-service account settings for the currently
 * logged-in user. Deliberately separate from Settings.tsx ("Dashboard
 * Setup"), which is org-level configuration gated behind the "settings"
 * module grant.
 *
 * That gate is the whole reason this page exists: a staff/manager account
 * without the settings module grant can still change their own password —
 * that's a "who am I" action, not a "configure the organization" one, and
 * it shouldn't require a permission meant for the latter. Every
 * authenticated dashboard user (admin, HR, staff, manager — any account
 * type this dashboard supports) reaches this page the same way, via the
 * "My Account" button in AdminLayout.tsx's header, which is never
 * conditionally hidden the way the Dashboard Setup gear icon is.
 *
 * Add future self-only account settings here (e.g. a name/email/phone
 * editor) — never in Settings.tsx, to keep that module-gated screen
 * strictly organization-level.
 */
export default function AccountSettings() {
  const { user } = useAuth();
  // Same `|| ""` widening pattern AdminLayout.tsx already uses for these
  // pass-through (index-signature) fields — kept consistent rather than
  // introducing a different cast here.
  const displayName = (user?.name as string) || (user?.email as string) || "";

  return (
    <div
      style={{
        minHeight: "100%",
        background: C.bg,
        padding: 28,
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 22,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: C.tealPale,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <UserCircle2 size={24} color={C.primary} />
          </div>
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 24,
                color: C.primary,
                fontWeight: 950,
                letterSpacing: "-.03em",
              }}
            >
              My Account
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>
              {displayName
                ? `Signed in as ${displayName}`
                : "Your personal account settings."}
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          <ChangePasswordCard />
        </div>
      </div>
    </div>
  );
}
