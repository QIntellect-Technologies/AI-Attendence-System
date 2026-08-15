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

export interface StaffFormErrors {
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
): StaffFormErrors => {
  const errors: StaffFormErrors = {};
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

    if (!fatherName) {
      errors.fatherName = "Father name is required.";
    }
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
