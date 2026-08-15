import React, { useCallback, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  X,
} from "lucide-react";
import { useAuth } from "../../contexts/useAuth";
import { changeOwnPassword } from "../../api/api";
import { toastError, toastSuccess } from "../../utils/notifications";
import { C, ConfigCard, inputStyle } from "../../pages/Settings/Settings";

/**
 * ChangePasswordCard
 * ─────────────────────────────────────────────────────────────────────────
 * Self-service "change my own password" form for the Client Dashboard.
 * Calls changeOwnPassword (api.ts) -> PATCH /api/client/account/password
 * for Supabase-backed accounts, or PATCH /api/users/<id>/profile for
 * legacy SQLite accounts. Both endpoints derive identity from the signed
 * session (JWT) on the request, so no current-password field is needed —
 * see api.ts's changeOwnPassword docstring for the full reasoning.
 *
 * Works for every account type this dashboard supports: client_users
 * (admin/HR) and client_staff (manager/staff, including dashboard_scope
 * sessions) on the Supabase path, and legacy numeric-id SQLite accounts.
 *
 * Password strength rules mirror the backend's single source of truth —
 * validate_strong_password in support_db_client_users.py (also used by
 * support_db_staff.update_client_staff_own_password and the legacy
 * /api/users/<id>/profile route in app.py). If those rules ever change,
 * update PASSWORD_RULES below to match — client and server must agree or
 * a password that passes here can still be rejected there.
 */

interface FieldErrors {
  newPassword?: string;
  confirmPassword?: string;
}

interface FormState {
  newPassword: string;
  confirmPassword: string;
}

const EMPTY_FORM: FormState = {
  newPassword: "",
  confirmPassword: "",
};

interface PasswordRule {
  id: string;
  label: string;
  test: (value: string) => boolean;
}

const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: "At least 8 characters", test: (v) => v.length >= 8 },
  { id: "upper", label: "One uppercase letter", test: (v) => /[A-Z]/.test(v) },
  { id: "lower", label: "One lowercase letter", test: (v) => /[a-z]/.test(v) },
  { id: "digit", label: "One number", test: (v) => /[0-9]/.test(v) },
  {
    id: "special",
    label: "One special character",
    test: (v) => /[^A-Za-z0-9]/.test(v),
  },
];

function firstFailingRuleMessage(value: string): string | undefined {
  const failed = PASSWORD_RULES.find((rule) => !rule.test(value));
  return failed ? `Password needs: ${failed.label.toLowerCase()}.` : undefined;
}

function validateField(
  field: keyof FormState,
  form: FormState,
): string | undefined {
  switch (field) {
    case "newPassword":
      if (!form.newPassword) return "New password is required.";
      return firstFailingRuleMessage(form.newPassword);
    case "confirmPassword":
      if (!form.confirmPassword) return "Please confirm your new password.";
      if (form.confirmPassword !== form.newPassword) {
        return "Passwords do not match.";
      }
      return undefined;
    default:
      return undefined;
  }
}

function validateAll(form: FormState): FieldErrors {
  return {
    newPassword: validateField("newPassword", form),
    confirmPassword: validateField("confirmPassword", form),
  };
}

function errorInputStyle(hasError: boolean): React.CSSProperties {
  return inputStyle(
    hasError ? { borderColor: C.danger, background: "#fef2f2" } : undefined,
  );
}

/** Maps a server-side validation message back onto the specific field it
 * concerns, so a failed submit flags the same field the client-side checks
 * would have — one consistent error surface regardless of whether the
 * check ran on the client or the server. */
function fieldErrorsFromServerMessage(message: string): FieldErrors {
  const lower = message.toLowerCase();
  if (lower.includes("password")) {
    return { newPassword: message };
  }
  return {};
}

function PasswordStrengthChecklist({ value }: { value: string }) {
  return (
    <ul
      style={{
        listStyle: "none",
        margin: "6px 0 0",
        padding: 0,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: "6px 16px",
      }}
    >
      {PASSWORD_RULES.map((rule) => {
        const passed = rule.test(value);
        return (
          <li
            key={rule.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
              fontWeight: 600,
              color: passed ? C.success : C.textSub,
            }}
          >
            {passed ? (
              <Check size={12} strokeWidth={3} color={C.success} />
            ) : (
              <X size={12} strokeWidth={3} color={C.textSub} />
            )}
            {rule.label}
          </li>
        );
      })}
    </ul>
  );
}

function PasswordField({
  label,
  value,
  error,
  touched,
  onChange,
  onBlur,
  autoComplete,
}: {
  label: string;
  value: string;
  error?: string;
  touched: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  autoComplete: string;
}) {
  const [visible, setVisible] = useState(false);
  const showError = touched && !!error;

  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          color: C.textSub,
          fontWeight: 850,
          textTransform: "uppercase",
          letterSpacing: ".05em",
        }}
      >
        {label}
      </span>
      <div style={{ position: "relative" }}>
        <input
          type={visible ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          style={errorInputStyle(showError)}
          aria-invalid={showError || undefined}
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={
            visible
              ? `Hide ${label.toLowerCase()}`
              : `Show ${label.toLowerCase()}`
          }
          tabIndex={-1}
          style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            color: C.textSub,
            cursor: "pointer",
            padding: 4,
            display: "flex",
            alignItems: "center",
          }}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {showError ? (
        <span
          style={{
            fontSize: 11.5,
            color: C.danger,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <AlertCircle size={12} />
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function ChangePasswordCard() {
  const { user, refreshUser } = useAuth();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [touched, setTouched] = useState<Record<keyof FormState, boolean>>({
    newPassword: false,
    confirmPassword: false,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const isStrongEnough = useMemo(
    () => PASSWORD_RULES.every((rule) => rule.test(form.newPassword)),
    [form.newPassword],
  );

  const handleFieldChange = useCallback(
    (field: keyof FormState, value: string) => {
      const nextForm = { ...form, [field]: value };
      setForm(nextForm);
      // Re-validate live once a field has been touched, so a correction is
      // reflected immediately rather than waiting for the next blur/submit.
      if (touched[field]) {
        setErrors((prev) => ({
          ...prev,
          [field]: validateField(field, nextForm),
        }));
      }
      // Confirm-password's validity depends on new-password's value too —
      // keep it in sync whenever either changes and confirm has been touched.
      if (field === "newPassword" && touched.confirmPassword) {
        setErrors((prev) => ({
          ...prev,
          confirmPassword: validateField("confirmPassword", nextForm),
        }));
      }
    },
    [form, touched],
  );

  const handleFieldBlur = useCallback(
    (field: keyof FormState) => {
      setTouched((prev) => ({ ...prev, [field]: true }));
      setErrors((prev) => ({ ...prev, [field]: validateField(field, form) }));
    },
    [form],
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      const nextErrors = validateAll(form);
      setErrors(nextErrors);
      setTouched({
        newPassword: true,
        confirmPassword: true,
      });

      const hasErrors = Object.values(nextErrors).some(Boolean);
      if (hasErrors) return;

      if (!user?.id) {
        toastError(
          "Your session could not be identified. Please sign in again.",
        );
        return;
      }

      setSubmitting(true);
      try {
        await changeOwnPassword(user.id, form.newPassword);
        // Re-pull the session from the backend rather than trusting the
        // response shape — refreshUser is the one existing, already-tested
        // path every other profile mutation on this page uses to keep
        // AuthContext/localStorage in sync after a server-side change (see
        // Settings.tsx's own operational-config save handler).
        if (refreshUser && user.id) await refreshUser(user.id);
        setForm(EMPTY_FORM);
        setTouched({
          newPassword: false,
          confirmPassword: false,
        });
        setErrors({});
        toastSuccess("Password updated successfully.");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to change password.";
        const mapped = fieldErrorsFromServerMessage(message);
        if (Object.keys(mapped).length > 0) {
          setErrors((prev) => ({ ...prev, ...mapped }));
        }
        toastError(message);
      } finally {
        setSubmitting(false);
      }
    },
    [form, user, refreshUser],
  );

  return (
    <ConfigCard icon={<KeyRound size={18} />} title="Change Password">
      <form onSubmit={handleSubmit} noValidate>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <PasswordField
            label="New Password"
            value={form.newPassword}
            error={errors.newPassword}
            touched={touched.newPassword}
            onChange={(value) => handleFieldChange("newPassword", value)}
            onBlur={() => handleFieldBlur("newPassword")}
            autoComplete="new-password"
          />
          <PasswordField
            label="Confirm New Password"
            value={form.confirmPassword}
            error={errors.confirmPassword}
            touched={touched.confirmPassword}
            onChange={(value) => handleFieldChange("confirmPassword", value)}
            onBlur={() => handleFieldBlur("confirmPassword")}
            autoComplete="new-password"
          />
        </div>

        {form.newPassword ? (
          <div style={{ marginTop: 10 }}>
            <PasswordStrengthChecklist value={form.newPassword} />
          </div>
        ) : null}

        <div style={{ marginTop: 16 }}>
          <button
            type="submit"
            disabled={submitting || (!!form.newPassword && !isStrongEnough)}
            style={{
              minHeight: 42,
              border: "none",
              borderRadius: 10,
              padding: "0 16px",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              background: C.primary,
              color: "#fff",
              fontSize: 13,
              fontWeight: 900,
              cursor: submitting ? "not-allowed" : "pointer",
              opacity:
                submitting || (!!form.newPassword && !isStrongEnough) ? 0.7 : 1,
              fontFamily: "inherit",
            }}
          >
            {submitting ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <KeyRound size={15} />
            )}
            {submitting ? "Updating…" : "Update Password"}
          </button>
        </div>
      </form>
    </ConfigCard>
  );
}

export default ChangePasswordCard;
