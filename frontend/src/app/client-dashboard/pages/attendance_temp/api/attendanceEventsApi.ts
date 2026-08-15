import {
  getAttendanceToday,
  type AttendanceQueryParams,
  type TodayAttendanceRecord,
} from "./attendanceApi";

export type AttendanceRecord = TodayAttendanceRecord;

export interface TodayAttendanceResponse {
  success: boolean;
  date: string;
  records: AttendanceRecord[];
  raw_count?: number;
}

export async function getTodayAttendance(params: {
  organizationId: number | string;
  branchId?: number | string | null;
  date?: string;
  start?: string;
  end?: string;
  peopleType?: string | null;
  people_type?: string | null;
}): Promise<TodayAttendanceResponse> {
  const query: AttendanceQueryParams = {
    organizationId: params.organizationId,
    branchId: params.branchId,
    date: params.date,
    start: params.start,
    end: params.end,
    peopleType: params.peopleType ?? params.people_type ?? null,
  };

  const records = await getAttendanceToday(query);
  return {
    success: true,
    date: params.date ?? new Date().toISOString().slice(0, 10),
    records,
    raw_count: records.length,
  };
}
