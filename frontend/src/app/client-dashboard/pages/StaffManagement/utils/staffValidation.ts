/**
 * modules/staff/utils/staffValidation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Field validation for the staff form — email/phone/CNIC rules and the
 * whole-form gate. Single source of truth for both the inline field errors
 * and the Save button's enabled state.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type StaffFormData } from "../types/staffForm";

// ─── Form field validation ────────────────────────────────────────────────
// Single source of truth for "is this email/phone usable as a login
// identifier" — used for both live inline field errors and the Save gate,
// so the two can never disagree. Email is normalized to lowercase at the
// point of entry (see the input's onChange below) rather than only at
// login time, because _find_active_client_staff_row on the backend matches
// client_staff.email case-sensitively; normalizing here is what keeps the
// login this row was created for actually working regardless of that gap.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidEmail = (value: string): boolean =>
  EMAIL_PATTERN.test(value);

// Accepts digits with optional leading +, spaces, and dashes; validates on
// digit count (7-15, E.164-ish) rather than raw string length so
// "0300-123-4567" and "0300 123 4567" are both valid but "abc1234" is not.
export const PHONE_CHARS_PATTERN = /^\+?[\d\s-]+$/;

export const isValidPhone = (value: string): boolean => {
  if (!PHONE_CHARS_PATTERN.test(value)) return false;
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15;
};

// CNIC (Pakistani national ID): 13 digits, conventionally displayed as
// 5-7-1 dash-grouped (e.g. 42101-1234567-1). Accepts either the dashed
// display format or 13 bare digits, same "digit count, not raw string
// length" approach as isValidPhone above so both forms validate the same
// way.
export const CNIC_CHARS_PATTERN = /^[\d-]+$/;

export const isValidCnic = (value: string): boolean => {
  if (!CNIC_CHARS_PATTERN.test(value)) return false;
  return value.replace(/\D/g, "").length === 13;
};

// Mirror of _validate_person_name() in backend/support_db_staff.py. The
// backend remains the authority — anything typed here can be bypassed by
// posting to the API directly — but validating in the form means the person
// gets told immediately instead of after a round trip.
//
// Keep the two in sync: same allow-list, same length bounds, same rejection
// of digits and of leading =, +, - or @ (which Excel and Sheets execute as a
// formula when the exported sheet is opened).
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 100;

// UX-only `maxLength` guards for the rest of the staff form. The backend
// (support_db_staff.py) is the real boundary; these just stop the person
// from typing/pasting past the limit in the first place, and let the field
// show a live "n / max" count where useful.
export const PHONE_MAX_LENGTH = 20;
export const EMAIL_MAX_LENGTH = 254; // RFC 5321 max mailbox length
export const CNIC_MAX_LENGTH = 15; // 13 digits + 2 dashes, dashed format
export const PERSON_CODE_MAX_LENGTH = 30;
export const GEOFENCE_LABEL_MAX_LENGTH = 150;
export const WIFI_SSID_MAX_LENGTH = 32; // 802.11 SSID hard limit
export const WIFI_BSSID_MAX_LENGTH = 17; // AA:BB:CC:DD:EE:FF
export const BENEFIT_ITEM_MAX_LENGTH = 60;
export const SALARY_MIN = 1;
export const SALARY_MAX = 100_000_000;

// \p{L} letters and \p{M} combining marks keep Urdu/Arabic/Chinese names
// working; \w would have let digits and underscore back in.
const NAME_ALLOWED_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s\-'\u2019.,]*$/u;
const NAME_HAS_LETTER = /[\p{L}]/u;
const NAME_HAS_DIGIT = /\d/u;
const FORMULA_PREFIXES = ["=", "+", "-", "@"];

// XSS & SQL injection pattern detection — reject common malicious vectors
const XSS_PATTERNS = [
  /<script[^>]*>/i, // <script> tags
  /<\/script>/i, // </script> tags
  /javascript:/i, // javascript: protocol
  /onerror\s*=/i, // onerror event handler
  /onload\s*=/i, // onload event handler
  /<iframe/i, // <iframe> tags
  /<img/i, // <img> tags (with potential src="javascript:")
  /alert\s*\(/i, // alert() function calls
  /eval\s*\(/i, // eval() function calls
];

const SQL_PATTERNS = [
  // Was /['"`;]/ -- that flagged the ASCII apostrophe as a SQL injection
  // attempt, which rejected legitimate names this same validator's
  // NAME_ALLOWED_PATTERN (and its own docstring's "O'Brien" example) both
  // explicitly allow. Real SQL-injection protection is parameterized
  // queries on the backend (already the case here), not a client-side
  // character ban -- so this keeps flagging double-quote/backtick/
  // semicolon (never legitimate in a person's name) without blocking a
  // perfectly normal name.
  /["`;]/, // SQL quotes and semicolons (basic check)
  /\bOR\b\s*['"1]/i, // OR 1 / OR '1' (common SQL injection)
  /\bAND\b\s*['"1]/i, // AND 1 / AND '1'
  /--\s*(comment|$)/i, // SQL comments
  /\/\*.*\*\//, // Multi-line comments
  /\bUNION\b/i, // UNION (common in injection)
  /\bSELECT\b/i, // SELECT
  /\bDROP\b/i, // DROP
  /\bINSERT\b/i, // INSERT
  /\bUPDATE\b/i, // UPDATE
  /\bDELETE\b/i, // DELETE
];

/** Returns an error message, or null when the name is acceptable. */
export const validatePersonName = (
  value: string | undefined,
  label = "Name",
): string | null => {
  const text = (value ?? "")
    // Strip control, zero-width and bidi characters before checking, so a
    // payload can't be smuggled past the allow-list inside invisible glue.
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!text) return `${label} is required.`;
  if (text.length < NAME_MIN_LENGTH)
    return `${label} must be at least ${NAME_MIN_LENGTH} characters.`;
  if (text.length > NAME_MAX_LENGTH)
    return `${label} must be ${NAME_MAX_LENGTH} characters or fewer.`;

  // Check for XSS patterns — reject scripts, event handlers, and dangerous protocols
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(text)) {
      return `${label} contains invalid characters or patterns. No HTML tags or scripts allowed.`;
    }
  }

  // Check for SQL injection patterns — reject SQL keywords and SQL syntax
  for (const pattern of SQL_PATTERNS) {
    if (pattern.test(text)) {
      return `${label} contains invalid characters or patterns. No SQL keywords or special characters allowed.`;
    }
  }

  if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix)))
    return `${label} cannot start with =, +, - or @.`;
  if (NAME_HAS_DIGIT.test(text)) return `${label} cannot contain numbers.`;
  if (!NAME_HAS_LETTER.test(text)) return `${label} must contain letters.`;
  if (!NAME_ALLOWED_PATTERN.test(text))
    return `${label} can only contain letters, spaces, hyphens, periods and commas.`;

  return null;
};

// Mirror of _validate_person_code() in backend/support_db_staff.py, which is
// the single choke point both create and update go through
// (_person_code_from_payload in support_db_client_users.py). Deliberately
// stricter than the name allow-list: real codes in this product are always
// machine-generated or short manual entries in the EMP-001 / TCH-001 /
// REG-001 shape (see peopleCodeModel's placeholders in types.ts) — letters,
// digits, hyphen and underscore only. The backend remains the authority;
// this just surfaces the same error before the round trip.
export const PERSON_CODE_ALLOWED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Returns an error message, or null when the code is acceptable. */
export const validatePersonCode = (
  value: string | undefined,
  label = "Employee ID",
): string | null => {
  const text = (value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();

  if (!text) return `${label} is required.`;
  if (text.length > PERSON_CODE_MAX_LENGTH)
    return `${label} must be ${PERSON_CODE_MAX_LENGTH} characters or fewer.`;
  if (!PERSON_CODE_ALLOWED_PATTERN.test(text))
    return `${label} can only contain letters, digits, hyphens and underscores, and must start with a letter or digit.`;

  return null;
};

export interface StaffFormErrors {
  name?: string;
  personCode?: string;
  salary?: string;
  email?: string;
  phone?: string;
  contact?: string;
  cnic?: string;
  fatherName?: string;
  fatherPhone?: string;
  fatherCnic?: string;
}

export const validateStaffForm = (
  data: StaffFormData,
  isStudent: boolean,
  // Per-people_type label ("Employee ID" / "Registration Number" / "Teacher
  // Code" / "Worker ID" / "Staff ID" — see peopleCodeModel in ../types/types)
  // so the inline error reads the same as the field's own label. Optional so
  // existing callers that only care about the other fields don't need to
  // thread it through.
  personCodeLabel = "Employee ID",
  validateSalary = true,
): StaffFormErrors => {
  const errors: StaffFormErrors = {};

  // The name field had no rule at all here, so the form happily submitted
  // markup and SQL-shaped strings and left the backend as the only gate.
  const nameError = validatePersonName(data.name, "Full name");
  if (nameError) errors.name = nameError;

  // Same gap existed for the person-code field: no rule at all client-side
  // beyond a cosmetic maxLength, so unbounded/markup-shaped strings reached
  // the backend and relied on it alone (see validatePersonCode's docstring
  // for the mirrored backend rule in support_db_staff.py).
  const personCodeError = validatePersonCode(data.personCode, personCodeLabel);
  if (personCodeError) errors.personCode = personCodeError;

  if (validateSalary) {
    if (!Number.isFinite(data.salary)) {
      errors.salary = "Compensation must be a valid number.";
    } else if (data.salary < SALARY_MIN) {
      errors.salary = `Compensation must be at least PKR ${SALARY_MIN.toLocaleString("en-PK")}.`;
    } else if (data.salary > SALARY_MAX) {
      errors.salary = `Compensation cannot exceed PKR ${SALARY_MAX.toLocaleString("en-PK")}.`;
    }
  }

  const email = data.email?.trim() ?? "";
  const phone = data.phone?.trim() ?? "";
  const cnic = data.cnic?.trim() ?? "";

  if (email && !isValidEmail(email)) {
    errors.email = "Enter a valid email address (e.g. name@company.com).";
  }

  if (phone && !isValidPhone(phone)) {
    errors.phone = "Enter a valid phone number (7-15 digits).";
  }

  if (!email && !phone) {
    errors.contact = "Enter at least an email or a phone number";
  }

  // CNIC is required for every non-student person; students carry their
  // father's CNIC instead (validated below), not their own.
  if (!isStudent) {
    if (!cnic) {
      errors.cnic = "CNIC is required.";
    } else if (!isValidCnic(cnic)) {
      errors.cnic = "Enter a valid 13-digit CNIC (e.g. 42101-1234567-1).";
    }
  }

  if (isStudent) {
    const fatherName = data.fatherName?.trim() ?? "";
    const fatherPhone = data.fatherPhone?.trim() ?? "";
    const fatherCnic = data.fatherCnic?.trim() ?? "";

    const fatherNameError = validatePersonName(fatherName, "Father name");
    if (fatherNameError) errors.fatherName = fatherNameError;
    if (!fatherPhone) {
      errors.fatherPhone = "Father number is required.";
    } else if (!isValidPhone(fatherPhone)) {
      errors.fatherPhone = "Enter a valid phone number (7-15 digits).";
    }
    if (!fatherCnic) {
      errors.fatherCnic = "Father CNIC is required.";
    } else if (!isValidCnic(fatherCnic)) {
      errors.fatherCnic = "Enter a valid 13-digit CNIC (e.g. 42101-1234567-1).";
    }
  }

  return errors;
};
