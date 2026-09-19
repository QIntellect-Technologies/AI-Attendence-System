/**
 * src/app/support-dashboard/modules/organizations/api/cameraAssignmentsApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * API boundary for branch camera -> node and camera -> context assignments.
 * Mirrors branchesApi's conventions in organizationsApi.ts: components never
 * build raw URLs, UUIDs are encoded here, envelope unwrapping happens here.
 */

import { supportApiClient } from "../../../api/supportApiClient";

const BASE = "/v1/support/organizations";

const encodeId = (value: string): string => encodeURIComponent(String(value));

export interface BranchActiveNode {
  node_id: string;
  node_label: string | null;
  last_seen_at: string | null;
  status: string;
}

export interface BranchCameraWithAssignment {
  id: string;
  camera_name: string;
  camera_type: string;
  channel: number;
  location: string | null;
  enabled: boolean;
  assigned_node_id: string | null;
}

export type CameraContextType = "department" | "class" | "section";
export type CameraAssignmentType = "permanent" | "temporary";

export interface CameraContextAssignment {
  id: string;
  org_id: string;
  branch_id: string;
  camera_id: string;
  context_type: CameraContextType;
  department_id: string | null;
  class_id: string | null;
  section_id: string | null;
  assignment_type: CameraAssignmentType;
  effective_from: string | null;
  effective_to: string | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

export interface CreateCameraContextAssignmentPayload {
  context_type: CameraContextType;
  department_id?: string;
  class_id?: string;
  section_id?: string;
  assignment_type?: CameraAssignmentType;
  effective_from?: string;
  effective_to?: string;
}

// Shape shared by departments/classes/sections as returned by
// support_db_attendance_settings.py — same three fields the Client
// Dashboard's own department/class/section editors already rely on.
// class_id is only present on sections (each belongs to exactly one class).
export interface ContextTarget {
  id: string;
  name: string;
  code: string | null;
  status: "active" | "inactive";
  class_id?: string;
}

interface NodesEnvelope {
  success: boolean;
  nodes: BranchActiveNode[];
}

interface CamerasEnvelope {
  success: boolean;
  cameras: BranchCameraWithAssignment[];
}

interface CameraEnvelope {
  success: boolean;
  camera: BranchCameraWithAssignment;
}

interface AssignmentsEnvelope {
  success: boolean;
  assignments: CameraContextAssignment[];
}

interface AssignmentEnvelope {
  success: boolean;
  assignment: CameraContextAssignment;
}

interface DepartmentsEnvelope {
  success: boolean;
  departments: ContextTarget[];
}

interface ClassesEnvelope {
  success: boolean;
  classes: ContextTarget[];
}

interface SectionsEnvelope {
  success: boolean;
  sections: ContextTarget[];
}

export const cameraAssignmentsApi = {
  listNodes: (orgId: string, branchId: string): Promise<BranchActiveNode[]> =>
    supportApiClient
      .get<NodesEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/nodes`,
      )
      .then((r) => r.data.nodes),

  listCameras: (
    orgId: string,
    branchId: string,
  ): Promise<BranchCameraWithAssignment[]> =>
    supportApiClient
      .get<CamerasEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/cameras/assignments`,
      )
      .then((r) => r.data.cameras),

  assignCameraToNode: (
    orgId: string,
    branchId: string,
    cameraId: string,
    nodeId: string,
  ): Promise<BranchCameraWithAssignment> =>
    supportApiClient
      .post<CameraEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/cameras/${encodeId(cameraId)}/assign-node`,
        { node_id: nodeId },
      )
      .then((r) => r.data.camera),

  unassignCameraFromNode: (
    orgId: string,
    branchId: string,
    cameraId: string,
  ): Promise<BranchCameraWithAssignment> =>
    supportApiClient
      .delete<CameraEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/cameras/${encodeId(cameraId)}/assign-node`,
      )
      .then((r) => r.data.camera),

  listContextAssignments: (
    orgId: string,
    branchId: string,
    cameraId: string,
    includeInactive = false,
  ): Promise<CameraContextAssignment[]> =>
    supportApiClient
      .get<AssignmentsEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/cameras/${encodeId(cameraId)}/context-assignments`,
        includeInactive ? { params: { include_inactive: "true" } } : undefined,
      )
      .then((r) => r.data.assignments),

  // Every context assignment on the branch in one call — used to load all
  // cameras' tags together instead of one request per camera.
  listBranchContextAssignments: (
    orgId: string,
    branchId: string,
    includeInactive = false,
  ): Promise<CameraContextAssignment[]> =>
    supportApiClient
      .get<AssignmentsEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/context-assignments`,
        includeInactive ? { params: { include_inactive: "true" } } : undefined,
      )
      .then((r) => r.data.assignments),

  listDepartments: (orgId: string, branchId: string): Promise<ContextTarget[]> =>
    supportApiClient
      .get<DepartmentsEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/departments`,
      )
      .then((r) => r.data.departments),

  listClasses: (orgId: string, branchId: string): Promise<ContextTarget[]> =>
    supportApiClient
      .get<ClassesEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/classes`,
      )
      .then((r) => r.data.classes),

  listSections: (
    orgId: string,
    branchId: string,
    classId: string,
  ): Promise<ContextTarget[]> =>
    supportApiClient
      .get<SectionsEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/classes/${encodeId(classId)}/sections`,
      )
      .then((r) => r.data.sections),

  // Flat list of every section in the branch (each carries class_id) — used
  // by the picker so departments/classes/sections all load in one parallel
  // batch instead of waiting on a class pick to fetch its sections.
  listBranchSections: (orgId: string, branchId: string): Promise<ContextTarget[]> =>
    supportApiClient
      .get<SectionsEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/sections`,
      )
      .then((r) => r.data.sections),

  createContextAssignment: (
    orgId: string,
    branchId: string,
    cameraId: string,
    payload: CreateCameraContextAssignmentPayload,
  ): Promise<CameraContextAssignment> =>
    supportApiClient
      .post<AssignmentEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/cameras/${encodeId(cameraId)}/context-assignments`,
        payload,
      )
      .then((r) => r.data.assignment),

  deactivateContextAssignment: (
    orgId: string,
    branchId: string,
    assignmentId: string,
  ): Promise<CameraContextAssignment> =>
    supportApiClient
      .delete<AssignmentEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/context-assignments/${encodeId(assignmentId)}`,
      )
      .then((r) => r.data.assignment),
} as const;