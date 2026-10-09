import React, { useEffect, useState } from "react";
import { Building2, UserCircle2 } from "lucide-react";
import { Avatar } from "../../components/ui/Avatar";
import { OrgLogoCard } from "../../components/ui/OrgLogoCard";
import { useOrg } from "../../contexts/OrgConfigContext";
import { useAuth } from "../../contexts/useAuth";
import { ChangePasswordCard } from "../../components/ui/ChangePasswordCard";
import { C, ConfigCard, ReadOnlyLine } from "../Settings/Settings";
import { loadClientBootstrap } from "../../services/clintApi";
import "./AccountSettings.css";

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
 *
 * Exception: the Organization Profile card below is intentionally
 * read-only. It surfaces the same org-level fields Settings.tsx's
 * ProfileSettingsEditor edits, but every authenticated user (including
 * staff without the "settings" module grant) reaches this page, so this
 * card must never expose editing here — that stays exclusively on
 * Settings.tsx, behind its module gate.
 */

type AccountOrgBootstrap = {
  organization?: {
    name?: string;
    status?: string;
    attendance_mode?: string;
    attendanceMode?: string;
    contact_phone?: string;
  };
  branches?: unknown[];
  config?: Record<string, unknown>;
  onboarding_config?: Record<string, unknown>;
  onboardingConfig?: Record<string, unknown>;
};

interface OrgProfileSummary {
  name: string;
  status: string;
  attendanceMode: string;
  branchCount: number;
  address: string;
  city: string;
  phone: string;
  timezone: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOrDash(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "—";
}

// Mirrors the field-resolution order Settings.tsx's configFromBootstrap()
// uses for company_profile, kept intentionally smaller here since this
// card only displays values — it never saves.
function extractOrgProfileSummary(
  data: AccountOrgBootstrap,
): OrgProfileSummary {
  const org = data.organization ?? {};
  const savedConfig = asRecord(
    data.onboarding_config || data.onboardingConfig || data.config,
  );
  const profile = asRecord(
    savedConfig.company_profile ?? savedConfig.companyProfile,
  );
  const rawConfig = asRecord(data.config);

  return {
    name: textOrDash(org.name),
    status: textOrDash(org.status),
    attendanceMode: textOrDash(
      org.attendance_mode || org.attendanceMode,
    ).toUpperCase(),
    branchCount: Array.isArray(data.branches) ? data.branches.length : 0,
    address: textOrDash(profile.address ?? rawConfig.address),
    city: textOrDash(profile.city ?? rawConfig.city),
    phone: textOrDash(
      profile.publicContactPhone ||
      profile.public_contact_phone ||
      rawConfig.publicContactPhone ||
      org.contact_phone,
    ),
    timezone: textOrDash(profile.timezone ?? rawConfig.timezone),
  };
}

type AuthRecord = Record<string, unknown> | null | undefined;

/** First non-empty string among the given keys (payloads mix snake/camel case). */
function pickText(record: AuthRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Rows that have no value for this account type (e.g. the org owner has no
 * designation) are dropped instead of rendering a column of dashes. */
function buildProfileRows(user: AuthRecord) {
  return [
    { label: "Name", value: pickText(user, "name") },
    { label: "Email", value: pickText(user, "email") },
    {
      label: pickText(user, "personCodeLabel", "person_code_label") || "Person Code",
      value: pickText(user, "personCode", "person_code", "employeeId", "employee_id"),
    },
    { label: "Designation", value: pickText(user, "designationName", "designation_name", "designation") },
    { label: "Department", value: pickText(user, "department", "department_name") },
    { label: "Branch", value: pickText(user, "branchName", "branch_name") },
    { label: "Phone", value: pickText(user, "phone") },
    { label: "Role", value: pickText(user, "role").toUpperCase() },
  ].filter((row) => row.value);
}

export default function AccountSettings() {
  const { user } = useAuth();
  const { cfg } = useOrg();
  // Same `|| ""` widening pattern AdminLayout.tsx already uses for these
  // pass-through (index-signature) fields — kept consistent rather than
  // introducing a different cast here.
  const displayName = (user?.name as string) || (user?.email as string) || "";
  const organizationId = user?.organization_id || user?.organizationId;

  const profileRows = buildProfileRows(user as AuthRecord);

  // Company branding is an admin action; everyone else's photo is managed in
  // Staff Management, so nothing on this page edits a person's own image.
  const canManageOrgLogo = pickText(user as AuthRecord, "role").toLowerCase() === "admin";

  const photo = pickText(user as AuthRecord, "profileImageUrl", "avatarUrl", "photo_url");

  const [orgProfile, setOrgProfile] = useState<OrgProfileSummary | null>(
    null,
  );

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;

    loadClientBootstrap<AccountOrgBootstrap>(organizationId)
      .then((data) => {
        if (!cancelled) setOrgProfile(extractOrgProfileSummary(data));
      })
      .catch(() => {
        // Read-only display card — a failed fetch just means the card
        // stays hidden. The editable source of truth (Settings.tsx)
        // already surfaces load errors where they're actionable.
      });

    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  return (
    <div
      className="my-account-page"
      style={{
        minHeight: "100%",
        background: C.bg,
        padding: 28,
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      <div
        className="my-account-page__content"
        style={{ maxWidth: 720, margin: "0 auto" }}
      >
        <div
          className="my-account-page__header"
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

        <div
          className="my-account-page__cards"
          style={{ display: "grid", gap: 18 }}
        >
          <ConfigCard icon={<UserCircle2 size={18} />} title="My Profile">
            <div
              className="my-account-page__identity"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                marginBottom: 18,
              }}
            >
              <Avatar src={photo} label={displayName || "User"} size={72} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: C.primary }}>
                  {displayName || "—"}
                </div>
              </div>
            </div>
            <div
              className="my-account-page__details"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 14,
              }}
            >
              {profileRows.map((row) => (
                <ReadOnlyLine key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
          </ConfigCard>
          {orgProfile && (
            <ConfigCard
              icon={<Building2 size={18} />}
              title="Organization Profile"
            >
              <div
                className="my-account-page__identity"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  marginBottom: 18,
                }}
              >
                {canManageOrgLogo ? (
                  <OrgLogoCard />
                ) : (
                  <Avatar
                    src={cfg.logo}
                    label={orgProfile.name}
                    size={44}
                    shape="rounded"
                    fit="contain"
                  />
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 14,
                  marginBottom: 14,
                }}
              >
                <ReadOnlyLine label="Organization" value={orgProfile.name} />
                <ReadOnlyLine label="Status" value={orgProfile.status} />
                <ReadOnlyLine
                  label="Attendance Mode"
                  value={orgProfile.attendanceMode}
                />
                <ReadOnlyLine
                  label="Branches"
                  value={String(orgProfile.branchCount)}
                />
              </div>
              <div
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
              >

              </div>
            </ConfigCard>
          )}
          <ChangePasswordCard />
        </div>
      </div>
    </div>
  );
}