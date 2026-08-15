/**
 * src/app/support-dashboard/modules/organizations/hooks/useOrganizations.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight data hooks for Support Dashboard organizations.
 *
 * Performance:
 * - List hook only loads organization rows.
 * - Detail tabs load their own data only when opened.
 * - Vertical templates are cached in memory for the page session.
 * - No fake timeout/buffering.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  extractApiError,
  organizationsApi,
  verticalTemplatesApi,
  type ListOrganizationsParams,
} from "../api/organizationsApi";
import type {
  CreateOrganizationPayload,
  Organization,
  PeopleType,
  SupportVerticalTemplateOption,
  UpdateOrganizationPayload,
} from "../../../packages/shared-types/src/organization";

interface AsyncState<T> {
  data: T;
  isLoading: boolean;
  error: string | null;
}

type ListAction =
  | { type: "START" }
  | { type: "SUCCESS"; payload: Organization[] }
  | { type: "ERROR"; payload: string }
  | { type: "UPSERT"; payload: Organization }
  | { type: "REMOVE"; payload: string };

function orgListReducer(state: AsyncState<Organization[]>, action: ListAction): AsyncState<Organization[]> {
  switch (action.type) {
    case "START":
      return { ...state, isLoading: true, error: null };
    case "SUCCESS":
      return { data: action.payload, isLoading: false, error: null };
    case "ERROR":
      return { ...state, isLoading: false, error: action.payload };
    case "UPSERT": {
      const exists = state.data.some((org) => org.id === action.payload.id);
      return {
        ...state,
        data: exists ? state.data.map((org) => (org.id === action.payload.id ? action.payload : org)) : [action.payload, ...state.data],
      };
    }
    case "REMOVE":
      return { ...state, data: state.data.filter((org) => org.id !== action.payload) };
    default:
      return state;
  }
}

export interface UseOrganizationsReturn {
  organizations: Organization[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  upsertLocal: (org: Organization) => void;
  removeLocal: (orgId: string) => void;
}

export function useOrganizations(params?: ListOrganizationsParams): UseOrganizationsReturn {
  const [state, dispatch] = useReducer(orgListReducer, { data: [], isLoading: false, error: null });
  const paramsKey = JSON.stringify(params ?? {});
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    dispatch({ type: "START" });
    try {
      const data = await organizationsApi.list(params);
      if (requestId === requestIdRef.current) dispatch({ type: "SUCCESS", payload: data });
    } catch (err) {
      if (requestId === requestIdRef.current) {
        dispatch({ type: "ERROR", payload: extractApiError(err, "Failed to load organizations") });
      }
    }
    // paramsKey intentionally controls refresh stability without deep object deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    organizations: state.data,
    isLoading: state.isLoading,
    error: state.error,
    refresh,
    upsertLocal: (org) => dispatch({ type: "UPSERT", payload: org }),
    removeLocal: (orgId) => dispatch({ type: "REMOVE", payload: orgId }),
  };
}

const FALLBACK_TEMPLATES: SupportVerticalTemplateOption[] = [
  {
    business_type: "company",
    label: "Company / Software House",
    primary_people_type: "staff",
    enabled_people_types: ["staff"],
    attendance_people_types: ["staff"],
  },
  {
    business_type: "school",
    label: "School / College",
    primary_people_type: "student",
    enabled_people_types: ["student", "staff"],
    attendance_people_types: ["student", "staff"],
  },
  {
    business_type: "factory",
    label: "Factory",
    primary_people_type: "worker",
    enabled_people_types: ["worker", "staff"],
    attendance_people_types: ["worker", "staff"],
  },
];

let templatesCache: SupportVerticalTemplateOption[] | null = null;
let templatesRequest: Promise<SupportVerticalTemplateOption[]> | null = null;

function normalizeTemplateRows(rows: SupportVerticalTemplateOption[] | null | undefined): SupportVerticalTemplateOption[] {
  const source = Array.isArray(rows) && rows.length ? rows : FALLBACK_TEMPLATES;
  return source.map((row) => ({
    ...row,
    business_type: row.business_type || "company",
    label: row.label || String(row.business_type || "Company"),
    primary_people_type: row.primary_people_type || "staff",
    enabled_people_types: row.enabled_people_types || row.vertical_config?.enabled_people_types,
    attendance_people_types: row.attendance_people_types || row.vertical_config?.attendance_people_types,
  }));
}

async function loadVerticalTemplatesOnce(): Promise<SupportVerticalTemplateOption[]> {
  if (templatesCache) return templatesCache;
  if (!templatesRequest) {
    templatesRequest = verticalTemplatesApi
      .list()
      .then(normalizeTemplateRows)
      .then((rows) => {
        templatesCache = rows;
        return rows;
      })
      .finally(() => {
        templatesRequest = null;
      });
  }
  return templatesRequest;
}

export interface UseVerticalTemplatesReturn {
  templates: SupportVerticalTemplateOption[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getLabel: (businessType?: string | null) => string;
}

export function useVerticalTemplates(): UseVerticalTemplatesReturn {
  const [templates, setTemplates] = useState<SupportVerticalTemplateOption[]>(templatesCache ?? FALLBACK_TEMPLATES);
  const [isLoading, setIsLoading] = useState(!templatesCache);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      templatesCache = null;
      const rows = await loadVerticalTemplatesOnce();
      setTemplates(rows);
    } catch (err) {
      setTemplates(FALLBACK_TEMPLATES);
      setError(extractApiError(err, "Failed to load business templates"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    if (templatesCache) return undefined;
    setIsLoading(true);
    loadVerticalTemplatesOnce()
      .then((rows) => {
        if (mounted) setTemplates(rows);
      })
      .catch((err) => {
        if (mounted) {
          setTemplates(FALLBACK_TEMPLATES);
          setError(extractApiError(err, "Failed to load business templates"));
        }
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const labelMap = useMemo(() => {
    const map = new Map<string, string>();
    templates.forEach((template) => map.set(String(template.business_type), template.label));
    return map;
  }, [templates]);

  return {
    templates,
    isLoading,
    error,
    refresh,
    getLabel: (businessType) => labelMap.get(String(businessType || "company")) || String(businessType || "company"),
  };
}

interface MutationState {
  isMutating: boolean;
  error: string | null;
}

function useMutationState() {
  const [state, setState] = useReducer(
    (current: MutationState, patch: Partial<MutationState>) => ({ ...current, ...patch }),
    { isMutating: false, error: null },
  );

  const run = useCallback(async <T,>(action: () => Promise<T>, onSuccess?: (result: T) => void) => {
    setState({ isMutating: true, error: null });
    try {
      const result = await action();
      onSuccess?.(result);
      return result;
    } catch (err) {
      const message = extractApiError(err, "Request failed");
      setState({ error: message });
      throw err;
    } finally {
      setState({ isMutating: false });
    }
  }, []);

  return { ...state, run, clearError: () => setState({ error: null }) };
}

export function useCreateOrganization() {
  const mutation = useMutationState();
  return {
    createOrganization: (payload: CreateOrganizationPayload, onSuccess?: (org: Organization) => void) =>
      mutation.run(() => organizationsApi.create(payload), onSuccess),
    isCreating: mutation.isMutating,
    error: mutation.error,
    clearError: mutation.clearError,
  };
}

export function useUpdateOrganization() {
  const mutation = useMutationState();
  return {
    updateOrganization: (payload: UpdateOrganizationPayload, onSuccess?: (org: Organization) => void) =>
      mutation.run(() => organizationsApi.update(payload), onSuccess),
    isUpdating: mutation.isMutating,
    error: mutation.error,
    clearError: mutation.clearError,
  };
}

export function useUpdateOrganizationStaffTypeScope() {
  const mutation = useMutationState();
  return {
    updateOrganizationStaffTypeScope: (
      orgId: string,
      enabledStaffTypes: ("office" | "field")[],
      onSuccess?: (org: Organization) => void,
    ) =>
      mutation.run(
        () =>
          organizationsApi.updateStaffTypeScope({
            id: orgId,
            enabled_staff_types: enabledStaffTypes,
          }),
        onSuccess,
      ),
    isUpdatingStaffTypeScope: mutation.isMutating,
    error: mutation.error,
    clearError: mutation.clearError,
  };
}

export function useUpdateOrganizationTemplate() {
  const mutation = useMutationState();
  return {
    updateOrganizationTemplate: (
      orgId: string,
      businessType: string,
      attendancePeopleTypes?: PeopleType[],
      onSuccess?: (org: Organization) => void,
    ) =>
      mutation.run(
        () =>
          organizationsApi.updateTemplate({
            id: orgId,
            business_type: businessType,
            attendance_people_types: attendancePeopleTypes,
          }),
        onSuccess,
      ),
    isUpdatingTemplate: mutation.isMutating,
    error: mutation.error,
    clearError: mutation.clearError,
  };
}