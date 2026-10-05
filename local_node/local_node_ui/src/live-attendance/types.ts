export interface LiveAttendanceEventView {
  id: string;
  type: string;
  name: string;
  staff_id?: string;
  status: string;
  confidence: number;
  message: string;
  marked_at: string;
  check_out_marked_at?: string | null;
  sync_status: string;
  camera_id?: string | null;
  camera_name?: string | null;
  snapshot?: string | null;
  /** Operator-facing context. Set for a check-in confirmed after its shift
   * window closed but originally sighted earlier (see local_db.py's
   * _format_early_before_shift_note), and for a checkout sighting held for
   * review outside the checkout window (see _format_checkout_hold_note). */
  notes?: string | null;
  /** 'early' | 'late' | null — set only while a checkout sighting sits
   * held for review (see local_db.py's record_attendance_local checkout
   * branch). Null for confirmed events and for check-in holds. */
  check_out_hold_reason?: "early" | "late" | null;
}