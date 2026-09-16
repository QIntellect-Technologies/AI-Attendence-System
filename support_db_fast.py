# """
# support_db_fast.py
# ───────────────────────────────────────────────────────────────────────────────
# App-wide fast data layer for Flask + Supabase.

# It prefers the SQL RPCs from sql/001_real_scaling_indexes_and_rpc.sql, but also
# has a safe direct-query fallback so the app does not break if the SQL was not
# run yet. Every heavy endpoint returns either a small summary or one server-side
# page; it never returns a full tenant table.
# """

# from __future__ import annotations

# import hashlib
# import json
# import os
# import time
# from dataclasses import dataclass, replace
# from threading import RLock
# from typing import Any, Dict, Optional, Tuple

# try:
#     from supabase import create_client
# except Exception:  # pragma: no cover
#     create_client = None  # type: ignore

# from support_db_core import _execute_supabase, build_or_ilike_filter

# JsonDict = Dict[str, Any]


# @dataclass(frozen=True)
# class FastScope:
#     client_id: Optional[str] = None
#     org_id: Optional[str] = None
#     branch_id: Optional[str] = None
#     people_type: Optional[str] = None
#     today: Optional[str] = None
#     # Payroll pay-period window ('YYYY-MM-DD'), display filters same as
#     # branch_id/today — not identity-scoping, safe to read from args.
#     period_start: Optional[str] = None
#     period_end: Optional[str] = None
#     # None = unscoped (org/branch admin, or 'branch'-scoped caller — same
#     # contract as client_dashboard_auth.get_team_scope_ids). A concrete
#     # frozenset restricts staff/attendance/leaves rows to that id set —
#     # see from_dashboard_user below. Deliberately NOT settable via
#     # from_args: this must only ever come from a verified token, never
#     # from a request query string.
#     scope_ids: Optional[frozenset] = None

#     @classmethod
#     def from_args(cls, args: Any) -> "FastScope":
#         """Builds a scope entirely from request args. Do NOT call this
#         directly in any /api/v2/* Flask route — org_id/branch_id here are
#         whatever the caller sent, unauthenticated. Use from_dashboard_user
#         instead, which pins the tenant-identifying fields to the verified
#         dashboard token. Kept public because non-route call sites (tests,
#         scripts) may legitimately want a scope with no auth context."""
#         def clean(value: Any) -> Optional[str]:
#             if value is None:
#                 return None
#             text = str(value).strip()
#             if not text or text.lower() in {"all", "all_branches", "null", "undefined", "none"}:
#                 return None
#             return text

#         return cls(
#             client_id=clean(args.get("clientId") or args.get("client_id") or args.get("tenantId") or args.get("tenant_id")),
#             org_id=clean(args.get("orgId") or args.get("org_id") or args.get("organizationId") or args.get("organization_id")),
#             branch_id=clean(args.get("branchId") or args.get("branch_id")),
#             people_type=clean(args.get("people_type") or args.get("peopleType") or args.get("person_type") or args.get("personType")),
#             today=clean(args.get("today") or args.get("date")),
#             period_start=clean(args.get("periodStart") or args.get("period_start")),
#             period_end=clean(args.get("periodEnd") or args.get("period_end")),
#         )

#     @classmethod
#     def from_dashboard_user(cls, dashboard_user: dict, args: Any, *, scope_ids: Optional[set] = None) -> "FastScope":
#         """The ONLY constructor every /api/v2/* route should use.

#         org_id is pinned to the verified g.dashboard_user['org_id'] —
#         never the request's orgId/organizationId/X-Organization-Id, which
#         is how this whole module was reachable cross-tenant by anyone
#         before this fix (see PATCH_NOTES: fast-path auth bypass).

#         branch_id: a client_staff row always has its own home branch_id in
#         the token, admin or not — is_admin does NOT imply branch_id is
#         None. So branch-locking only applies to a genuinely branch-scoped
#         (non-admin) account; that caller's token branch wins outright and
#         the query string can never widen it. An admin (is_admin=True) is
#         org-wide by default regardless of their own home branch, and may
#         still pass branch_id as a voluntary display filter to narrow to
#         one branch, the same trust boundary /api/staff already uses.
#         Previously this checked "token_branch_id is set" instead of
#         "caller is admin", which silently locked admins to their own
#         branch and hid every other branch's staff/payroll/attendance from
#         them — see PATCH_NOTES: admin branch-lock.

#         scope_ids: pass the caller's client_dashboard_auth.get_team_scope_ids()
#         (or get_effective_scope_ids()) result straight through — None for
#         unscoped ('branch'/admin), or the (possibly empty) subordinate-id
#         set for a 'team'-scoped caller. Never compute this locally; it
#         must come from the same single source of truth every other
#         scope-sensitive route uses.
#         """
#         base = cls.from_args(args)
#         token_org_id = str(dashboard_user.get("org_id") or "").strip() or None
#         token_branch_id = dashboard_user.get("branch_id")
#         is_admin = bool(dashboard_user.get("is_admin"))
#         resolved_branch_id = base.branch_id if is_admin else (
#             str(token_branch_id) if token_branch_id else base.branch_id
#         )
#         return replace(
#             base,
#             org_id=token_org_id,
#             branch_id=resolved_branch_id,
#             scope_ids=frozenset(scope_ids) if scope_ids is not None else None,
#         )

#     def cache_parts(self) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str]]:
#         return (self.client_id, self.org_id, self.branch_id, self.people_type, self.today)


# class TinyTTLCache:
#     def __init__(self, max_items: int = 1024) -> None:
#         self.max_items = max_items
#         self._data: Dict[str, Tuple[float, Any]] = {}
#         self._lock = RLock()

#     def get(self, key: str) -> Optional[Any]:
#         now = time.monotonic()
#         with self._lock:
#             item = self._data.get(key)
#             if not item:
#                 return None
#             expires_at, value = item
#             if expires_at < now:
#                 self._data.pop(key, None)
#                 return None
#             return value

#     def set(self, key: str, value: Any, ttl_seconds: float) -> None:
#         expires_at = time.monotonic() + max(float(ttl_seconds or 0), 0.1)
#         with self._lock:
#             if len(self._data) >= self.max_items:
#                 self._data.pop(next(iter(self._data)), None)
#             self._data[key] = (expires_at, value)

#     def clear(self) -> None:
#         with self._lock:
#             self._data.clear()


# _cache = TinyTTLCache()
# _supabase_client = None
# _supabase_lock = RLock()


# def _json_hash(value: Any) -> str:
#     return hashlib.sha1(json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")).hexdigest()


# def get_supabase_client():
#     global _supabase_client
#     with _supabase_lock:
#         if _supabase_client is not None:
#             return _supabase_client
#         if create_client is None:
#             raise RuntimeError("supabase package is not installed. Run: pip install supabase")
#         url = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
#         key = (
#             os.getenv("SUPABASE_SERVICE_ROLE_KEY")
#             or os.getenv("SUPABASE_SERVICE_KEY")
#             or os.getenv("SUPABASE_KEY")
#             or os.getenv("SUPABASE_ANON_KEY")
#             or os.getenv("VITE_SUPABASE_ANON_KEY")
#         )
#         if not url or not key:
#             raise RuntimeError("Missing SUPABASE_URL and service/anon key environment variables.")
#         _supabase_client = create_client(url, key)
#         return _supabase_client


# def ok(data: Any, *, cached: bool = False) -> JsonDict:
#     if isinstance(data, dict):
#         data.setdefault("success", True)
#         data.setdefault("cached", cached)
#         return data
#     return {"success": True, "cached": cached, "data": data}


# def fail(message: str, status: int = 500, **extra: Any) -> Tuple[JsonDict, int]:
#     body: JsonDict = {"success": False, "message": message}
#     body.update(extra)
#     return body, status


# def _rpc(name: str, payload: JsonDict) -> Any:
#     return get_supabase_client().rpc(name, payload).execute().data


# def _resolve_branch_id(sb: Any, org_id: Optional[str], branch_id: Optional[str]) -> Optional[str]:
#     """
#     Resolves a branchId query param to the real Supabase branches.id UUID.

#     Accepts either a real branch UUID (returned as-is) or a legacy numeric UI
#     ordinal (1..N). The ordinal is mapped against support_db.list_branches(),
#     the same active-only, created_at-ordered source _build_client_config uses
#     to assign ui_branch_id — this keeps ordinal resolution in sync with the
#     ids the dashboard actually displays. Previously this ran its own
#     unfiltered query, which included soft-deleted branches in the ordering
#     and silently resolved UI id 2 to a dropped row whenever a branch had
#     been replaced (e.g. Aukara: ffff0ded dropped, 6e37c4b0 active).
#     """
#     if not org_id or not branch_id:
#         return branch_id
#     text = str(branch_id).strip()
#     if not text:
#         return None
#     try:
#         import support_db  # local import: avoids a hard circular import at module load time
#         branches = support_db.list_branches(org_id)  # include_dropped=False by default
#         ids = [str(b.get("id")) for b in branches if b.get("id")]
#         if text in ids:
#             return text
#         if text.isdigit():
#             idx = int(text) - 1
#             if 0 <= idx < len(ids):
#                 return ids[idx]
#     except Exception:
#         return text
#     return text


# def _safe_count(query: Any) -> int:
#     try:
#         # PostgREST still calculates the exact count but returns at most one row.
#         # Routed through _execute_supabase so a blocked/rejected request is
#         # classified (and, for transient infra blips, retried) the same way
#         # every other Supabase call in the app is, instead of this being the
#         # one path that silently swallows every exception shape.
#         result = _execute_supabase("fast.safe_count", lambda: query.limit(1))
#         return int(getattr(result, "count", None) or 0)
#     except Exception:
#         return 0


# def _order(query: Any, sort_by: Optional[str], sort_dir: str, allowed: set[str], default: str):
#     col = sort_by if sort_by in allowed else default
#     return query.order(col, desc=str(sort_dir).lower() == "desc")


# def _or_search(query: Any, search: Optional[str], cols: list[str]):
#     """Apply a safe, case-insensitive OR-across-columns search filter.

#     See support_db_core.build_or_ilike_filter for why this can't just
#     strip '%'/',' from the raw text (that was the old implementation, and
#     it neither preserved user intent nor actually prevented a search term
#     from redefining the filter's structure).
#     """
#     clause = build_or_ilike_filter(search, cols)
#     return query.or_(clause) if clause else query


# def _page_result(entity: str, rows: list[dict], total: int, page: int, page_size: int, offset: int, table: str) -> JsonDict:
#     return {
#         "success": True,
#         "entity": entity,
#         "table": table,
#         "rows": rows,
#         "total": int(total or 0),
#         "page": page,
#         "pageSize": page_size,
#         "offset": offset,
#         "hasMore": offset + len(rows) < int(total or 0),
#     }


# def _direct_staff_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
#     if not scope.org_id:
#         return _page_result("staff", [], 0, page, page_size, (page - 1) * page_size, "client_staff")
#     # A 'team'-scoped caller with zero reports is a real, distinct value —
#     # short-circuit to an empty page rather than let an empty .in_([]) fall
#     # through to Postgrest (which some client versions treat as "no filter"
#     # applied, i.e. the whole org back). Same "empty set != no filter"
#     # contract as client_dashboard_auth.filter_rows_by_scope.
#     if scope.scope_ids is not None and not scope.scope_ids:
#         return _page_result("staff", [], 0, page, page_size, (page - 1) * page_size, "client_staff")

#     sb = get_supabase_client()
#     branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#     # Deliberately does NOT filter .eq("role", "staff") — the Staff
#     # Directory is a roster of everyone in the org, and an admin is still
#     # an employee, not a separate account type that exits the roster (see
#     # list_client_staff's role='staff' default in support_db_staff.py,
#     # which had the same assumption baked in — a client_staff row promoted
#     # to admin would silently vanish from every directory/count view that
#     # called either function). scope_ids (team-scope) still applies below,
#     # so a team-scoped manager's view is unaffected by this change.
#     base = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False)
#     if branch_id:
#         base = base.eq("branch_id", branch_id)
#     if scope.people_type:
#         base = base.eq("people_type", scope.people_type)
#     if scope.scope_ids is not None:
#         base = base.in_("id", list(scope.scope_ids))
#     base = _or_search(base, search, ["name", "email", "employee_id", "department_name", "role_name", "phone"])
#     total = _safe_count(base)

#     query = sb.table("client_staff").select("*").eq("org_id", scope.org_id).eq("is_archived", False)
#     if branch_id:
#         query = query.eq("branch_id", branch_id)
#     if scope.people_type:
#         query = query.eq("people_type", scope.people_type)
#     if scope.scope_ids is not None:
#         query = query.in_("id", list(scope.scope_ids))
#     query = _or_search(query, search, ["name", "email", "employee_id", "department_name", "role_name", "phone"])
#     query = _order(query, sort_by, sort_dir, {"name", "email", "employee_id", "department_name", "role_name", "salary", "status", "created_at", "updated_at"}, "name")
#     offset = (page - 1) * page_size
#     # Routed through _execute_supabase rather than a bare `.execute()` so a
#     # rejected/blocked request (WAF, malformed filter, upstream outage) is
#     # classified into a clean ValueError/RuntimeError instead of an
#     # unhandled postgrest/pydantic exception reaching the route layer as an
#     # opaque 500 -- this was the actual query on the Staff Search path
#     # involved in the WAF-crash bug.
#     result = _execute_supabase(
#         "fast.staff_page.rows",
#         lambda: query.range(offset, offset + page_size - 1),
#     )
#     rows = result.data or []
#     try:
#         import support_db  # local project mapper keeps camelCase aliases and UI branch ids consistent
#         shifts_by_id = support_db._resolve_shift_map(
#             scope.org_id, {row.get('shift_id_ref') for row in rows}
#         )
#         rows = [
#             support_db._client_staff_safe(row, scope.org_id, shifts_by_id=shifts_by_id)
#             for row in rows
#         ]
#     except Exception:
#         pass
#     return _page_result("staff", rows, total, page, page_size, offset, "client_staff")


# def _direct_branches_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
#     """
#     Branch counts per org are small (single digits to low tens), so unlike
#     staff/attendance this filters/sorts/paginates in Python over
#     support_db.list_branches() rather than re-querying Supabase with its own
#     filter set. This is deliberate: it's the same active-only, created_at
#     source _build_client_config and _resolve_branch_id use, so "what counts
#     as a branch" can never drift across these three call sites again.
#     """
#     if not scope.org_id:
#         return _page_result("branches", [], 0, page, page_size, (page - 1) * page_size, "branches")
#     import support_db
#     rows = support_db.list_branches(scope.org_id)  # include_dropped=False by default

#     text = (search or "").strip().lower()
#     if text:
#         rows = [
#             r for r in rows
#             if text in str(r.get("name") or "").lower() or text in str(r.get("location") or "").lower()
#         ]

#     sort_col = sort_by if sort_by in {"name", "location", "created_at", "max_staff_capacity"} else "created_at"
#     reverse = str(sort_dir).lower() == "desc"
#     rows = sorted(rows, key=lambda r: (r.get(sort_col) is None, r.get(sort_col)), reverse=reverse)

#     total = len(rows)
#     offset = (page - 1) * page_size
#     page_rows = rows[offset: offset + page_size]
#     return _page_result("branches", page_rows, total, page, page_size, offset, "branches")


# def _direct_attendance_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
#     if not scope.org_id:
#         return _page_result("attendance", [], 0, page, page_size, (page - 1) * page_size, "attendance")
#     if scope.scope_ids is not None and not scope.scope_ids:
#         return _page_result("attendance", [], 0, page, page_size, (page - 1) * page_size, "attendance")

#     sb = get_supabase_client()
#     branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#     base = sb.table("attendance").select("id", count="exact").eq("org_id", scope.org_id)
#     if branch_id:
#         base = base.eq("branch_id", branch_id)
#     if scope.today:
#         base = base.gte("timestamp", f"{scope.today}T00:00:00").lt("timestamp", f"{scope.today}T23:59:59")
#     if scope.scope_ids is not None:
#         base = base.in_("staff_id", list(scope.scope_ids))
#     total = _safe_count(base)
#     query = sb.table("attendance").select("*").eq("org_id", scope.org_id)
#     if branch_id:
#         query = query.eq("branch_id", branch_id)
#     if scope.today:
#         query = query.gte("timestamp", f"{scope.today}T00:00:00").lt("timestamp", f"{scope.today}T23:59:59")
#     if scope.scope_ids is not None:
#         query = query.in_("staff_id", list(scope.scope_ids))
#     query = _order(query, sort_by, sort_dir, {"timestamp", "created_at", "confidence", "source"}, "timestamp")
#     offset = (page - 1) * page_size
#     rows = query.range(offset, offset + page_size - 1).execute().data or []
#     return _page_result("attendance", rows, total, page, page_size, offset, "attendance")


# def _direct_leaves_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
#     if not scope.org_id:
#         return _page_result("leaves", [], 0, page, page_size, (page - 1) * page_size, "leave_requests")
#     if scope.scope_ids is not None and not scope.scope_ids:
#         return _page_result("leaves", [], 0, page, page_size, (page - 1) * page_size, "leave_requests")

#     sb = get_supabase_client()
#     branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#     base = sb.table("leave_requests").select("id", count="exact").eq("org_id", scope.org_id)
#     if branch_id:
#         base = base.eq("branch_id", branch_id)
#     if scope.scope_ids is not None:
#         base = base.in_("staff_id", list(scope.scope_ids))
#     base = _or_search(base, search, ["reason", "status", "leave_type"])
#     total = _safe_count(base)
#     query = sb.table("leave_requests").select("*").eq("org_id", scope.org_id)
#     if branch_id:
#         query = query.eq("branch_id", branch_id)
#     if scope.scope_ids is not None:
#         query = query.in_("staff_id", list(scope.scope_ids))
#     query = _or_search(query, search, ["reason", "status", "leave_type"])
#     query = _order(query, sort_by, sort_dir, {"created_at", "start_date", "end_date", "status", "leave_type"}, "created_at")
#     offset = (page - 1) * page_size
#     rows = query.range(offset, offset + page_size - 1).execute().data or []
#     return _page_result("leaves", rows, total, page, page_size, offset, "leave_requests")


# def _direct_payroll_page(
#     scope: FastScope,
#     page: int,
#     page_size: int,
#     search: Optional[str],
#     sort_by: Optional[str],
#     sort_dir: str,
# ) -> JsonDict:
#     """Delegates to support_db_payroll.get_client_payroll_page — the single
#     source of truth for turning client_staff + salary_configs + real
#     attendance/leave/overtime data into a payroll row via
#     payroll_engine.compute_payroll_breakdown (deductions/net_pay/status,
#     including unpaid-leave/late/half-day deductions).

#     This used to be a parallel ~140-line reimplementation of that same
#     pipeline (staff paging, per-branch attendance/leave batching, policy
#     resolution, breakdown computation) that had quietly drifted from it:
#     it resolved per-branch payroll-policy overrides using the UI branch id
#     instead of the backend branch UUID payroll_policy_overrides is actually
#     keyed on (compare get_client_payroll_page's own resolve_policy, which
#     uses staff['branch_id'] — the backend UUID). That made any branch-level
#     leaveTypeRules/lateComingPolicy override invisible on this fast-page
#     path (the one usePayrollData.ts actually calls) while it worked
#     correctly on GET /api/v2/payroll/page. Delegating removes the second
#     implementation outright, so the two paths cannot drift apart again —
#     one computation, two thin callers.

#     Deliberately unscoped from the caller's team-scope (scope_ids), even
#     for a 'team'-scoped manager: Payroll access is a module-access grant
#     (access_modules), not a hierarchy grant — see client_dashboard_auth.py's
#     get_team_scope_ids docstring ("Payroll / salary routes ignore
#     dashboard_scope entirely") and get_client_payroll_page, which never
#     reads scope_ids for the same reason.
#     """
#     offset = (page - 1) * page_size
#     if not scope.org_id:
#         return _page_result("payroll", [], 0, page, page_size, offset, "client_staff/salary_configs")

#     import support_db as _support_db

#     try:
#         page_data = _support_db.get_client_payroll_page(
#             scope.org_id,
#             branch_id=scope.branch_id,
#             page=page,
#             page_size=page_size,
#             search=search,
#             sort_by=sort_by or "name",
#             sort_dir=sort_dir,
#             period_start=scope.period_start,
#             period_end=scope.period_end,
#         )
#     except ValueError as exc:
#         return {
#             **_page_result("payroll", [], 0, page, page_size, offset, "client_staff/salary_configs"),
#             "success": False,
#             "message": str(exc),
#         }

#     rows = page_data.get("rows") or []
#     total = int(page_data.get("total") or 0)
#     return {
#         "entity": "payroll",
#         "table": "client_staff/salary_configs",
#         "rows": rows,
#         "total": total,
#         "page": int(page_data.get("page") or page),
#         "pageSize": int(page_data.get("pageSize") or page_size),
#         "offset": offset,
#         "hasMore": offset + len(rows) < total,
#     }




# def _num(value: Any, fallback: float = 0) -> float:
#     try:
#         parsed = float(value or 0)
#         return parsed if parsed == parsed else fallback
#     except Exception:
#         return fallback


# def _txt(value: Any, fallback: str = "") -> str:
#     text = str(value or "").strip()
#     return text or fallback


# def _month_labels() -> list[str]:
#     labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
#     month_index = int(time.strftime("%m")) - 1
#     return [labels[(month_index - (5 - idx)) % 12] for idx in range(6)]


# def _payroll_trends(total: float) -> list[dict]:
#     weights = [0.82, 0.87, 0.91, 0.94, 0.97, 1.0]
#     return [
#         {"month": month, "Payroll": int(round(total * weights[idx])), "Overtime": 0}
#         for idx, month in enumerate(_month_labels())
#     ]


# def _weekly_attendance(present_today: int) -> list[dict]:
#     labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
#     today_idx = int(time.strftime("%u")) - 1
#     ordered = [labels[(today_idx - (6 - idx)) % 7] for idx in range(7)]
#     return [{"day": day, "count": int(present_today if idx == 6 else 0)} for idx, day in enumerate(ordered)]


# def _attendance_performance(present: int, late: int, absent: int) -> list[dict]:
#     return [
#         {"month": month, "On Time": int(present if idx == 5 else 0), "Late": int(late if idx == 5 else 0), "Absent": int(absent if idx == 5 else 0)}
#         for idx, month in enumerate(_month_labels())
#     ]


# def _branch_ui_id(row: dict, index: int) -> int:
#     for key in ("ui_id", "branch_ui_id", "display_id"):
#         val = row.get(key)
#         try:
#             n = int(val)
#             if n > 0:
#                 return n
#         except Exception:
#             pass
#     return index + 1


# def _sum_staff_salary(sb: Any, org_id: str, branch_id: Optional[str], scope_ids: Optional[frozenset] = None) -> float:
#     """Direct fallback for monthly payroll.

#     This is intentionally small-field only. The preferred production path is the
#     SQL RPC, which computes the sum inside Postgres. The fallback keeps local
#     installs working even before SQL is applied.

#     scope_ids: None = org/branch-wide (unscoped). A frozenset restricts the
#     sum to those client_staff ids — a 'team'-scoped manager's payroll card
#     reflects their own reports' salaries, not the whole branch/org's.
#     """
#     if scope_ids is not None and not scope_ids:
#         return 0.0
#     try:
#         query = sb.table("client_staff").select("salary,basic_salary,status").eq("org_id", org_id).eq("is_archived", False).eq("role", "staff")
#         if branch_id:
#             query = query.eq("branch_id", branch_id)
#         if scope_ids is not None:
#             query = query.in_("id", list(scope_ids))
#         rows = query.execute().data or []
#         total = 0.0
#         for row in rows:
#             if str(row.get("status") or "").lower() == "inactive":
#                 continue
#             total += _num(row.get("salary") or row.get("basic_salary"))
#         return total
#     except Exception:
#         return 0.0

# def _format_shift_time(check_in_time: Any, check_out_time: Any) -> str:
#     """'09:00:00'/'17:00:00' -> '09:00 – 17:00', matching the display format
#     the Shift Distribution card already renders (and _resolve_shift_map's
#     own [:5] truncation convention in support_db.py)."""
#     start = str(check_in_time or "")[:5] or "--:--"
#     end = str(check_out_time or "")[:5] if check_out_time else None
#     return f"{start} – {end}" if end else f"{start} · Flexible"


# def _shift_distribution_for_branch(
#     sb: Any,
#     org_id: str,
#     branch_id: str,
#     people_type: Optional[str],
#     scope_ids: Optional[frozenset],
# ) -> list[dict]:
#     """Real shift distribution for one branch — support_db_shifts.py's
#     `shifts` table is the sole source of truth (see support_db.py's
#     _resolve_shift_map docstring), the same table StaffManagement.tsx's
#     Shift Allocation tab reads via listBranchShifts(). This intentionally
#     replaces the old hardcoded 4-row Morning/Evening/Night/Custom
#     placeholder list, which could never represent a branch's actual
#     configured shifts.

#     Every active shift configured for this branch is returned, even ones
#     with zero staff currently assigned — staffCount stays 0, the shift row
#     itself is never dropped.

#     scope_ids follows the exact contract every other card on this endpoint
#     already uses (see _sum_staff_salary above): None = unscoped
#     (org/branch admin, or a 'branch'-scoped caller), a non-empty frozenset
#     = restrict counts to that manager's own team, and an EMPTY frozenset
#     means a 'team'-scoped manager with zero direct reports — every shift
#     must show 0, not silently fall back to the branch-wide count.
#     """
#     if not org_id or not branch_id:
#         return []

#     # local import: avoids a hard circular import at module load time, same
#     # pattern _resolve_branch_id already uses for support_db.
#     import support_db

#     normalized_people_type = (
#         support_db._normalize_people_type(people_type) if people_type else None
#     )

#     shifts_query = (
#         sb.table("shifts")
#         .select("id,name,check_in_time,check_out_time")
#         .eq("org_id", org_id)
#         .eq("branch_id", branch_id)
#         .eq("is_active", True)
#         .order("check_in_time")
#     )
#     if normalized_people_type:
#         shifts_query = shifts_query.eq("people_type", normalized_people_type)
#     shift_rows = shifts_query.execute().data or []
#     if not shift_rows:
#         return []

#     counts: dict[str, int] = {}
#     if scope_ids is None or scope_ids:
#         staff_query = (
#             sb.table("client_staff")
#             .select("shift_id_ref")
#             .eq("org_id", org_id)
#             .eq("branch_id", branch_id)
#             .eq("is_archived", False)
#         )
#         if normalized_people_type and support_db._client_staff_has_people_type_column():
#             staff_query = staff_query.eq("people_type", normalized_people_type)
#         if scope_ids is not None:
#             staff_query = staff_query.in_("id", list(scope_ids))
#         for row in staff_query.execute().data or []:
#             shift_id = row.get("shift_id_ref")
#             if shift_id:
#                 counts[str(shift_id)] = counts.get(str(shift_id), 0) + 1
#     # else: scope_ids == frozenset() — a team-scoped manager with zero
#     # direct reports. counts stays empty, every shift correctly shows 0.

#     return [
#         {
#             "key": str(row["id"]),
#             "label": row.get("name") or "Shift",
#             "time": _format_shift_time(row.get("check_in_time"), row.get("check_out_time")),
#             "staffCount": counts.get(str(row["id"]), 0),
#             "departments": [],
#             "branches": [],
#             "members": [],
#         }
#         for row in shift_rows
#     ]


# def _merge_shift_distributions(per_branch: list[list[dict]]) -> list[dict]:
#     """'All Branches' view: shifts are a per-branch concept, so there is no
#     single real row to return per shift. Same-named shifts across branches
#     are merged (their staffCount summed) rather than shown as separate
#     rows — the same "one org-wide picture" convention this endpoint
#     already applies to every other All-Branches stat (totalStaff,
#     presentToday, etc. are org-wide sums, not one row per branch).
#     Differently-named shifts across branches each keep their own row.
#     """
#     merged: dict[str, dict] = {}
#     order: list[str] = []
#     for shifts in per_branch:
#         for shift in shifts:
#             name_key = str(shift["label"]).strip().lower()
#             if name_key not in merged:
#                 merged[name_key] = {**shift, "key": name_key}
#                 order.append(name_key)
#             else:
#                 merged[name_key]["staffCount"] += shift["staffCount"]
#     return [merged[key] for key in order]


# def get_fast_summary(scope: FastScope, *, ttl_seconds: float = 6.0) -> JsonDict:
#     payload = {
#         "p_client_id": scope.client_id,
#         "p_org_id": scope.org_id,
#         "p_branch_id": scope.branch_id,
#         "p_today": scope.today,
#         # See get_fast_page's identical field: must be in the cache key or
#         # two managers with different teams (or a manager vs. the branch
#         # admin) can be served each other's cached card numbers.
#         "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
#     }
#     key = "summary:" + _json_hash(payload)
#     cached = _cache.get(key)
#     if cached is not None:
#         return ok(cached, cached=True)

#     # A 'team'-scoped caller's cards must come from the direct-query path
#     # below, never the RPC — get_tenant_fast_summary's SQL (a Supabase
#     # migration, not this repo) has no p_scope_ids parameter and would
#     # return org/branch-wide numbers to a manager who should only see
#     # their own team.
#     if scope.scope_ids is None:
#         try:
#             data = _rpc("get_tenant_fast_summary", payload)
#             if isinstance(data, dict):
#                 _cache.set(key, data, ttl_seconds)
#                 return ok(data, cached=False)
#         except Exception:
#             pass

#     # Direct summary fallback with count='exact' only; no full-table scans in Python.
#     sb = get_supabase_client()
#     branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#     # Dashboard OVERVIEW CARDS now respect team scope too (explicit product
#     # decision, reversing this function's earlier "cards are always org/
#     # branch-wide" behavior) — a 'team'-scoped manager's people/attendance/
#     # leave cards (totalStaff/presentToday/absentToday/pendingLeaves)
#     # reflect only themself + their reports, same as the Staff/Attendance/
#     # Leave LIST pages already did via scope.scope_ids on
#     # _direct_staff_page/_direct_attendance_page/_direct_leaves_page. An
#     # unscoped ('branch'/admin) caller is scope.scope_ids=None here, so this
#     # is a no-op change for every existing admin/branch-wide session.
#     #
#     # Payroll is the one exception, deliberately: it's a module-access grant
#     # (access_modules), not a hierarchy grant — same reasoning
#     # _direct_payroll_page already documents and client_dashboard_auth.py's
#     # get_team_scope_ids docstring states outright ("Payroll / salary routes
#     # ignore dashboard_scope entirely"). A manager who also has Payroll
#     # access sees the same branch/org-wide payroll figure any other
#     # Payroll-enabled account would, so it keeps its own always-unscoped id
#     # set rather than reusing card_scope_ids.
#     card_scope_ids = scope.scope_ids
#     payroll_scope_ids = None
#     cards = {"totalStaff": 0, "activeStaff": 0, "totalBranches": 0, "presentToday": 0, "absentToday": 0, "lateToday": 0, "pendingLeaves": 0, "payrollThisMonth": 0, "monthlyPayroll": 0}
#     # Zero reports is a real, distinct value (matches the same contract
#     # used everywhere else in this codebase for an empty team) — every
#     # people-related card is legitimately 0 without ever hitting Supabase.
#     # totalBranches is left out of this short-circuit deliberately: branch
#     # count is an org-structure fact, not "my team's data," same reasoning
#     # applied to it below. Payroll is also computed outside this
#     # short-circuit (see payroll_scope_ids above) — an empty team still
#     # gets the real branch/org payroll figure, not zero.
#     team_is_empty = card_scope_ids is not None and not card_scope_ids
#     if scope.org_id and not team_is_empty:
#         staff_q = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False).eq("role", "staff")
#         active_q = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False).eq("role", "staff").neq("status", "inactive")
#         if branch_id:
#             staff_q = staff_q.eq("branch_id", branch_id)
#             active_q = active_q.eq("branch_id", branch_id)
#         if card_scope_ids is not None:
#             staff_q = staff_q.in_("id", list(card_scope_ids))
#             active_q = active_q.in_("id", list(card_scope_ids))
#         cards["totalStaff"] = _safe_count(staff_q)
#         cards["activeStaff"] = _safe_count(active_q)
#         today = scope.today or time.strftime("%Y-%m-%d")
#         aq = sb.table("attendance").select("staff_id", count="exact").eq("org_id", scope.org_id).gte("timestamp", f"{today}T00:00:00").lt("timestamp", f"{today}T23:59:59")
#         if branch_id:
#             aq = aq.eq("branch_id", branch_id)
#         if card_scope_ids is not None:
#             aq = aq.in_("staff_id", list(card_scope_ids))
#         cards["presentToday"] = _safe_count(aq)
#         cards["absentToday"] = max(0, cards["activeStaff"] - cards["presentToday"])
#         lq = sb.table("leave_requests").select("id", count="exact").eq("org_id", scope.org_id).eq("status", "pending")
#         if branch_id:
#             lq = lq.eq("branch_id", branch_id)
#         if card_scope_ids is not None:
#             lq = lq.in_("staff_id", list(card_scope_ids))
#         cards["pendingLeaves"] = _safe_count(lq)
#     if scope.org_id:
#         cards["payrollThisMonth"] = int(round(_sum_staff_salary(sb, scope.org_id, branch_id, payroll_scope_ids)))
#         cards["monthlyPayroll"] = cards["payrollThisMonth"]
#     # totalBranches stays org-wide regardless of scope_ids — a manager's
#     # "team" is a set of people, not a set of branches; narrowing this
#     # count to "branches my reports happen to sit in" isn't a meaningful
#     # metric and no part of this feature has ever asked for it.
#     if scope.org_id:
#         bq = sb.table("branches").select("id", count="exact").eq("org_id", scope.org_id)
#         cards["totalBranches"] = _safe_count(bq)
#     totals = {
#         "totalStaff": cards["totalStaff"],
#         "activeStaff": cards["activeStaff"],
#         "totalBranches": cards["totalBranches"],
#         "presentToday": cards["presentToday"],
#         "absentToday": cards["absentToday"],
#         "lateToday": cards["lateToday"],
#         "pendingLeaves": cards["pendingLeaves"],
#         "monthlyPayroll": cards["monthlyPayroll"],
#         "payrollThisMonth": cards["payrollThisMonth"],
#     }
#     data = {"success": True, "cards": cards, "totals": totals, "stats": totals, "scope": {"orgId": scope.org_id, "branchId": scope.branch_id}, "source": "direct-fallback"}
#     _cache.set(key, data, ttl_seconds)
#     return ok(data, cached=False)




# def get_fast_dashboard_overview(scope: FastScope, dashboard_scope: str = "global", *, ttl_seconds: float = 6.0) -> JsonDict:
#     """One small payload for dashboard overview cards/charts.

#     This endpoint replaces multiple dashboard-side requests. It returns a stable
#     object shape so React can render one complete layout instead of one card,
#     then fake zeros, then real data.
#     """
#     payload = {
#         "p_client_id": scope.client_id,
#         "p_org_id": scope.org_id,
#         "p_branch_id": scope.branch_id,
#         "p_today": scope.today,
#         "p_people_type": scope.people_type,
#         "dashboard_scope": dashboard_scope,
#         "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
#     }
#     key = "dashboard-overview:" + _json_hash(payload)
#     cached = _cache.get(key)
#     if cached is not None:
#         return ok(cached, cached=True)

#     # Prefer an RPC if you add it later. Fallback stays compatible today.
#     # Skipped entirely for a team-scoped caller — get_tenant_dashboard_overview's
#     # SQL has no p_scope_ids parameter (same reasoning as get_fast_summary).
#     if scope.scope_ids is None:
#         try:
#             rpc_data = _rpc("get_tenant_dashboard_overview", payload)
#             if isinstance(rpc_data, dict):
#                 _cache.set(key, rpc_data, ttl_seconds)
#                 return ok(rpc_data, cached=False)
#         except Exception:
#             pass

#     summary = get_fast_summary(scope, ttl_seconds=ttl_seconds)
#     cards = summary.get("cards") or summary.get("stats") or summary.get("totals") or {}

#     total_staff = int(_num(cards.get("totalStaff") or cards.get("total_staff")))
#     active_staff = int(_num(cards.get("activeStaff") or cards.get("active_staff") or total_staff))
#     present_today = int(_num(cards.get("presentToday") or cards.get("present_today")))
#     late_today = int(_num(cards.get("lateToday") or cards.get("late_today")))
#     absent_today = int(_num(cards.get("absentToday") or cards.get("absent_today") or max(active_staff - present_today, 0)))
#     pending_leaves = int(_num(cards.get("pendingLeaves") or cards.get("pending_leaves")))
#     monthly_payroll = int(_num(cards.get("monthlyPayroll") or cards.get("monthly_payroll") or cards.get("payrollThisMonth") or cards.get("payroll_this_month")))
#     total_branches = int(_num(cards.get("totalBranches") or cards.get("total_branches")))
#     avg_attendance = int(round((present_today / active_staff) * 100)) if active_staff > 0 else 0

#     branch_filter_options: list[dict] = []
#     branch_performance: list[dict] = []
#     branch_payroll_trends: list[dict] = []
#     shift_distribution: list[dict] = []
#     selected_branch_name = None
#     selected_branch_id = None
#     selected_branch_city = None

#     try:
#         sb = get_supabase_client()
#         if scope.org_id:
#             branch_rows = sb.table("branches").select("id,name,location,city,created_at").eq("org_id", scope.org_id).order("created_at").execute().data or []
#             if total_branches <= 0:
#                 total_branches = len(branch_rows)
#             resolved_branch = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#             for index, row in enumerate(branch_rows):
#                 ui_id = _branch_ui_id(row, index)
#                 name = _txt(row.get("name"), f"Branch {ui_id}")
#                 city = _txt(row.get("city") or row.get("location"), "")
#                 branch_filter_options.append({"id": ui_id, "name": name})
#                 if resolved_branch and str(row.get("id")) == str(resolved_branch):
#                     selected_branch_id = ui_id
#                     selected_branch_name = name
#                     selected_branch_city = city
#                 # Do not N+1 fetch branch staff counts here. Branch comparison can
#                 # use its own paginated/summary endpoint; overview remains fast.
#                 branch_performance.append({
#                     "branchId": ui_id,
#                     "branchName": name,
#                     "city": city,
#                     "totalStaff": 0,
#                     "presentToday": 0,
#                     "absentToday": 0,
#                     "avgAttendance": 0,
#                     "lateToday": 0,
#                     "payroll": 0,
#                     "cctvAlerts": 0,
#                 })
#                 branch_payroll_trends.append({
#                     "branchId": ui_id,
#                     "branchName": name,
#                     "totalPayroll": 0,
#                     "data": _payroll_trends(0),
#                 })

#             if resolved_branch:
#                 shift_distribution = _shift_distribution_for_branch(
#                     sb, scope.org_id, resolved_branch, scope.people_type, scope.scope_ids,
#                 )
#             elif dashboard_scope != "branch":
#                 # 'All Branches' — merge each branch's real configured
#                 # shifts into one org-wide list (see
#                 # _merge_shift_distributions' docstring for why merge-by-
#                 # name rather than one row per branch).
#                 shift_distribution = _merge_shift_distributions([
#                     _shift_distribution_for_branch(
#                         sb, scope.org_id, str(row["id"]), scope.people_type, scope.scope_ids,
#                     )
#                     for row in branch_rows
#                 ])
#     except Exception:
#         pass

#     if dashboard_scope == "branch" and not selected_branch_name and scope.branch_id:
#         selected_branch_name = f"Branch {scope.branch_id}"
#         selected_branch_id = scope.branch_id

#     today_text = time.strftime("%A, %B %d, %Y")
#     title = "Organization Overview" if dashboard_scope != "branch" else "Attendance Overview"
#     subtitle = (
#         f"All Branches · {total_branches} branches · {today_text}"
#         if dashboard_scope != "branch"
#         else f"{selected_branch_name or 'Branch'} · {today_text}"
#     )

#     stats = {
#         "totalBranches": total_branches,
#         "totalStaff": total_staff,
#         "presentToday": present_today,
#         "absentToday": absent_today,
#         "avgAttendance": avg_attendance,
#         "lateToday": late_today,
#         "earlyLeft": 0,
#         "pendingLeaves": pending_leaves,
#         "monthlyPayroll": monthly_payroll,
#         "cctvAlerts": 0,
#     }

#     data = {
#         "success": True,
#         "scope": "branch" if dashboard_scope == "branch" else "global",
#         "branchId": selected_branch_id or scope.branch_id,
#         "branchName": selected_branch_name,
#         "branchCity": selected_branch_city,
#         "title": title,
#         "subtitle": subtitle,
#         "selectedBranchId": selected_branch_id or scope.branch_id,
#         "selectedBranchName": selected_branch_name,
#         "branchFilterOptions": branch_filter_options,
#         "stats": stats,
#         "staff": [],
#         "liveLog": [],
#         "shiftDistribution": shift_distribution,
#         "todayStatus": [
#             {"name": "Present", "value": present_today},
#             {"name": "Late", "value": late_today},
#             {"name": "Absent", "value": absent_today},
#         ],
#         "weeklyAttendance": _weekly_attendance(present_today),
#         "branchWeeklyAttendance": [],
#         "pendingLeaves": [],
#         "cctvStatus": [],
#         "attendancePerformance": _attendance_performance(present_today, late_today, absent_today),
#         "branchAttendancePerformance": [],
#         "payrollTrends": _payroll_trends(monthly_payroll),
#         "branchPayrollTrends": branch_payroll_trends,
#         "branchPerformance": branch_performance,
#         "source": summary.get("source", "dashboard-direct-fallback"),
#     }
#     _cache.set(key, data, ttl_seconds)
#     return ok(data, cached=False)

# def get_fast_page(entity: str, scope: FastScope, *, page: int = 1, page_size: int = 50, search: Optional[str] = None, sort_by: Optional[str] = None, sort_dir: str = "asc", ttl_seconds: float = 3.0) -> JsonDict:
#     page = max(int(page or 1), 1)
#     page_size = max(min(int(page_size or 50), 250), 1)
#     entity = str(entity or "").strip().lower()
#     offset = (page - 1) * page_size
#     payload = {
#         "p_entity": entity,
#         "p_client_id": scope.client_id,
#         "p_org_id": scope.org_id,
#         "p_branch_id": scope.branch_id,
#         "p_search": (search or "").strip() or None,
#         "p_page_size": page_size,
#         "p_offset": offset,
#         "p_sort_col": sort_by or None,
#         "p_sort_dir": "desc" if str(sort_dir).lower() == "desc" else "asc",
#         "p_period_start": scope.period_start,
#         "p_period_end": scope.period_end,
#         # None (unscoped) vs a sorted tuple (team-scoped) must hash
#         # differently, and two different managers' teams must never
#         # collide on the same cache entry — sorted() makes the key
#         # order-independent since scope_ids is an unordered set.
#         "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
#     }
#     key = "page:" + _json_hash(payload)
#     cached = _cache.get(key)
#     if cached is not None:
#         result = ok(cached, cached=True)
#         result["page"] = page
#         return result

#     # staff/employees bypasses the generic RPC entirely, as of the
#     # 2026-07 shift-display fix. get_tenant_table_page is a generic
#     # cross-entity raw-select RPC with no visibility into this codebase from
#     # here (its SQL lives in a Supabase migration, not this repo) — it very
#     # likely does a plain `select * from client_staff`, which would carry the
#     # exact same stale shift_label/duty_start/duty_end bug _direct_staff_page
#     # had before it started calling support_db._resolve_shift_map.
#     #
#     # DECISION: correctness over the RPC's speculative perf benefit. Do not
#     # re-enable this without first confirming (reading the RPC's SQL) that it
#     # resolves client_staff.shift_id_ref against the `shifts` table the same
#     # way support_db._resolve_shift_map / _client_staff_safe now do — same
#     # precedence (shift_id_ref wins when present, legacy columns are the
#     # fallback), same fields (shift/shift_id/shift_label/duty_start/duty_end/
#     # shift_id_ref/shift_is_active). If/when the RPC is updated to do that
#     # join, delete this `if entity not in {...}` guard and let staff/
#     # employees use the RPC path like every other entity again.
#     #
#     # scope.scope_ids is None also gates this, for every entity: the RPC's
#     # SQL lives in a Supabase migration, not this repo, and has no
#     # p_scope_ids parameter — it cannot honor a 'team'-scoped caller's
#     # visibility set. Falling through to it for a team-scoped manager would
#     # silently hand back the whole org/branch. Only take the RPC path when
#     # scope_ids is None (unscoped: org/branch admin, or 'branch'-scoped).
#     if entity not in {"staff", "employees", "payroll"} and scope.scope_ids is None:
#         try:
#             data = _rpc("get_tenant_table_page", payload)

#             # Important:
#             # Some SQL RPC versions return:
#             # {"success": false, "message": "No matching table was found for entity.", "rows": []}
#             # Do not accept that failed RPC response. Fall back to direct Supabase query.
#             if (
#                 isinstance(data, dict)
#                 and data.get("success") is not False
#                 and isinstance(data.get("rows"), list)
#             ):
#                 data["page"] = page
#                 _cache.set(key, data, ttl_seconds)
#                 return ok(data, cached=False)
#         except Exception:
#             pass

#     if entity in {"staff", "employees"}:
#         data = _direct_staff_page(scope, page, page_size, search, sort_by, sort_dir)
#     elif entity == "branches":
#         data = _direct_branches_page(scope, page, page_size, search, sort_by, sort_dir)
#     elif entity == "attendance":
#         data = _direct_attendance_page(scope, page, page_size, search, sort_by, sort_dir)
#     elif entity == "leaves":
#         data = _direct_leaves_page(scope, page, page_size, search, sort_by, sort_dir)
#     elif entity == "payroll":
#         data = _direct_payroll_page(scope, page, page_size, search, sort_by, sort_dir)
#     else:
#         data = _page_result(entity, [], 0, page, page_size, offset, "unsupported")
#         data["success"] = False
#         data["message"] = "Unsupported entity."
#     _cache.set(key, data, ttl_seconds)
#     return ok(data, cached=False)


# def clear_fast_cache() -> None:
#     _cache.clear()

# """
# support_db_fast.py
# ───────────────────────────────────────────────────────────────────────────────
# App-wide fast data layer for Flask + Supabase.

# It prefers the SQL RPCs from sql/001_real_scaling_indexes_and_rpc.sql, but also
# has a safe direct-query fallback so the app does not break if the SQL was not
# run yet. Every heavy endpoint returns either a small summary or one server-side
# page; it never returns a full tenant table.
# """

# from __future__ import annotations

# import hashlib
# import json
# import os
# import time
# from dataclasses import dataclass, replace
# from threading import RLock
# from typing import Any, Dict, Optional, Tuple

# try:
#     from supabase import create_client
# except Exception:  # pragma: no cover
#     create_client = None  # type: ignore

# from support_db_core import _execute_supabase, build_or_ilike_filter

# JsonDict = Dict[str, Any]


# @dataclass(frozen=True)
# class FastScope:
#     client_id: Optional[str] = None
#     org_id: Optional[str] = None
#     branch_id: Optional[str] = None
#     people_type: Optional[str] = None
#     today: Optional[str] = None
#     # Payroll pay-period window ('YYYY-MM-DD'), display filters same as
#     # branch_id/today — not identity-scoping, safe to read from args.
#     period_start: Optional[str] = None
#     period_end: Optional[str] = None
#     # None = unscoped (org/branch admin, or 'branch'-scoped caller — same
#     # contract as client_dashboard_auth.get_team_scope_ids). A concrete
#     # frozenset restricts staff/attendance/leaves rows to that id set —
#     # see from_dashboard_user below. Deliberately NOT settable via
#     # from_args: this must only ever come from a verified token, never
#     # from a request query string.
#     scope_ids: Optional[frozenset] = None

#     @classmethod
#     def from_args(cls, args: Any) -> "FastScope":
#         """Builds a scope entirely from request args. Do NOT call this
#         directly in any /api/v2/* Flask route — org_id/branch_id here are
#         whatever the caller sent, unauthenticated. Use from_dashboard_user
#         instead, which pins the tenant-identifying fields to the verified
#         dashboard token. Kept public because non-route call sites (tests,
#         scripts) may legitimately want a scope with no auth context."""
#         def clean(value: Any) -> Optional[str]:
#             if value is None:
#                 return None
#             text = str(value).strip()
#             if not text or text.lower() in {"all", "all_branches", "null", "undefined", "none"}:
#                 return None
#             return text

#         return cls(
#             client_id=clean(args.get("clientId") or args.get("client_id") or args.get("tenantId") or args.get("tenant_id")),
#             org_id=clean(args.get("orgId") or args.get("org_id") or args.get("organizationId") or args.get("organization_id")),
#             branch_id=clean(args.get("branchId") or args.get("branch_id")),
#             people_type=clean(args.get("people_type") or args.get("peopleType") or args.get("person_type") or args.get("personType")),
#             today=clean(args.get("today") or args.get("date")),
#             period_start=clean(args.get("periodStart") or args.get("period_start")),
#             period_end=clean(args.get("periodEnd") or args.get("period_end")),
#         )

#     @classmethod
#     def from_dashboard_user(cls, dashboard_user: dict, args: Any, *, scope_ids: Optional[set] = None) -> "FastScope":
#         """The ONLY constructor every /api/v2/* route should use.

#         org_id is pinned to the verified g.dashboard_user['org_id'] —
#         never the request's orgId/organizationId/X-Organization-Id, which
#         is how this whole module was reachable cross-tenant by anyone
#         before this fix (see PATCH_NOTES: fast-path auth bypass).

#         branch_id: a client_staff row always has its own home branch_id in
#         the token, admin or not — is_admin does NOT imply branch_id is
#         None. So branch-locking only applies to a genuinely branch-scoped
#         (non-admin) account; that caller's token branch wins outright and
#         the query string can never widen it. An admin (is_admin=True) is
#         org-wide by default regardless of their own home branch, and may
#         still pass branch_id as a voluntary display filter to narrow to
#         one branch, the same trust boundary /api/staff already uses.
#         Previously this checked "token_branch_id is set" instead of
#         "caller is admin", which silently locked admins to their own
#         branch and hid every other branch's staff/payroll/attendance from
#         them — see PATCH_NOTES: admin branch-lock.

#         scope_ids: pass the caller's client_dashboard_auth.get_team_scope_ids()
#         (or get_effective_scope_ids()) result straight through — None for
#         unscoped ('branch'/admin), or the (possibly empty) subordinate-id
#         set for a 'team'-scoped caller. Never compute this locally; it
#         must come from the same single source of truth every other
#         scope-sensitive route uses.
#         """
#         base = cls.from_args(args)
#         token_org_id = str(dashboard_user.get("org_id") or "").strip() or None
#         token_branch_id = dashboard_user.get("branch_id")
#         is_admin = bool(dashboard_user.get("is_admin"))
#         resolved_branch_id = base.branch_id if is_admin else (
#             str(token_branch_id) if token_branch_id else base.branch_id
#         )
#         return replace(
#             base,
#             org_id=token_org_id,
#             branch_id=resolved_branch_id,
#             scope_ids=frozenset(scope_ids) if scope_ids is not None else None,
#         )

#     def cache_parts(self) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str]]:
#         return (self.client_id, self.org_id, self.branch_id, self.people_type, self.today)


# class TinyTTLCache:
#     def __init__(self, max_items: int = 1024) -> None:
#         self.max_items = max_items
#         self._data: Dict[str, Tuple[float, Any]] = {}
#         self._lock = RLock()

#     def get(self, key: str) -> Optional[Any]:
#         now = time.monotonic()
#         with self._lock:
#             item = self._data.get(key)
#             if not item:
#                 return None
#             expires_at, value = item
#             if expires_at < now:
#                 self._data.pop(key, None)
#                 return None
#             return value

#     def set(self, key: str, value: Any, ttl_seconds: float) -> None:
#         expires_at = time.monotonic() + max(float(ttl_seconds or 0), 0.1)
#         with self._lock:
#             if len(self._data) >= self.max_items:
#                 self._data.pop(next(iter(self._data)), None)
#             self._data[key] = (expires_at, value)

#     def clear(self) -> None:
#         with self._lock:
#             self._data.clear()


# _cache = TinyTTLCache()
# _supabase_client = None
# _supabase_lock = RLock()


# def _json_hash(value: Any) -> str:
#     return hashlib.sha1(json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")).hexdigest()


# def get_supabase_client():
#     global _supabase_client
#     with _supabase_lock:
#         if _supabase_client is not None:
#             return _supabase_client
#         if create_client is None:
#             raise RuntimeError("supabase package is not installed. Run: pip install supabase")
#         url = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
#         key = (
#             os.getenv("SUPABASE_SERVICE_ROLE_KEY")
#             or os.getenv("SUPABASE_SERVICE_KEY")
#             or os.getenv("SUPABASE_KEY")
#             or os.getenv("SUPABASE_ANON_KEY")
#             or os.getenv("VITE_SUPABASE_ANON_KEY")
#         )
#         if not url or not key:
#             raise RuntimeError("Missing SUPABASE_URL and service/anon key environment variables.")
#         _supabase_client = create_client(url, key)
#         return _supabase_client


# def ok(data: Any, *, cached: bool = False) -> JsonDict:
#     if isinstance(data, dict):
#         data.setdefault("success", True)
#         data.setdefault("cached", cached)
#         return data
#     return {"success": True, "cached": cached, "data": data}


# def fail(message: str, status: int = 500, **extra: Any) -> Tuple[JsonDict, int]:
#     body: JsonDict = {"success": False, "message": message}
#     body.update(extra)
#     return body, status


# def _rpc(name: str, payload: JsonDict) -> Any:
#     return get_supabase_client().rpc(name, payload).execute().data


# def _resolve_branch_id(sb: Any, org_id: Optional[str], branch_id: Optional[str]) -> Optional[str]:
#     """
#     Resolves a branchId query param to the real Supabase branches.id UUID.

#     Accepts either a real branch UUID (returned as-is) or a legacy numeric UI
#     ordinal (1..N). The ordinal is mapped against support_db.list_branches(),
#     the same active-only, created_at-ordered source _build_client_config uses
#     to assign ui_branch_id — this keeps ordinal resolution in sync with the
#     ids the dashboard actually displays. Previously this ran its own
#     unfiltered query, which included soft-deleted branches in the ordering
#     and silently resolved UI id 2 to a dropped row whenever a branch had
#     been replaced (e.g. Aukara: ffff0ded dropped, 6e37c4b0 active).
#     """
#     if not org_id or not branch_id:
#         return branch_id
#     text = str(branch_id).strip()
#     if not text:
#         return None
#     try:
#         import support_db  # local import: avoids a hard circular import at module load time
#         branches = support_db.list_branches(org_id)  # include_dropped=False by default
#         ids = [str(b.get("id")) for b in branches if b.get("id")]
#         if text in ids:
#             return text
#         if text.isdigit():
#             idx = int(text) - 1
#             if 0 <= idx < len(ids):
#                 return ids[idx]
#     except Exception:
#         return text
#     return text


# def _safe_count(query: Any) -> int:
#     try:
#         # PostgREST still calculates the exact count but returns at most one row.
#         # Routed through _execute_supabase so a blocked/rejected request is
#         # classified (and, for transient infra blips, retried) the same way
#         # every other Supabase call in the app is, instead of this being the
#         # one path that silently swallows every exception shape.
#         result = _execute_supabase("fast.safe_count", lambda: query.limit(1))
#         return int(getattr(result, "count", None) or 0)
#     except Exception:
#         return 0


# def _order(query: Any, sort_by: Optional[str], sort_dir: str, allowed: set[str], default: str):
#     col = sort_by if sort_by in allowed else default
#     return query.order(col, desc=str(sort_dir).lower() == "desc")


# def _or_search(query: Any, search: Optional[str], cols: list[str]):
#     """Apply a safe, case-insensitive OR-across-columns search filter.

#     See support_db_core.build_or_ilike_filter for why this can't just
#     strip '%'/',' from the raw text (that was the old implementation, and
#     it neither preserved user intent nor actually prevented a search term
#     from redefining the filter's structure).
#     """
#     clause = build_or_ilike_filter(search, cols)
#     return query.or_(clause) if clause else query


# def _page_result(entity: str, rows: list[dict], total: int, page: int, page_size: int, offset: int, table: str) -> JsonDict:
#     return {
#         "success": True,
#         "entity": entity,
#         "table": table,
#         "rows": rows,
#         "total": int(total or 0),
#         "page": page,
#         "pageSize": page_size,
#         "offset": offset,
#         "hasMore": offset + len(rows) < int(total or 0),
#     }


# def _direct_staff_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
#     if not scope.org_id:
#         return _page_result("staff", [], 0, page, page_size, (page - 1) * page_size, "client_staff")
#     # A 'team'-scoped caller with zero reports is a real, distinct value —
#     # short-circuit to an empty page rather than let an empty .in_([]) fall
#     # through to Postgrest (which some client versions treat as "no filter"
#     # applied, i.e. the whole org back). Same "empty set != no filter"
#     # contract as client_dashboard_auth.filter_rows_by_scope.
#     if scope.scope_ids is not None and not scope.scope_ids:
#         return _page_result("staff", [], 0, page, page_size, (page - 1) * page_size, "client_staff")

#     sb = get_supabase_client()
#     branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#     # Deliberately does NOT filter .eq("role", "staff") — the Staff
#     # Directory is a roster of everyone in the org, and an admin is still
#     # an employee, not a separate account type that exits the roster (see
#     # list_client_staff's role='staff' default in support_db_staff.py,
#     # which had the same assumption baked in — a client_staff row promoted
#     # to admin would silently vanish from every directory/count view that
#     # called either function). scope_ids (team-scope) still applies below,
#     # so a team-scoped manager's view is unaffected by this change.
#     base = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False)
#     if branch_id:
#         base = base.eq("branch_id", branch_id)
#     if scope.people_type:
#         base = base.eq("people_type", scope.people_type)
#     if scope.scope_ids is not None:
#         base = base.in_("id", list(scope.scope_ids))
#     base = _or_search(base, search, ["name", "email", "employee_id", "department_name", "role_name", "phone"])
#     total = _safe_count(base)

#     query = sb.table("client_staff").select("*").eq("org_id", scope.org_id).eq("is_archived", False)
#     if branch_id:
#         query = query.eq("branch_id", branch_id)
#     if scope.people_type:
#         query = query.eq("people_type", scope.people_type)
#     if scope.scope_ids is not None:
#         query = query.in_("id", list(scope.scope_ids))
#     query = _or_search(query, search, ["name", "email", "employee_id", "department_name", "role_name", "phone"])
#     query = _order(query, sort_by, sort_dir, {"name", "email", "employee_id", "department_name", "role_name", "salary", "status", "created_at", "updated_at"}, "name")
#     offset = (page - 1) * page_size
#     # Routed through _execute_supabase rather than a bare `.execute()` so a
#     # rejected/blocked request (WAF, malformed filter, upstream outage) is
#     # classified into a clean ValueError/RuntimeError instead of an
#     # unhandled postgrest/pydantic exception reaching the route layer as an
#     # opaque 500 -- this was the actual query on the Staff Search path
#     # involved in the WAF-crash bug.
#     result = _execute_supabase(
#         "fast.staff_page.rows",
#         lambda: query.range(offset, offset + page_size - 1),
#     )
#     rows = result.data or []
#     try:
#         import support_db  # local project mapper keeps camelCase aliases and UI branch ids consistent
#         shifts_by_id = support_db._resolve_shift_map(
#             scope.org_id, {row.get('shift_id_ref') for row in rows}
#         )
#         rows = [
#             support_db._client_staff_safe(row, scope.org_id, shifts_by_id=shifts_by_id)
#             for row in rows
#         ]
#     except Exception:
#         pass
#     return _page_result("staff", rows, total, page, page_size, offset, "client_staff")


# def _direct_branches_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
#     """
#     Branch counts per org are small (single digits to low tens), so unlike
#     staff/attendance this filters/sorts/paginates in Python over
#     support_db.list_branches() rather than re-querying Supabase with its own
#     filter set. This is deliberate: it's the same active-only, created_at
#     source _build_client_config and _resolve_branch_id use, so "what counts
#     as a branch" can never drift across these three call sites again.
#     """
#     if not scope.org_id:
#         return _page_result("branches", [], 0, page, page_size, (page - 1) * page_size, "branches")
#     import support_db
#     rows = support_db.list_branches(scope.org_id)  # include_dropped=False by default

#     text = (search or "").strip().lower()
#     if text:
#         rows = [
#             r for r in rows
#             if text in str(r.get("name") or "").lower() or text in str(r.get("location") or "").lower()
#         ]

#     sort_col = sort_by if sort_by in {"name", "location", "created_at", "max_staff_capacity"} else "created_at"
#     reverse = str(sort_dir).lower() == "desc"
#     rows = sorted(rows, key=lambda r: (r.get(sort_col) is None, r.get(sort_col)), reverse=reverse)

#     total = len(rows)
#     offset = (page - 1) * page_size
#     page_rows = rows[offset: offset + page_size]
#     return _page_result("branches", page_rows, total, page, page_size, offset, "branches")


# def _direct_attendance_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
#     if not scope.org_id:
#         return _page_result("attendance", [], 0, page, page_size, (page - 1) * page_size, "attendance")
#     if scope.scope_ids is not None and not scope.scope_ids:
#         return _page_result("attendance", [], 0, page, page_size, (page - 1) * page_size, "attendance")

#     sb = get_supabase_client()
#     branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#     base = sb.table("attendance").select("id", count="exact").eq("org_id", scope.org_id)
#     if branch_id:
#         base = base.eq("branch_id", branch_id)
#     if scope.today:
#         base = base.gte("timestamp", f"{scope.today}T00:00:00").lt("timestamp", f"{scope.today}T23:59:59")
#     if scope.scope_ids is not None:
#         base = base.in_("staff_id", list(scope.scope_ids))
#     total = _safe_count(base)
#     query = sb.table("attendance").select("*").eq("org_id", scope.org_id)
#     if branch_id:
#         query = query.eq("branch_id", branch_id)
#     if scope.today:
#         query = query.gte("timestamp", f"{scope.today}T00:00:00").lt("timestamp", f"{scope.today}T23:59:59")
#     if scope.scope_ids is not None:
#         query = query.in_("staff_id", list(scope.scope_ids))
#     query = _order(query, sort_by, sort_dir, {"timestamp", "created_at", "confidence", "source"}, "timestamp")
#     offset = (page - 1) * page_size
#     rows = query.range(offset, offset + page_size - 1).execute().data or []
#     return _page_result("attendance", rows, total, page, page_size, offset, "attendance")


# def _direct_leaves_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
#     if not scope.org_id:
#         return _page_result("leaves", [], 0, page, page_size, (page - 1) * page_size, "leave_requests")
#     if scope.scope_ids is not None and not scope.scope_ids:
#         return _page_result("leaves", [], 0, page, page_size, (page - 1) * page_size, "leave_requests")

#     sb = get_supabase_client()
#     branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#     base = sb.table("leave_requests").select("id", count="exact").eq("org_id", scope.org_id)
#     if branch_id:
#         base = base.eq("branch_id", branch_id)
#     if scope.scope_ids is not None:
#         base = base.in_("staff_id", list(scope.scope_ids))
#     base = _or_search(base, search, ["reason", "status", "leave_type"])
#     total = _safe_count(base)
#     query = sb.table("leave_requests").select("*").eq("org_id", scope.org_id)
#     if branch_id:
#         query = query.eq("branch_id", branch_id)
#     if scope.scope_ids is not None:
#         query = query.in_("staff_id", list(scope.scope_ids))
#     query = _or_search(query, search, ["reason", "status", "leave_type"])
#     query = _order(query, sort_by, sort_dir, {"created_at", "start_date", "end_date", "status", "leave_type"}, "created_at")
#     offset = (page - 1) * page_size
#     rows = query.range(offset, offset + page_size - 1).execute().data or []
#     return _page_result("leaves", rows, total, page, page_size, offset, "leave_requests")


# def _direct_payroll_page(
#     scope: FastScope,
#     page: int,
#     page_size: int,
#     search: Optional[str],
#     sort_by: Optional[str],
#     sort_dir: str,
# ) -> JsonDict:
#     """Delegates to support_db_payroll.get_client_payroll_page — the single
#     source of truth for turning client_staff + salary_configs + real
#     attendance/leave/overtime data into a payroll row via
#     payroll_engine.compute_payroll_breakdown (deductions/net_pay/status,
#     including unpaid-leave/late/half-day deductions).

#     This used to be a parallel ~140-line reimplementation of that same
#     pipeline (staff paging, per-branch attendance/leave batching, policy
#     resolution, breakdown computation) that had quietly drifted from it:
#     it resolved per-branch payroll-policy overrides using the UI branch id
#     instead of the backend branch UUID payroll_policy_overrides is actually
#     keyed on (compare get_client_payroll_page's own resolve_policy, which
#     uses staff['branch_id'] — the backend UUID). That made any branch-level
#     leaveTypeRules/lateComingPolicy override invisible on this fast-page
#     path (the one usePayrollData.ts actually calls) while it worked
#     correctly on GET /api/v2/payroll/page. Delegating removes the second
#     implementation outright, so the two paths cannot drift apart again —
#     one computation, two thin callers.

#     Deliberately unscoped from the caller's team-scope (scope_ids), even
#     for a 'team'-scoped manager: Payroll access is a module-access grant
#     (access_modules), not a hierarchy grant — see client_dashboard_auth.py's
#     get_team_scope_ids docstring ("Payroll / salary routes ignore
#     dashboard_scope entirely") and get_client_payroll_page, which never
#     reads scope_ids for the same reason.
#     """
#     offset = (page - 1) * page_size
#     if not scope.org_id:
#         return _page_result("payroll", [], 0, page, page_size, offset, "client_staff/salary_configs")

#     import support_db as _support_db

#     try:
#         page_data = _support_db.get_client_payroll_page(
#             scope.org_id,
#             branch_id=scope.branch_id,
#             page=page,
#             page_size=page_size,
#             search=search,
#             sort_by=sort_by or "name",
#             sort_dir=sort_dir,
#             period_start=scope.period_start,
#             period_end=scope.period_end,
#         )
#     except ValueError as exc:
#         return {
#             **_page_result("payroll", [], 0, page, page_size, offset, "client_staff/salary_configs"),
#             "success": False,
#             "message": str(exc),
#         }

#     rows = page_data.get("rows") or []
#     total = int(page_data.get("total") or 0)
#     return {
#         "entity": "payroll",
#         "table": "client_staff/salary_configs",
#         "rows": rows,
#         "total": total,
#         "page": int(page_data.get("page") or page),
#         "pageSize": int(page_data.get("pageSize") or page_size),
#         "offset": offset,
#         "hasMore": offset + len(rows) < total,
#     }




# def _num(value: Any, fallback: float = 0) -> float:
#     try:
#         parsed = float(value or 0)
#         return parsed if parsed == parsed else fallback
#     except Exception:
#         return fallback


# def _txt(value: Any, fallback: str = "") -> str:
#     text = str(value or "").strip()
#     return text or fallback


# def _month_labels() -> list[str]:
#     labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
#     month_index = int(time.strftime("%m")) - 1
#     return [labels[(month_index - (5 - idx)) % 12] for idx in range(6)]


# def _payroll_trends(total: float) -> list[dict]:
#     weights = [0.82, 0.87, 0.91, 0.94, 0.97, 1.0]
#     return [
#         {"month": month, "Payroll": int(round(total * weights[idx])), "Overtime": 0}
#         for idx, month in enumerate(_month_labels())
#     ]


# def _weekly_attendance(present_today: int) -> list[dict]:
#     labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
#     today_idx = int(time.strftime("%u")) - 1
#     ordered = [labels[(today_idx - (6 - idx)) % 7] for idx in range(7)]
#     return [{"day": day, "count": int(present_today if idx == 6 else 0)} for idx, day in enumerate(ordered)]


# def _attendance_performance(present: int, late: int, absent: int) -> list[dict]:
#     return [
#         {"month": month, "On Time": int(present if idx == 5 else 0), "Late": int(late if idx == 5 else 0), "Absent": int(absent if idx == 5 else 0)}
#         for idx, month in enumerate(_month_labels())
#     ]


# def _branch_ui_id(row: dict, index: int) -> int:
#     for key in ("ui_id", "branch_ui_id", "display_id"):
#         val = row.get(key)
#         try:
#             n = int(val)
#             if n > 0:
#                 return n
#         except Exception:
#             pass
#     return index + 1


# def _sum_staff_salary(sb: Any, org_id: str, branch_id: Optional[str], scope_ids: Optional[frozenset] = None) -> float:
#     """Direct fallback for monthly payroll.

#     This is intentionally small-field only. The preferred production path is the
#     SQL RPC, which computes the sum inside Postgres. The fallback keeps local
#     installs working even before SQL is applied.

#     scope_ids: None = org/branch-wide (unscoped). A frozenset restricts the
#     sum to those client_staff ids — a 'team'-scoped manager's payroll card
#     reflects their own reports' salaries, not the whole branch/org's.
#     """
#     if scope_ids is not None and not scope_ids:
#         return 0.0
#     try:
#         query = sb.table("client_staff").select("salary,basic_salary,status").eq("org_id", org_id).eq("is_archived", False).eq("role", "staff")
#         if branch_id:
#             query = query.eq("branch_id", branch_id)
#         if scope_ids is not None:
#             query = query.in_("id", list(scope_ids))
#         rows = query.execute().data or []
#         total = 0.0
#         for row in rows:
#             if str(row.get("status") or "").lower() == "inactive":
#                 continue
#             total += _num(row.get("salary") or row.get("basic_salary"))
#         return total
#     except Exception:
#         return 0.0

# def _format_shift_time(check_in_time: Any, check_out_time: Any) -> str:
#     """'09:00:00'/'17:00:00' -> '09:00 – 17:00', matching the display format
#     the Shift Distribution card already renders (and _resolve_shift_map's
#     own [:5] truncation convention in support_db.py)."""
#     start = str(check_in_time or "")[:5] or "--:--"
#     end = str(check_out_time or "")[:5] if check_out_time else None
#     return f"{start} – {end}" if end else f"{start} · Flexible"


# def _shift_distribution_for_branch(
#     sb: Any,
#     org_id: str,
#     branch_id: str,
#     people_type: Optional[str],
#     scope_ids: Optional[frozenset],
# ) -> list[dict]:
#     """Real shift distribution for one branch — support_db_shifts.py's
#     `shifts` table is the sole source of truth (see support_db.py's
#     _resolve_shift_map docstring), the same table StaffManagement.tsx's
#     Shift Allocation tab reads via listBranchShifts(). This intentionally
#     replaces the old hardcoded 4-row Morning/Evening/Night/Custom
#     placeholder list, which could never represent a branch's actual
#     configured shifts.

#     Every active shift configured for this branch is returned, even ones
#     with zero staff currently assigned — staffCount stays 0, the shift row
#     itself is never dropped.

#     scope_ids follows the exact contract every other card on this endpoint
#     already uses (see _sum_staff_salary above): None = unscoped
#     (org/branch admin, or a 'branch'-scoped caller), a non-empty frozenset
#     = restrict counts to that manager's own team, and an EMPTY frozenset
#     means a 'team'-scoped manager with zero direct reports — every shift
#     must show 0, not silently fall back to the branch-wide count.
#     """
#     if not org_id or not branch_id:
#         return []

#     # local import: avoids a hard circular import at module load time, same
#     # pattern _resolve_branch_id already uses for support_db.
#     import support_db

#     normalized_people_type = (
#         support_db._normalize_people_type(people_type) if people_type else None
#     )

#     shifts_query = (
#         sb.table("shifts")
#         .select("id,name,check_in_time,check_out_time")
#         .eq("org_id", org_id)
#         .eq("branch_id", branch_id)
#         .eq("is_active", True)
#         .order("check_in_time")
#     )
#     if normalized_people_type:
#         shifts_query = shifts_query.eq("people_type", normalized_people_type)
#     shift_rows = shifts_query.execute().data or []
#     if not shift_rows:
#         return []

#     counts: dict[str, int] = {}
#     if scope_ids is None or scope_ids:
#         staff_query = (
#             sb.table("client_staff")
#             .select("shift_id_ref")
#             .eq("org_id", org_id)
#             .eq("branch_id", branch_id)
#             .eq("is_archived", False)
#         )
#         if normalized_people_type and support_db._client_staff_has_people_type_column():
#             staff_query = staff_query.eq("people_type", normalized_people_type)
#         if scope_ids is not None:
#             staff_query = staff_query.in_("id", list(scope_ids))
#         for row in staff_query.execute().data or []:
#             shift_id = row.get("shift_id_ref")
#             if shift_id:
#                 counts[str(shift_id)] = counts.get(str(shift_id), 0) + 1
#     # else: scope_ids == frozenset() — a team-scoped manager with zero
#     # direct reports. counts stays empty, every shift correctly shows 0.

#     return [
#         {
#             "key": str(row["id"]),
#             "label": row.get("name") or "Shift",
#             "time": _format_shift_time(row.get("check_in_time"), row.get("check_out_time")),
#             "staffCount": counts.get(str(row["id"]), 0),
#             "departments": [],
#             "branches": [],
#             "members": [],
#         }
#         for row in shift_rows
#     ]


# def _merge_shift_distributions(per_branch: list[list[dict]]) -> list[dict]:
#     """'All Branches' view: shifts are a per-branch concept, so there is no
#     single real row to return per shift. Same-named shifts across branches
#     are merged (their staffCount summed) rather than shown as separate
#     rows — the same "one org-wide picture" convention this endpoint
#     already applies to every other All-Branches stat (totalStaff,
#     presentToday, etc. are org-wide sums, not one row per branch).
#     Differently-named shifts across branches each keep their own row.
#     """
#     merged: dict[str, dict] = {}
#     order: list[str] = []
#     for shifts in per_branch:
#         for shift in shifts:
#             name_key = str(shift["label"]).strip().lower()
#             if name_key not in merged:
#                 merged[name_key] = {**shift, "key": name_key}
#                 order.append(name_key)
#             else:
#                 merged[name_key]["staffCount"] += shift["staffCount"]
#     return [merged[key] for key in order]


# def get_fast_summary(scope: FastScope, *, ttl_seconds: float = 6.0) -> JsonDict:
#     payload = {
#         "p_client_id": scope.client_id,
#         "p_org_id": scope.org_id,
#         "p_branch_id": scope.branch_id,
#         "p_today": scope.today,
#         # See get_fast_page's identical field: must be in the cache key or
#         # two managers with different teams (or a manager vs. the branch
#         # admin) can be served each other's cached card numbers.
#         "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
#     }
#     key = "summary:" + _json_hash(payload)
#     cached = _cache.get(key)
#     if cached is not None:
#         return ok(cached, cached=True)

#     # A 'team'-scoped caller's cards must come from the direct-query path
#     # below, never the RPC — get_tenant_fast_summary's SQL (a Supabase
#     # migration, not this repo) has no p_scope_ids parameter and would
#     # return org/branch-wide numbers to a manager who should only see
#     # their own team.
#     if scope.scope_ids is None:
#         try:
#             data = _rpc("get_tenant_fast_summary", payload)
#             if isinstance(data, dict):
#                 _cache.set(key, data, ttl_seconds)
#                 return ok(data, cached=False)
#         except Exception:
#             pass

#     # Direct summary fallback with count='exact' only; no full-table scans in Python.
#     sb = get_supabase_client()
#     branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#     # Dashboard OVERVIEW CARDS now respect team scope too (explicit product
#     # decision, reversing this function's earlier "cards are always org/
#     # branch-wide" behavior) — a 'team'-scoped manager's people/attendance/
#     # leave cards (totalStaff/presentToday/absentToday/pendingLeaves)
#     # reflect only themself + their reports, same as the Staff/Attendance/
#     # Leave LIST pages already did via scope.scope_ids on
#     # _direct_staff_page/_direct_attendance_page/_direct_leaves_page. An
#     # unscoped ('branch'/admin) caller is scope.scope_ids=None here, so this
#     # is a no-op change for every existing admin/branch-wide session.
#     #
#     # Payroll is the one exception, deliberately: it's a module-access grant
#     # (access_modules), not a hierarchy grant — same reasoning
#     # _direct_payroll_page already documents and client_dashboard_auth.py's
#     # get_team_scope_ids docstring states outright ("Payroll / salary routes
#     # ignore dashboard_scope entirely"). A manager who also has Payroll
#     # access sees the same branch/org-wide payroll figure any other
#     # Payroll-enabled account would, so it keeps its own always-unscoped id
#     # set rather than reusing card_scope_ids.
#     card_scope_ids = scope.scope_ids
#     payroll_scope_ids = None
#     cards = {"totalStaff": 0, "activeStaff": 0, "totalBranches": 0, "presentToday": 0, "absentToday": 0, "lateToday": 0, "pendingLeaves": 0, "payrollThisMonth": 0, "monthlyPayroll": 0}
#     # Zero reports is a real, distinct value (matches the same contract
#     # used everywhere else in this codebase for an empty team) — every
#     # people-related card is legitimately 0 without ever hitting Supabase.
#     # totalBranches is left out of this short-circuit deliberately: branch
#     # count is an org-structure fact, not "my team's data," same reasoning
#     # applied to it below. Payroll is also computed outside this
#     # short-circuit (see payroll_scope_ids above) — an empty team still
#     # gets the real branch/org payroll figure, not zero.
#     team_is_empty = card_scope_ids is not None and not card_scope_ids
#     if scope.org_id and not team_is_empty:
#         staff_q = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False).eq("role", "staff")
#         active_q = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False).eq("role", "staff").neq("status", "inactive")
#         if branch_id:
#             staff_q = staff_q.eq("branch_id", branch_id)
#             active_q = active_q.eq("branch_id", branch_id)
#         if card_scope_ids is not None:
#             staff_q = staff_q.in_("id", list(card_scope_ids))
#             active_q = active_q.in_("id", list(card_scope_ids))
#         cards["totalStaff"] = _safe_count(staff_q)
#         cards["activeStaff"] = _safe_count(active_q)
#         today = scope.today or time.strftime("%Y-%m-%d")
#         aq = sb.table("attendance").select("staff_id", count="exact").eq("org_id", scope.org_id).gte("timestamp", f"{today}T00:00:00").lt("timestamp", f"{today}T23:59:59")
#         if branch_id:
#             aq = aq.eq("branch_id", branch_id)
#         if card_scope_ids is not None:
#             aq = aq.in_("staff_id", list(card_scope_ids))
#         cards["presentToday"] = _safe_count(aq)
#         cards["absentToday"] = max(0, cards["activeStaff"] - cards["presentToday"])
#         lq = sb.table("leave_requests").select("id", count="exact").eq("org_id", scope.org_id).eq("status", "pending")
#         if branch_id:
#             lq = lq.eq("branch_id", branch_id)
#         if card_scope_ids is not None:
#             lq = lq.in_("staff_id", list(card_scope_ids))
#         cards["pendingLeaves"] = _safe_count(lq)
#     if scope.org_id:
#         cards["payrollThisMonth"] = int(round(_sum_staff_salary(sb, scope.org_id, branch_id, payroll_scope_ids)))
#         cards["monthlyPayroll"] = cards["payrollThisMonth"]
#     # totalBranches stays org-wide regardless of scope_ids — a manager's
#     # "team" is a set of people, not a set of branches; narrowing this
#     # count to "branches my reports happen to sit in" isn't a meaningful
#     # metric and no part of this feature has ever asked for it.
#     if scope.org_id:
#         bq = sb.table("branches").select("id", count="exact").eq("org_id", scope.org_id)
#         cards["totalBranches"] = _safe_count(bq)
#     totals = {
#         "totalStaff": cards["totalStaff"],
#         "activeStaff": cards["activeStaff"],
#         "totalBranches": cards["totalBranches"],
#         "presentToday": cards["presentToday"],
#         "absentToday": cards["absentToday"],
#         "lateToday": cards["lateToday"],
#         "pendingLeaves": cards["pendingLeaves"],
#         "monthlyPayroll": cards["monthlyPayroll"],
#         "payrollThisMonth": cards["payrollThisMonth"],
#     }
#     data = {"success": True, "cards": cards, "totals": totals, "stats": totals, "scope": {"orgId": scope.org_id, "branchId": scope.branch_id}, "source": "direct-fallback"}
#     _cache.set(key, data, ttl_seconds)
#     return ok(data, cached=False)




# def get_fast_dashboard_overview(scope: FastScope, dashboard_scope: str = "global", *, ttl_seconds: float = 6.0) -> JsonDict:
#     """One small payload for dashboard overview cards/charts.

#     This endpoint replaces multiple dashboard-side requests. It returns a stable
#     object shape so React can render one complete layout instead of one card,
#     then fake zeros, then real data.
#     """
#     payload = {
#         "p_client_id": scope.client_id,
#         "p_org_id": scope.org_id,
#         "p_branch_id": scope.branch_id,
#         "p_today": scope.today,
#         "p_people_type": scope.people_type,
#         "dashboard_scope": dashboard_scope,
#         "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
#     }
#     key = "dashboard-overview:" + _json_hash(payload)
#     cached = _cache.get(key)
#     if cached is not None:
#         return ok(cached, cached=True)

#     # Prefer an RPC if you add it later. Fallback stays compatible today.
#     # Skipped entirely for a team-scoped caller — get_tenant_dashboard_overview's
#     # SQL has no p_scope_ids parameter (same reasoning as get_fast_summary).
#     if scope.scope_ids is None:
#         try:
#             rpc_data = _rpc("get_tenant_dashboard_overview", payload)
#             if isinstance(rpc_data, dict):
#                 _cache.set(key, rpc_data, ttl_seconds)
#                 return ok(rpc_data, cached=False)
#         except Exception:
#             pass

#     summary = get_fast_summary(scope, ttl_seconds=ttl_seconds)
#     cards = summary.get("cards") or summary.get("stats") or summary.get("totals") or {}

#     total_staff = int(_num(cards.get("totalStaff") or cards.get("total_staff")))
#     active_staff = int(_num(cards.get("activeStaff") or cards.get("active_staff") or total_staff))
#     present_today = int(_num(cards.get("presentToday") or cards.get("present_today")))
#     late_today = int(_num(cards.get("lateToday") or cards.get("late_today")))
#     absent_today = int(_num(cards.get("absentToday") or cards.get("absent_today") or max(active_staff - present_today, 0)))
#     pending_leaves = int(_num(cards.get("pendingLeaves") or cards.get("pending_leaves")))
#     monthly_payroll = int(_num(cards.get("monthlyPayroll") or cards.get("monthly_payroll") or cards.get("payrollThisMonth") or cards.get("payroll_this_month")))
#     total_branches = int(_num(cards.get("totalBranches") or cards.get("total_branches")))
#     avg_attendance = int(round((present_today / active_staff) * 100)) if active_staff > 0 else 0

#     branch_filter_options: list[dict] = []
#     branch_performance: list[dict] = []
#     branch_payroll_trends: list[dict] = []
#     shift_distribution: list[dict] = []
#     selected_branch_name = None
#     selected_branch_id = None
#     selected_branch_city = None

#     try:
#         sb = get_supabase_client()
#         if scope.org_id:
#             branch_rows = sb.table("branches").select("id,name,location,city,created_at").eq("org_id", scope.org_id).order("created_at").execute().data or []
#             if total_branches <= 0:
#                 total_branches = len(branch_rows)
#             resolved_branch = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
#             for index, row in enumerate(branch_rows):
#                 ui_id = _branch_ui_id(row, index)
#                 name = _txt(row.get("name"), f"Branch {ui_id}")
#                 city = _txt(row.get("city") or row.get("location"), "")
#                 branch_filter_options.append({"id": ui_id, "name": name})
#                 if resolved_branch and str(row.get("id")) == str(resolved_branch):
#                     selected_branch_id = ui_id
#                     selected_branch_name = name
#                     selected_branch_city = city
#                 # Do not N+1 fetch branch staff counts here. Branch comparison can
#                 # use its own paginated/summary endpoint; overview remains fast.
#                 branch_performance.append({
#                     "branchId": ui_id,
#                     "branchName": name,
#                     "city": city,
#                     "totalStaff": 0,
#                     "presentToday": 0,
#                     "absentToday": 0,
#                     "avgAttendance": 0,
#                     "lateToday": 0,
#                     "payroll": 0,
#                     "cctvAlerts": 0,
#                 })
#                 branch_payroll_trends.append({
#                     "branchId": ui_id,
#                     "branchName": name,
#                     "totalPayroll": 0,
#                     "data": _payroll_trends(0),
#                 })

#             if resolved_branch:
#                 shift_distribution = _shift_distribution_for_branch(
#                     sb, scope.org_id, resolved_branch, scope.people_type, scope.scope_ids,
#                 )
#             elif dashboard_scope != "branch":
#                 # 'All Branches' — merge each branch's real configured
#                 # shifts into one org-wide list (see
#                 # _merge_shift_distributions' docstring for why merge-by-
#                 # name rather than one row per branch).
#                 shift_distribution = _merge_shift_distributions([
#                     _shift_distribution_for_branch(
#                         sb, scope.org_id, str(row["id"]), scope.people_type, scope.scope_ids,
#                     )
#                     for row in branch_rows
#                 ])
#     except Exception:
#         pass

#     if dashboard_scope == "branch" and not selected_branch_name and scope.branch_id:
#         selected_branch_name = f"Branch {scope.branch_id}"
#         selected_branch_id = scope.branch_id

#     today_text = time.strftime("%A, %B %d, %Y")
#     title = "Organization Overview" if dashboard_scope != "branch" else "Attendance Overview"
#     subtitle = (
#         f"All Branches · {total_branches} branches · {today_text}"
#         if dashboard_scope != "branch"
#         else f"{selected_branch_name or 'Branch'} · {today_text}"
#     )

#     stats = {
#         "totalBranches": total_branches,
#         "totalStaff": total_staff,
#         "presentToday": present_today,
#         "absentToday": absent_today,
#         "avgAttendance": avg_attendance,
#         "lateToday": late_today,
#         "earlyLeft": 0,
#         "pendingLeaves": pending_leaves,
#         "monthlyPayroll": monthly_payroll,
#         "cctvAlerts": 0,
#     }

#     data = {
#         "success": True,
#         "scope": "branch" if dashboard_scope == "branch" else "global",
#         "branchId": selected_branch_id or scope.branch_id,
#         "branchName": selected_branch_name,
#         "branchCity": selected_branch_city,
#         "title": title,
#         "subtitle": subtitle,
#         "selectedBranchId": selected_branch_id or scope.branch_id,
#         "selectedBranchName": selected_branch_name,
#         "branchFilterOptions": branch_filter_options,
#         "stats": stats,
#         "staff": [],
#         "liveLog": [],
#         "shiftDistribution": shift_distribution,
#         "todayStatus": [
#             {"name": "Present", "value": present_today},
#             {"name": "Late", "value": late_today},
#             {"name": "Absent", "value": absent_today},
#         ],
#         "weeklyAttendance": _weekly_attendance(present_today),
#         "branchWeeklyAttendance": [],
#         "pendingLeaves": [],
#         "cctvStatus": [],
#         "attendancePerformance": _attendance_performance(present_today, late_today, absent_today),
#         "branchAttendancePerformance": [],
#         "payrollTrends": _payroll_trends(monthly_payroll),
#         "branchPayrollTrends": branch_payroll_trends,
#         "branchPerformance": branch_performance,
#         "source": summary.get("source", "dashboard-direct-fallback"),
#     }
#     _cache.set(key, data, ttl_seconds)
#     return ok(data, cached=False)

# def get_fast_page(entity: str, scope: FastScope, *, page: int = 1, page_size: int = 50, search: Optional[str] = None, sort_by: Optional[str] = None, sort_dir: str = "asc", ttl_seconds: float = 3.0) -> JsonDict:
#     page = max(int(page or 1), 1)
#     page_size = max(min(int(page_size or 50), 250), 1)
#     entity = str(entity or "").strip().lower()
#     offset = (page - 1) * page_size
#     payload = {
#         "p_entity": entity,
#         "p_client_id": scope.client_id,
#         "p_org_id": scope.org_id,
#         "p_branch_id": scope.branch_id,
#         "p_search": (search or "").strip() or None,
#         "p_page_size": page_size,
#         "p_offset": offset,
#         "p_sort_col": sort_by or None,
#         "p_sort_dir": "desc" if str(sort_dir).lower() == "desc" else "asc",
#         "p_period_start": scope.period_start,
#         "p_period_end": scope.period_end,
#         # None (unscoped) vs a sorted tuple (team-scoped) must hash
#         # differently, and two different managers' teams must never
#         # collide on the same cache entry — sorted() makes the key
#         # order-independent since scope_ids is an unordered set.
#         "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
#     }
#     key = "page:" + _json_hash(payload)
#     cached = _cache.get(key)
#     if cached is not None:
#         result = ok(cached, cached=True)
#         result["page"] = page
#         return result

#     # staff/employees bypasses the generic RPC entirely, as of the
#     # 2026-07 shift-display fix. get_tenant_table_page is a generic
#     # cross-entity raw-select RPC with no visibility into this codebase from
#     # here (its SQL lives in a Supabase migration, not this repo) — it very
#     # likely does a plain `select * from client_staff`, which would carry the
#     # exact same stale shift_label/duty_start/duty_end bug _direct_staff_page
#     # had before it started calling support_db._resolve_shift_map.
#     #
#     # DECISION: correctness over the RPC's speculative perf benefit. Do not
#     # re-enable this without first confirming (reading the RPC's SQL) that it
#     # resolves client_staff.shift_id_ref against the `shifts` table the same
#     # way support_db._resolve_shift_map / _client_staff_safe now do — same
#     # precedence (shift_id_ref wins when present, legacy columns are the
#     # fallback), same fields (shift/shift_id/shift_label/duty_start/duty_end/
#     # shift_id_ref/shift_is_active). If/when the RPC is updated to do that
#     # join, delete this `if entity not in {...}` guard and let staff/
#     # employees use the RPC path like every other entity again.
#     #
#     # scope.scope_ids is None also gates this, for every entity: the RPC's
#     # SQL lives in a Supabase migration, not this repo, and has no
#     # p_scope_ids parameter — it cannot honor a 'team'-scoped caller's
#     # visibility set. Falling through to it for a team-scoped manager would
#     # silently hand back the whole org/branch. Only take the RPC path when
#     # scope_ids is None (unscoped: org/branch admin, or 'branch'-scoped).
#     if entity not in {"staff", "employees", "payroll"} and scope.scope_ids is None:
#         try:
#             data = _rpc("get_tenant_table_page", payload)

#             # Important:
#             # Some SQL RPC versions return:
#             # {"success": false, "message": "No matching table was found for entity.", "rows": []}
#             # Do not accept that failed RPC response. Fall back to direct Supabase query.
#             if (
#                 isinstance(data, dict)
#                 and data.get("success") is not False
#                 and isinstance(data.get("rows"), list)
#             ):
#                 data["page"] = page
#                 _cache.set(key, data, ttl_seconds)
#                 return ok(data, cached=False)
#         except Exception:
#             pass

#     if entity in {"staff", "employees"}:
#         data = _direct_staff_page(scope, page, page_size, search, sort_by, sort_dir)
#     elif entity == "branches":
#         data = _direct_branches_page(scope, page, page_size, search, sort_by, sort_dir)
#     elif entity == "attendance":
#         data = _direct_attendance_page(scope, page, page_size, search, sort_by, sort_dir)
#     elif entity == "leaves":
#         data = _direct_leaves_page(scope, page, page_size, search, sort_by, sort_dir)
#     elif entity == "payroll":
#         data = _direct_payroll_page(scope, page, page_size, search, sort_by, sort_dir)
#     else:
#         data = _page_result(entity, [], 0, page, page_size, offset, "unsupported")
#         data["success"] = False
#         data["message"] = "Unsupported entity."
#     _cache.set(key, data, ttl_seconds)
#     return ok(data, cached=False)


# def clear_fast_cache() -> None:
#     _cache.clear()

"""
support_db_fast.py
───────────────────────────────────────────────────────────────────────────────
App-wide fast data layer for Flask + Supabase.

It prefers the SQL RPCs from sql/001_real_scaling_indexes_and_rpc.sql, but also
has a safe direct-query fallback so the app does not break if the SQL was not
run yet. Every heavy endpoint returns either a small summary or one server-side
page; it never returns a full tenant table.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, replace
from threading import RLock
from typing import Any, Dict, Optional, Tuple

try:
    from supabase import create_client, ClientOptions
except Exception:  # pragma: no cover
    create_client = None  # type: ignore
    ClientOptions = None  # type: ignore

from support_db_core import _execute_supabase, build_or_ilike_filter
from logger_config import get_logger

logger = get_logger(__name__)

JsonDict = Dict[str, Any]


@dataclass(frozen=True)
class FastScope:
    client_id: Optional[str] = None
    org_id: Optional[str] = None
    branch_id: Optional[str] = None
    people_type: Optional[str] = None
    today: Optional[str] = None
    # Payroll pay-period window ('YYYY-MM-DD'), display filters same as
    # branch_id/today — not identity-scoping, safe to read from args.
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    # None = unscoped (org/branch admin, or 'branch'-scoped caller — same
    # contract as client_dashboard_auth.get_team_scope_ids). A concrete
    # frozenset restricts staff/attendance/leaves rows to that id set —
    # see from_dashboard_user below. Deliberately NOT settable via
    # from_args: this must only ever come from a verified token, never
    # from a request query string.
    scope_ids: Optional[frozenset] = None

    @classmethod
    def from_args(cls, args: Any) -> "FastScope":
        """Builds a scope entirely from request args. Do NOT call this
        directly in any /api/v2/* Flask route — org_id/branch_id here are
        whatever the caller sent, unauthenticated. Use from_dashboard_user
        instead, which pins the tenant-identifying fields to the verified
        dashboard token. Kept public because non-route call sites (tests,
        scripts) may legitimately want a scope with no auth context."""
        def clean(value: Any) -> Optional[str]:
            if value is None:
                return None
            text = str(value).strip()
            if not text or text.lower() in {"all", "all_branches", "null", "undefined", "none"}:
                return None
            return text

        return cls(
            client_id=clean(args.get("clientId") or args.get("client_id") or args.get("tenantId") or args.get("tenant_id")),
            org_id=clean(args.get("orgId") or args.get("org_id") or args.get("organizationId") or args.get("organization_id")),
            branch_id=clean(args.get("branchId") or args.get("branch_id")),
            people_type=clean(args.get("people_type") or args.get("peopleType") or args.get("person_type") or args.get("personType")),
            today=clean(args.get("today") or args.get("date")),
            period_start=clean(args.get("periodStart") or args.get("period_start")),
            period_end=clean(args.get("periodEnd") or args.get("period_end")),
        )

    @classmethod
    def from_dashboard_user(cls, dashboard_user: dict, args: Any, *, scope_ids: Optional[set] = None) -> "FastScope":
        """The ONLY constructor every /api/v2/* route should use.

        org_id is pinned to the verified g.dashboard_user['org_id'] —
        never the request's orgId/organizationId/X-Organization-Id, which
        is how this whole module was reachable cross-tenant by anyone
        before this fix (see PATCH_NOTES: fast-path auth bypass).

        branch_id: a client_staff row always has its own home branch_id in
        the token, admin or not — is_admin does NOT imply branch_id is
        None. So branch-locking only applies to a genuinely branch-scoped
        (non-admin) account; that caller's token branch wins outright and
        the query string can never widen it. An admin (is_admin=True) is
        org-wide by default regardless of their own home branch, and may
        still pass branch_id as a voluntary display filter to narrow to
        one branch, the same trust boundary /api/staff already uses.
        Previously this checked "token_branch_id is set" instead of
        "caller is admin", which silently locked admins to their own
        branch and hid every other branch's staff/payroll/attendance from
        them — see PATCH_NOTES: admin branch-lock.

        scope_ids: pass the caller's client_dashboard_auth.get_team_scope_ids()
        (or get_effective_scope_ids()) result straight through — None for
        unscoped ('branch'/admin), or the (possibly empty) subordinate-id
        set for a 'team'-scoped caller. Never compute this locally; it
        must come from the same single source of truth every other
        scope-sensitive route uses.
        """
        base = cls.from_args(args)
        token_org_id = str(dashboard_user.get("org_id") or "").strip() or None
        token_branch_id = dashboard_user.get("branch_id")
        is_admin = bool(dashboard_user.get("is_admin"))
        resolved_branch_id = base.branch_id if is_admin else (
            str(token_branch_id) if token_branch_id else base.branch_id
        )
        return replace(
            base,
            org_id=token_org_id,
            branch_id=resolved_branch_id,
            scope_ids=frozenset(scope_ids) if scope_ids is not None else None,
        )

    def cache_parts(self) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str]]:
        return (self.client_id, self.org_id, self.branch_id, self.people_type, self.today)


class TinyTTLCache:
    def __init__(self, max_items: int = 1024) -> None:
        self.max_items = max_items
        self._data: Dict[str, Tuple[float, Any]] = {}
        self._lock = RLock()

    def get(self, key: str) -> Optional[Any]:
        now = time.monotonic()
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            expires_at, value = item
            if expires_at < now:
                self._data.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any, ttl_seconds: float) -> None:
        expires_at = time.monotonic() + max(float(ttl_seconds or 0), 0.1)
        with self._lock:
            if len(self._data) >= self.max_items:
                self._data.pop(next(iter(self._data)), None)
            self._data[key] = (expires_at, value)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


_cache = TinyTTLCache()
_supabase_client = None
_supabase_lock = RLock()


def _json_hash(value: Any) -> str:
    return hashlib.sha1(json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")).hexdigest()


def get_supabase_client():
    global _supabase_client
    with _supabase_lock:
        if _supabase_client is not None:
            return _supabase_client
        if create_client is None:
            raise RuntimeError("supabase package is not installed. Run: pip install supabase")
        url = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
        key = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_SERVICE_KEY")
            or os.getenv("SUPABASE_KEY")
            or os.getenv("SUPABASE_ANON_KEY")
            or os.getenv("VITE_SUPABASE_ANON_KEY")
        )
        if not url or not key:
            raise RuntimeError("Missing SUPABASE_URL and service/anon key environment variables.")
        options = (
            ClientOptions(postgrest_client_timeout=float(os.getenv("SUPABASE_CLIENT_TIMEOUT_SECONDS", "5")))
            if ClientOptions is not None
            else None
        )
        _supabase_client = create_client(url, key, options=options) if options is not None else create_client(url, key)
        return _supabase_client


def ok(data: Any, *, cached: bool = False) -> JsonDict:
    if isinstance(data, dict):
        data.setdefault("success", True)
        data.setdefault("cached", cached)
        return data
    return {"success": True, "cached": cached, "data": data}


def fail(message: str, status: int = 500, **extra: Any) -> Tuple[JsonDict, int]:
    body: JsonDict = {"success": False, "message": message}
    body.update(extra)
    return body, status


def _rpc(name: str, payload: JsonDict) -> Any:
    return get_supabase_client().rpc(name, payload).execute().data


def _resolve_branch_id(sb: Any, org_id: Optional[str], branch_id: Optional[str]) -> Optional[str]:
    """
    Resolves a branchId query param to the real Supabase branches.id UUID.

    Accepts either a real branch UUID (returned as-is) or a legacy numeric UI
    ordinal (1..N). The ordinal is mapped against support_db.list_branches(),
    the same active-only, created_at-ordered source _build_client_config uses
    to assign ui_branch_id — this keeps ordinal resolution in sync with the
    ids the dashboard actually displays. Previously this ran its own
    unfiltered query, which included soft-deleted branches in the ordering
    and silently resolved UI id 2 to a dropped row whenever a branch had
    been replaced (e.g. Aukara: ffff0ded dropped, 6e37c4b0 active).
    """
    if not org_id or not branch_id:
        return branch_id
    text = str(branch_id).strip()
    if not text:
        return None
    try:
        import support_db  # local import: avoids a hard circular import at module load time
        branches = support_db.list_branches(org_id)  # include_dropped=False by default
        ids = [str(b.get("id")) for b in branches if b.get("id")]
        if text in ids:
            return text
        if text.isdigit():
            idx = int(text) - 1
            if 0 <= idx < len(ids):
                return ids[idx]
    except Exception:
        return text
    return text


def _safe_count(query: Any) -> int:
    try:
        # PostgREST still calculates the exact count but returns at most one row.
        # Routed through _execute_supabase so a blocked/rejected request is
        # classified (and, for transient infra blips, retried) the same way
        # every other Supabase call in the app is, instead of this being the
        # one path that silently swallows every exception shape.
        result = _execute_supabase("fast.safe_count", lambda: query.limit(1))
        return int(getattr(result, "count", None) or 0)
    except Exception:
        return 0


def _order(query: Any, sort_by: Optional[str], sort_dir: str, allowed: set[str], default: str):
    col = sort_by if sort_by in allowed else default
    return query.order(col, desc=str(sort_dir).lower() == "desc")


def _or_search(query: Any, search: Optional[str], cols: list[str]):
    """Apply a safe, case-insensitive OR-across-columns search filter.

    See support_db_core.build_or_ilike_filter for why this can't just
    strip '%'/',' from the raw text (that was the old implementation, and
    it neither preserved user intent nor actually prevented a search term
    from redefining the filter's structure).
    """
    clause = build_or_ilike_filter(search, cols)
    return query.or_(clause) if clause else query


def _page_result(entity: str, rows: list[dict], total: int, page: int, page_size: int, offset: int, table: str) -> JsonDict:
    return {
        "success": True,
        "entity": entity,
        "table": table,
        "rows": rows,
        "total": int(total or 0),
        "page": page,
        "pageSize": page_size,
        "offset": offset,
        "hasMore": offset + len(rows) < int(total or 0),
    }


_PEOPLE_TYPE_IDS_CACHE = TinyTTLCache(max_items=512)


def _people_type_staff_ids(org_id: str, branch_id: Optional[str], people_type: Optional[str]) -> Optional[frozenset]:
    """Resolve which client_staff ids belong to (org, branch, people_type).

    `attendance` and `leave_requests` carry no people_type column of their
    own (see support_db_attendance_dashboard._client_attendance_rows,
    which fetches rows and joins client_staff in Python purely to filter
    by type) — so people_type-scoping those tables has to be expressed as
    a staff-id restriction, same as team-scoping already is. Reusing that
    one mechanism (FastScope.scope_ids / the .in_("staff_id", ...) pattern
    every _direct_*_page already applies via _combine_scope_ids below)
    keeps this module to a single scoping primitive instead of adding a
    second, parallel one.

    Returns None (no restriction from this axis) when people_type is
    absent or the org's schema doesn't have the column at all — same
    "unfilterable, behave as before" contract _direct_staff_page's own
    `if scope.people_type:` guard already uses. Returns a possibly-empty
    frozenset otherwise; an empty result is real (no staff of that type
    at this org/branch) and must short-circuit callers to zero, not fall
    through to unscoped.

    Cached briefly (people_type membership changes only on
    onboarding/offboarding/reassignment) so repeated polls within the TTL
    window reuse the id set instead of re-querying client_staff.
    """
    if not people_type:
        return None
    import support_db  # local import: avoids a hard circular import at module load time
    if not support_db._client_staff_has_people_type_column():
        return None
    normalized = support_db._normalize_people_type(people_type)
    cache_key = f"{org_id}|{branch_id or ''}|{normalized}"
    cached = _PEOPLE_TYPE_IDS_CACHE.get(cache_key)
    if cached is not None:
        return cached
    sb = get_supabase_client()
    query = (
        sb.table("client_staff")
        .select("id")
        .eq("org_id", org_id)
        .eq("is_archived", False)
        .eq("people_type", normalized)
    )
    if branch_id:
        query = query.eq("branch_id", branch_id)
    result = _execute_supabase("fast.people_type_ids", lambda: query.limit(20000))
    ids = frozenset(str(row["id"]) for row in (result.data or []) if row.get("id"))
    _PEOPLE_TYPE_IDS_CACHE.set(cache_key, ids, 30.0)
    return ids


def _combine_scope_ids(team_scope_ids: Optional[frozenset], people_type_ids: Optional[frozenset]) -> Optional[frozenset]:
    """Merge team-scope (who a manager may see) with people-type-scope
    (which record type this request asked for) into the single staff-id
    restriction _safe_count/_direct_*_page already know how to apply.

    None from an axis = that axis imposes no restriction. Both None =
    fully unscoped (existing None-means-unscoped contract, unchanged).
    Either axis empty = the intersection is necessarily empty, so this
    returns frozenset() rather than falling through to the other axis —
    the same "empty set != no filter" contract used everywhere else in
    this module.
    """
    if team_scope_ids is None and people_type_ids is None:
        return None
    if team_scope_ids is None:
        return people_type_ids
    if people_type_ids is None:
        return team_scope_ids
    return frozenset(team_scope_ids) & frozenset(people_type_ids)


def _direct_staff_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
    if not scope.org_id:
        return _page_result("staff", [], 0, page, page_size, (page - 1) * page_size, "client_staff")
    # A 'team'-scoped caller with zero reports is a real, distinct value —
    # short-circuit to an empty page rather than let an empty .in_([]) fall
    # through to Postgrest (which some client versions treat as "no filter"
    # applied, i.e. the whole org back). Same "empty set != no filter"
    # contract as client_dashboard_auth.filter_rows_by_scope.
    if scope.scope_ids is not None and not scope.scope_ids:
        return _page_result("staff", [], 0, page, page_size, (page - 1) * page_size, "client_staff")

    sb = get_supabase_client()
    branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
    # Deliberately does NOT filter .eq("role", "staff") — the Staff
    # Directory is a roster of everyone in the org, and an admin is still
    # an employee, not a separate account type that exits the roster (see
    # list_client_staff's role='staff' default in support_db_staff.py,
    # which had the same assumption baked in — a client_staff row promoted
    # to admin would silently vanish from every directory/count view that
    # called either function). scope_ids (team-scope) still applies below,
    # so a team-scoped manager's view is unaffected by this change.
    base = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False)
    if branch_id:
        base = base.eq("branch_id", branch_id)
    if scope.people_type:
        base = base.eq("people_type", scope.people_type)
    if scope.scope_ids is not None:
        base = base.in_("id", list(scope.scope_ids))
    base = _or_search(base, search, ["name", "email", "employee_id", "department_name", "role_name", "phone"])
    total = _safe_count(base)

    query = sb.table("client_staff").select("*").eq("org_id", scope.org_id).eq("is_archived", False)
    if branch_id:
        query = query.eq("branch_id", branch_id)
    if scope.people_type:
        query = query.eq("people_type", scope.people_type)
    if scope.scope_ids is not None:
        query = query.in_("id", list(scope.scope_ids))
    query = _or_search(query, search, ["name", "email", "employee_id", "department_name", "role_name", "phone"])
    query = _order(query, sort_by, sort_dir, {"name", "email", "employee_id", "department_name", "role_name", "salary", "status", "created_at", "updated_at"}, "name")
    offset = (page - 1) * page_size
    # Routed through _execute_supabase rather than a bare `.execute()` so a
    # rejected/blocked request (WAF, malformed filter, upstream outage) is
    # classified into a clean ValueError/RuntimeError instead of an
    # unhandled postgrest/pydantic exception reaching the route layer as an
    # opaque 500 -- this was the actual query on the Staff Search path
    # involved in the WAF-crash bug.
    result = _execute_supabase(
        "fast.staff_page.rows",
        lambda: query.range(offset, offset + page_size - 1),
    )
    rows = result.data or []
    try:
        import support_db  # local project mapper keeps camelCase aliases and UI branch ids consistent
        shifts_by_id = support_db._resolve_shift_map(
            scope.org_id, {row.get('shift_id_ref') for row in rows}
        )
        rows = [
            support_db._client_staff_safe(row, scope.org_id, shifts_by_id=shifts_by_id)
            for row in rows
        ]
    except Exception:
        pass
    return _page_result("staff", rows, total, page, page_size, offset, "client_staff")


def _direct_branches_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
    """
    Branch counts per org are small (single digits to low tens), so unlike
    staff/attendance this filters/sorts/paginates in Python over
    support_db.list_branches() rather than re-querying Supabase with its own
    filter set. This is deliberate: it's the same active-only, created_at
    source _build_client_config and _resolve_branch_id use, so "what counts
    as a branch" can never drift across these three call sites again.
    """
    if not scope.org_id:
        return _page_result("branches", [], 0, page, page_size, (page - 1) * page_size, "branches")
    import support_db
    rows = support_db.list_branches(scope.org_id)  # include_dropped=False by default

    text = (search or "").strip().lower()
    if text:
        rows = [
            r for r in rows
            if text in str(r.get("name") or "").lower() or text in str(r.get("location") or "").lower()
        ]

    sort_col = sort_by if sort_by in {"name", "location", "created_at", "max_staff_capacity"} else "created_at"
    reverse = str(sort_dir).lower() == "desc"
    rows = sorted(rows, key=lambda r: (r.get(sort_col) is None, r.get(sort_col)), reverse=reverse)

    total = len(rows)
    offset = (page - 1) * page_size
    page_rows = rows[offset: offset + page_size]
    return _page_result("branches", page_rows, total, page, page_size, offset, "branches")


def _direct_attendance_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
    if not scope.org_id:
        return _page_result("attendance", [], 0, page, page_size, (page - 1) * page_size, "attendance")
    sb = get_supabase_client()
    branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
    # attendance has no people_type column of its own (see
    # _people_type_staff_ids' docstring) — a people_type-filtered request
    # is expressed as a staff-id restriction, combined with any existing
    # team-scope restriction the same way get_fast_summary's cards do.
    effective_scope_ids = _combine_scope_ids(
        scope.scope_ids, _people_type_staff_ids(scope.org_id, branch_id, scope.people_type)
    )
    if effective_scope_ids is not None and not effective_scope_ids:
        return _page_result("attendance", [], 0, page, page_size, (page - 1) * page_size, "attendance")

    base = sb.table("attendance").select("id", count="exact").eq("org_id", scope.org_id)
    if branch_id:
        base = base.eq("branch_id", branch_id)
    if scope.today:
        base = base.gte("timestamp", f"{scope.today}T00:00:00").lt("timestamp", f"{scope.today}T23:59:59")
    if effective_scope_ids is not None:
        base = base.in_("staff_id", list(effective_scope_ids))
    total = _safe_count(base)
    query = sb.table("attendance").select("*").eq("org_id", scope.org_id)
    if branch_id:
        query = query.eq("branch_id", branch_id)
    if scope.today:
        query = query.gte("timestamp", f"{scope.today}T00:00:00").lt("timestamp", f"{scope.today}T23:59:59")
    if effective_scope_ids is not None:
        query = query.in_("staff_id", list(effective_scope_ids))
    query = _order(query, sort_by, sort_dir, {"timestamp", "created_at", "confidence", "source"}, "timestamp")
    offset = (page - 1) * page_size
    rows = query.range(offset, offset + page_size - 1).execute().data or []
    return _page_result("attendance", rows, total, page, page_size, offset, "attendance")


def _direct_leaves_page(scope: FastScope, page: int, page_size: int, search: Optional[str], sort_by: Optional[str], sort_dir: str) -> JsonDict:
    if not scope.org_id:
        return _page_result("leaves", [], 0, page, page_size, (page - 1) * page_size, "leave_requests")
    sb = get_supabase_client()
    branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
    # Same people_type -> staff-id restriction as _direct_attendance_page;
    # leave_requests has no people_type column either.
    effective_scope_ids = _combine_scope_ids(
        scope.scope_ids, _people_type_staff_ids(scope.org_id, branch_id, scope.people_type)
    )
    if effective_scope_ids is not None and not effective_scope_ids:
        return _page_result("leaves", [], 0, page, page_size, (page - 1) * page_size, "leave_requests")

    base = sb.table("leave_requests").select("id", count="exact").eq("org_id", scope.org_id)
    if branch_id:
        base = base.eq("branch_id", branch_id)
    if effective_scope_ids is not None:
        base = base.in_("staff_id", list(effective_scope_ids))
    base = _or_search(base, search, ["reason", "status", "leave_type"])
    total = _safe_count(base)
    query = sb.table("leave_requests").select("*").eq("org_id", scope.org_id)
    if branch_id:
        query = query.eq("branch_id", branch_id)
    if effective_scope_ids is not None:
        query = query.in_("staff_id", list(effective_scope_ids))
    query = _or_search(query, search, ["reason", "status", "leave_type"])
    query = _order(query, sort_by, sort_dir, {"created_at", "start_date", "end_date", "status", "leave_type"}, "created_at")
    offset = (page - 1) * page_size
    rows = query.range(offset, offset + page_size - 1).execute().data or []
    return _page_result("leaves", rows, total, page, page_size, offset, "leave_requests")


def _direct_payroll_page(
    scope: FastScope,
    page: int,
    page_size: int,
    search: Optional[str],
    sort_by: Optional[str],
    sort_dir: str,
) -> JsonDict:
    """Delegates to support_db_payroll.get_client_payroll_page — the single
    source of truth for turning client_staff + salary_configs + real
    attendance/leave/overtime data into a payroll row via
    payroll_engine.compute_payroll_breakdown (deductions/net_pay/status,
    including unpaid-leave/late/half-day deductions).

    This used to be a parallel ~140-line reimplementation of that same
    pipeline (staff paging, per-branch attendance/leave batching, policy
    resolution, breakdown computation) that had quietly drifted from it:
    it resolved per-branch payroll-policy overrides using the UI branch id
    instead of the backend branch UUID payroll_policy_overrides is actually
    keyed on (compare get_client_payroll_page's own resolve_policy, which
    uses staff['branch_id'] — the backend UUID). That made any branch-level
    leaveTypeRules/lateComingPolicy override invisible on this fast-page
    path (the one usePayrollData.ts actually calls) while it worked
    correctly on GET /api/v2/payroll/page. Delegating removes the second
    implementation outright, so the two paths cannot drift apart again —
    one computation, two thin callers.

    Deliberately unscoped from the caller's team-scope (scope_ids), even
    for a 'team'-scoped manager: Payroll access is a module-access grant
    (access_modules), not a hierarchy grant — see client_dashboard_auth.py's
    get_team_scope_ids docstring ("Payroll / salary routes ignore
    dashboard_scope entirely") and get_client_payroll_page, which never
    reads scope_ids for the same reason.
    """
    offset = (page - 1) * page_size
    if not scope.org_id:
        return _page_result("payroll", [], 0, page, page_size, offset, "client_staff/salary_configs")

    import support_db as _support_db

    try:
        page_data = _support_db.get_client_payroll_page(
            scope.org_id,
            branch_id=scope.branch_id,
            page=page,
            page_size=page_size,
            search=search,
            sort_by=sort_by or "name",
            sort_dir=sort_dir,
            period_start=scope.period_start,
            period_end=scope.period_end,
            people_type=scope.people_type,
        )
    except ValueError as exc:
        return {
            **_page_result("payroll", [], 0, page, page_size, offset, "client_staff/salary_configs"),
            "success": False,
            "message": str(exc),
        }

    rows = page_data.get("rows") or []
    total = int(page_data.get("total") or 0)
    return {
        "entity": "payroll",
        "table": "client_staff/salary_configs",
        "rows": rows,
        "total": total,
        "page": int(page_data.get("page") or page),
        "pageSize": int(page_data.get("pageSize") or page_size),
        "offset": offset,
        "hasMore": offset + len(rows) < total,
    }




def _num(value: Any, fallback: float = 0) -> float:
    try:
        parsed = float(value or 0)
        return parsed if parsed == parsed else fallback
    except Exception:
        return fallback


def _txt(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _month_labels() -> list[str]:
    labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    month_index = int(time.strftime("%m")) - 1
    return [labels[(month_index - (5 - idx)) % 12] for idx in range(6)]


def _payroll_trends(total: float) -> list[dict]:
    weights = [0.82, 0.87, 0.91, 0.94, 0.97, 1.0]
    return [
        {"month": month, "Payroll": int(round(total * weights[idx])), "Overtime": 0}
        for idx, month in enumerate(_month_labels())
    ]


def _weekly_attendance(present_today: int) -> list[dict]:
    labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    today_idx = int(time.strftime("%u")) - 1
    ordered = [labels[(today_idx - (6 - idx)) % 7] for idx in range(7)]
    return [{"day": day, "count": int(present_today if idx == 6 else 0)} for idx, day in enumerate(ordered)]


def _attendance_performance(present: int, late: int, absent: int) -> list[dict]:
    return [
        {"month": month, "On Time": int(present if idx == 5 else 0), "Late": int(late if idx == 5 else 0), "Absent": int(absent if idx == 5 else 0)}
        for idx, month in enumerate(_month_labels())
    ]


def _branch_ui_id(row: dict, index: int) -> int:
    for key in ("ui_id", "branch_ui_id", "display_id"):
        val = row.get(key)
        try:
            n = int(val)
            if n > 0:
                return n
        except Exception:
            pass
    return index + 1


def _sum_staff_salary(sb: Any, org_id: str, branch_id: Optional[str], scope_ids: Optional[frozenset] = None) -> float:
    """Direct fallback for monthly payroll.

    This is intentionally small-field only. The preferred production path is the
    SQL RPC, which computes the sum inside Postgres. The fallback keeps local
    installs working even before SQL is applied.

    scope_ids: None = org/branch-wide (unscoped). A frozenset restricts the
    sum to those client_staff ids — a 'team'-scoped manager's payroll card
    reflects their own reports' salaries, not the whole branch/org's.
    """
    if scope_ids is not None and not scope_ids:
        return 0.0
    try:
        query = sb.table("client_staff").select("salary,basic_salary,status").eq("org_id", org_id).eq("is_archived", False).eq("role", "staff")
        if branch_id:
            query = query.eq("branch_id", branch_id)
        if scope_ids is not None:
            query = query.in_("id", list(scope_ids))
        rows = query.execute().data or []
        total = 0.0
        for row in rows:
            if str(row.get("status") or "").lower() == "inactive":
                continue
            total += _num(row.get("salary") or row.get("basic_salary"))
        return total
    except Exception:
        return 0.0

def _format_shift_time(check_in_time: Any, check_out_time: Any) -> str:
    """'09:00:00'/'17:00:00' -> '09:00 – 17:00', matching the display format
    the Shift Distribution card already renders (and _resolve_shift_map's
    own [:5] truncation convention in support_db.py)."""
    start = str(check_in_time or "")[:5] or "--:--"
    end = str(check_out_time or "")[:5] if check_out_time else None
    return f"{start} – {end}" if end else f"{start} · Flexible"


def _shift_distribution_for_branch(
    sb: Any,
    org_id: str,
    branch_id: str,
    people_type: Optional[str],
    scope_ids: Optional[frozenset],
) -> list[dict]:
    """Real shift distribution for one branch — support_db_shifts.py's
    `shifts` table is the sole source of truth (see support_db.py's
    _resolve_shift_map docstring), the same table StaffManagement.tsx's
    Shift Allocation tab reads via listBranchShifts(). This intentionally
    replaces the old hardcoded 4-row Morning/Evening/Night/Custom
    placeholder list, which could never represent a branch's actual
    configured shifts.

    Every active shift configured for this branch is returned, even ones
    with zero staff currently assigned — staffCount stays 0, the shift row
    itself is never dropped.

    scope_ids follows the exact contract every other card on this endpoint
    already uses (see _sum_staff_salary above): None = unscoped
    (org/branch admin, or a 'branch'-scoped caller), a non-empty frozenset
    = restrict counts to that manager's own team, and an EMPTY frozenset
    means a 'team'-scoped manager with zero direct reports — every shift
    must show 0, not silently fall back to the branch-wide count.
    """
    if not org_id or not branch_id:
        return []

    # local import: avoids a hard circular import at module load time, same
    # pattern _resolve_branch_id already uses for support_db.
    import support_db

    normalized_people_type = (
        support_db._normalize_people_type(people_type) if people_type else None
    )

    def branch_shifts_query(include_people_type: bool = False) -> Any:
        columns = "id,name,check_in_time,check_out_time,is_active"
        if include_people_type:
            columns += ",people_type"
        return (
            sb.table("shifts")
            .select(columns)
            .eq("org_id", org_id)
            .eq("branch_id", branch_id)
            .order("check_in_time")
        )

    shifts_query = branch_shifts_query(include_people_type=True)
    shift_filter_fallback = False
    try:
        filtered_query = shifts_query
        if normalized_people_type:
            filtered_query = filtered_query.eq("people_type", normalized_people_type)
        shift_rows = filtered_query.execute().data or []
    except Exception as exc:
        # Older Supabase schemas may not expose people_type on shifts yet.
        # Keep the dashboard Supabase-backed and use the branch's active rows.
        logger.warning(
            "shift distribution people_type filter failed for org=%s branch=%s; "
            "retrying branch shifts without the filter: %s",
            org_id,
            branch_id,
            exc,
        )
        shift_filter_fallback = True
        shift_rows = branch_shifts_query().execute().data or []

    if normalized_people_type and not shift_rows:
        # Existing shift rows created before per-people-type shift support may
        # have a null or legacy people_type. Do not hide configured shifts.
        shift_filter_fallback = True
        shift_rows = branch_shifts_query().execute().data or []

    shift_rows = [row for row in shift_rows if row.get("is_active") is not False]
    if not shift_rows:
        return []

    counts: dict[str, int] = {}
    members_by_shift: dict[str, list[dict]] = {}
    if scope_ids is None or scope_ids:
        staff_columns = (
            "id,name,position,department_name,shift_id_ref,people_type"
        )
        staff_query = (
            sb.table("client_staff")
            .select(staff_columns)
            .eq("org_id", org_id)
            .eq("branch_id", branch_id)
            .eq("is_archived", False)
        )
        if (
            normalized_people_type
            and not shift_filter_fallback
            and support_db._client_staff_has_people_type_column()
        ):
            staff_query = staff_query.eq("people_type", normalized_people_type)
        if scope_ids is not None:
            staff_query = staff_query.in_("id", list(scope_ids))
        try:
            staff_rows = staff_query.execute().data or []
        except Exception as exc:
            logger.warning(
                "shift distribution staff detail query failed for org=%s branch=%s; "
                "retrying with core staff columns: %s",
                org_id,
                branch_id,
                exc,
            )
            staff_query = (
                sb.table("client_staff")
                .select("id,name,position,shift_id_ref")
                .eq("org_id", org_id)
                .eq("branch_id", branch_id)
                .eq("is_archived", False)
            )
            if scope_ids is not None:
                staff_query = staff_query.in_("id", list(scope_ids))
            staff_rows = staff_query.execute().data or []

        for row in staff_rows:
            shift_id = row.get("shift_id_ref")
            if shift_id:
                shift_key = str(shift_id)
                counts[shift_key] = counts.get(shift_key, 0) + 1
                members_by_shift.setdefault(shift_key, []).append(
                    {
                        "id": str(row.get("id") or ""),
                        "name": row.get("name") or "Unknown staff",
                        "department": row.get("department_name") or "General",
                        "position": row.get("position") or "Staff",
                        "branchId": branch_id,
                        "branchName": "",
                    }
                )
    # else: scope_ids == frozenset() — a team-scoped manager with zero
    # direct reports. counts stays empty, every shift correctly shows 0.

    branch_name = branch_id
    try:
        branch_result = (
            sb.table("branches")
            .select("id,name")
            .eq("id", branch_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute()
        )
        if branch_result.data:
            branch_name = branch_result.data[0].get("name") or branch_id
    except Exception:
        pass

    result = []
    for row in shift_rows:
        shift_key = str(row["id"])
        members = members_by_shift.get(shift_key, [])
        departments_by_name: dict[str, dict] = {}
        for member in members:
            department_name = str(member["department"])
            department = departments_by_name.setdefault(
                department_name,
                {"name": department_name, "count": 0, "members": []},
            )
            department["count"] += 1
            department["members"].append(member)

        departments = list(departments_by_name.values())
        result.append(
            {
                "key": shift_key,
                "label": row.get("name") or "Shift",
                "time": _format_shift_time(
                    row.get("check_in_time"), row.get("check_out_time")
                ),
                "staffCount": counts.get(shift_key, 0),
                "departments": departments,
                "branches": [
                    {
                        "branchId": branch_id,
                        "branchName": branch_name,
                        "staffCount": counts.get(shift_key, 0),
                        "departments": departments,
                    }
                ],
                "members": members,
            }
        )
    return result


def _merge_shift_distributions(per_branch: list[list[dict]]) -> list[dict]:
    """'All Branches' view: shifts are a per-branch concept, so there is no
    single real row to return per shift. Same-named shifts across branches
    are merged (their staffCount summed) rather than shown as separate
    rows — the same "one org-wide picture" convention this endpoint
    already applies to every other All-Branches stat (totalStaff,
    presentToday, etc. are org-wide sums, not one row per branch).
    Differently-named shifts across branches each keep their own row.
    """
    merged: dict[str, dict] = {}
    order: list[str] = []
    for shifts in per_branch:
        for shift in shifts:
            name_key = str(shift["label"]).strip().lower()
            if name_key not in merged:
                merged[name_key] = {**shift, "key": name_key}
                order.append(name_key)
            else:
                merged[name_key]["staffCount"] += shift["staffCount"]
    return [merged[key] for key in order]


def get_fast_summary(scope: FastScope, *, ttl_seconds: float = 6.0) -> JsonDict:
    payload = {
        "p_client_id": scope.client_id,
        "p_org_id": scope.org_id,
        "p_branch_id": scope.branch_id,
        "p_today": scope.today,
        # See get_fast_page's identical field: must be in the cache key or
        # two managers with different teams (or a manager vs. the branch
        # admin) can be served each other's cached card numbers. Same
        # reasoning applies to p_people_type below -- without it, a
        # "worker" dashboard poll could be served a "staff" poll's cached
        # cards whenever every other param happened to match.
        "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
        "p_people_type": scope.people_type,
    }
    key = "summary:" + _json_hash(payload)
    cached = _cache.get(key)
    if cached is not None:
        return ok(cached, cached=True)

    # A 'team'-scoped or people_type-filtered caller's cards must come
    # from the direct-query path below, never the RPC —
    # get_tenant_fast_summary's SQL (a Supabase migration, not this repo)
    # has no p_scope_ids/p_people_type parameter and would return
    # org/branch-wide, all-types numbers to a caller who asked for a
    # narrower slice.
    if scope.scope_ids is None and not scope.people_type:
        rpc_started = time.monotonic()
        try:
            data = _rpc("get_tenant_fast_summary", payload)
            if isinstance(data, dict):
                _cache.set(key, data, ttl_seconds)
                return ok(data, cached=False)
            logger.warning(
                "get_fast_summary: RPC get_tenant_fast_summary returned non-dict "
                "(%s) after %.2fs for org=%s branch=%s; falling back to direct query",
                type(data).__name__, time.monotonic() - rpc_started, scope.org_id, scope.branch_id,
            )
        except Exception as exc:
            logger.warning(
                "get_fast_summary: RPC get_tenant_fast_summary failed after %.2fs for "
                "org=%s branch=%s; falling back to direct query. error=%r",
                time.monotonic() - rpc_started, scope.org_id, scope.branch_id, exc,
            )

    # Direct summary fallback with count='exact' only; no full-table scans in Python.
    sb = get_supabase_client()
    branch_id = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
    # Dashboard OVERVIEW CARDS now respect team scope too (explicit product
    # decision, reversing this function's earlier "cards are always org/
    # branch-wide" behavior) — a 'team'-scoped manager's people/attendance/
    # leave cards (totalStaff/presentToday/absentToday/pendingLeaves)
    # reflect only themself + their reports, same as the Staff/Attendance/
    # Leave LIST pages already did via scope.scope_ids on
    # _direct_staff_page/_direct_attendance_page/_direct_leaves_page. An
    # unscoped ('branch'/admin) caller is scope.scope_ids=None here, so this
    # is a no-op change for every existing admin/branch-wide session.
    #
    # Payroll is the one exception, deliberately: it's a module-access grant
    # (access_modules), not a hierarchy grant — same reasoning
    # _direct_payroll_page already documents and client_dashboard_auth.py's
    # get_team_scope_ids docstring states outright ("Payroll / salary routes
    # ignore dashboard_scope entirely"). A manager who also has Payroll
    # access sees the same branch/org-wide payroll figure any other
    # Payroll-enabled account would, so it keeps its own always-unscoped id
    # set rather than reusing card_scope_ids.
    #
    # people_type folds into card_scope_ids via the same staff-id
    # restriction team-scope already uses (see _people_type_staff_ids'
    # docstring — attendance/leave_requests have no people_type column of
    # their own, so this is the only way to scope those two tables' cards
    # to one type without a full-table fetch-then-filter in Python).
    card_scope_ids = _combine_scope_ids(
        scope.scope_ids, _people_type_staff_ids(scope.org_id, branch_id, scope.people_type)
    )
    payroll_scope_ids = None
    cards = {"totalStaff": 0, "activeStaff": 0, "totalBranches": 0, "presentToday": 0, "absentToday": 0, "lateToday": 0, "pendingLeaves": 0, "payrollThisMonth": 0, "monthlyPayroll": 0}
    # Zero reports is a real, distinct value (matches the same contract
    # used everywhere else in this codebase for an empty team) — every
    # people-related card is legitimately 0 without ever hitting Supabase.
    # totalBranches is left out of this short-circuit deliberately: branch
    # count is an org-structure fact, not "my team's data," same reasoning
    # applied to it below. Payroll is also computed outside this
    # short-circuit (see payroll_scope_ids above) — an empty team still
    # gets the real branch/org payroll figure, not zero.
    # The 6 queries below (staff/active/present/pending/payroll/branches)
    # are mutually independent — none reads another's result — so they were
    # previously fired one at a time, each paying a full network round trip
    # before the next started. Submitted to a ThreadPoolExecutor instead,
    # matching the pattern get_client_bootstrap() already uses: wall time
    # becomes ~the slowest single query instead of the sum of all of them.
    # Same queries, same filters, same results — only the scheduling changed.
    from concurrency import gather

    team_is_empty = card_scope_ids is not None and not card_scope_ids
    today = scope.today or time.strftime("%Y-%m-%d")

    jobs: dict[str, Any] = {}
    if scope.org_id and not team_is_empty:
        staff_q = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False).eq("role", "staff")
        active_q = sb.table("client_staff").select("id", count="exact").eq("org_id", scope.org_id).eq("is_archived", False).eq("role", "staff").neq("status", "inactive")
        aq = sb.table("attendance").select("staff_id", count="exact").eq("org_id", scope.org_id).gte("timestamp", f"{today}T00:00:00").lt("timestamp", f"{today}T23:59:59")
        lq = sb.table("leave_requests").select("id", count="exact").eq("org_id", scope.org_id).eq("status", "pending")
        if branch_id:
            staff_q = staff_q.eq("branch_id", branch_id)
            active_q = active_q.eq("branch_id", branch_id)
            aq = aq.eq("branch_id", branch_id)
            lq = lq.eq("branch_id", branch_id)
        if card_scope_ids is not None:
            staff_q = staff_q.in_("id", list(card_scope_ids))
            active_q = active_q.in_("id", list(card_scope_ids))
            aq = aq.in_("staff_id", list(card_scope_ids))
            lq = lq.in_("staff_id", list(card_scope_ids))
        jobs["totalStaff"] = lambda q=staff_q: _safe_count(q)
        jobs["activeStaff"] = lambda q=active_q: _safe_count(q)
        jobs["presentToday"] = lambda q=aq: _safe_count(q)
        jobs["pendingLeaves"] = lambda q=lq: _safe_count(q)
    if scope.org_id:
        jobs["payrollThisMonth"] = (
            lambda o=scope.org_id, b=branch_id, sc=payroll_scope_ids:
                _sum_staff_salary(sb, o, b, sc)
        )
        # totalBranches stays org-wide regardless of scope_ids — a
        # manager's "team" is a set of people, not a set of branches;
        # narrowing this count to "branches my reports happen to sit
        # in" isn't a meaningful metric and no part of this feature
        # has ever asked for it.
        bq = sb.table("branches").select("id", count="exact").eq("org_id", scope.org_id)
        jobs["totalBranches"] = lambda q=bq: _safe_count(q)

    results, errors = gather(jobs, max_workers=6)
    for _key, _exc in errors.items():
        logger.warning(
            "dashboard overview: card query %s failed for org=%s: %s",
            _key, scope.org_id, _exc, exc_info=_exc,
        )

    if "totalStaff" in jobs:
        cards["totalStaff"] = results.get("totalStaff", 0)
        cards["activeStaff"] = results.get("activeStaff", 0)
        cards["presentToday"] = results.get("presentToday", 0)
        cards["absentToday"] = max(0, cards["activeStaff"] - cards["presentToday"])
        cards["pendingLeaves"] = results.get("pendingLeaves", 0)
    if "payrollThisMonth" in jobs:
        cards["payrollThisMonth"] = int(round(results.get("payrollThisMonth", 0) or 0))
        cards["monthlyPayroll"] = cards["payrollThisMonth"]
        cards["totalBranches"] = results.get("totalBranches", 0)
    totals = {
        "totalStaff": cards["totalStaff"],
        "activeStaff": cards["activeStaff"],
        "totalBranches": cards["totalBranches"],
        "presentToday": cards["presentToday"],
        "absentToday": cards["absentToday"],
        "lateToday": cards["lateToday"],
        "pendingLeaves": cards["pendingLeaves"],
        "monthlyPayroll": cards["monthlyPayroll"],
        "payrollThisMonth": cards["payrollThisMonth"],
    }
    data = {"success": True, "cards": cards, "totals": totals, "stats": totals, "scope": {"orgId": scope.org_id, "branchId": scope.branch_id}, "source": "direct-fallback"}
    _cache.set(key, data, ttl_seconds)
    return ok(data, cached=False)




def get_fast_dashboard_overview(scope: FastScope, dashboard_scope: str = "global", *, ttl_seconds: float = 6.0) -> JsonDict:
    """One small payload for dashboard overview cards/charts.

    This endpoint replaces multiple dashboard-side requests. It returns a stable
    object shape so React can render one complete layout instead of one card,
    then fake zeros, then real data.
    """
    payload = {
        "p_client_id": scope.client_id,
        "p_org_id": scope.org_id,
        "p_branch_id": scope.branch_id,
        "p_today": scope.today,
        "p_people_type": scope.people_type,
        "dashboard_scope": dashboard_scope,
        "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
    }
    key = "dashboard-overview:" + _json_hash(payload)
    cached = _cache.get(key)
    if cached is not None:
        return ok(cached, cached=True)

    # Prefer an RPC if you add it later. Fallback stays compatible today.
    # Skipped entirely for a team-scoped or people_type-filtered caller —
    # get_tenant_dashboard_overview's SQL has no p_scope_ids/p_people_type
    # parameter (same reasoning as get_fast_summary).
    if scope.scope_ids is None and not scope.people_type:
        rpc_started = time.monotonic()
        try:
            rpc_data = _rpc("get_tenant_dashboard_overview", payload)
            rpc_shifts = (
                rpc_data.get("shiftDistribution")
                if isinstance(rpc_data, dict)
                else None
            )
            if rpc_shifts is None and isinstance(rpc_data, dict):
                rpc_shifts = rpc_data.get("shift_distribution")
            if isinstance(rpc_data, dict) and isinstance(rpc_shifts, list) and rpc_shifts:
                _cache.set(key, rpc_data, ttl_seconds)
                return ok(rpc_data, cached=False)
            logger.warning(
                "get_fast_dashboard_overview: RPC get_tenant_dashboard_overview "
                "returned an incomplete payload (%s) after %.2fs for org=%s branch=%s; "
                "falling back to direct query",
                type(rpc_data).__name__, time.monotonic() - rpc_started, scope.org_id, scope.branch_id,
            )
        except Exception as exc:
            logger.warning(
                "get_fast_dashboard_overview: RPC get_tenant_dashboard_overview failed "
                "after %.2fs for org=%s branch=%s; falling back to direct query. error=%r",
                time.monotonic() - rpc_started, scope.org_id, scope.branch_id, exc,
            )

    summary = get_fast_summary(scope, ttl_seconds=ttl_seconds)
    cards = summary.get("cards") or summary.get("stats") or summary.get("totals") or {}

    total_staff = int(_num(cards.get("totalStaff") or cards.get("total_staff")))
    active_staff = int(_num(cards.get("activeStaff") or cards.get("active_staff") or total_staff))
    present_today = int(_num(cards.get("presentToday") or cards.get("present_today")))
    late_today = int(_num(cards.get("lateToday") or cards.get("late_today")))
    absent_today = int(_num(cards.get("absentToday") or cards.get("absent_today") or max(active_staff - present_today, 0)))
    pending_leaves = int(_num(cards.get("pendingLeaves") or cards.get("pending_leaves")))
    monthly_payroll = int(_num(cards.get("monthlyPayroll") or cards.get("monthly_payroll") or cards.get("payrollThisMonth") or cards.get("payroll_this_month")))
    total_branches = int(_num(cards.get("totalBranches") or cards.get("total_branches")))
    avg_attendance = int(round((present_today / active_staff) * 100)) if active_staff > 0 else 0

    branch_filter_options: list[dict] = []
    branch_performance: list[dict] = []
    branch_payroll_trends: list[dict] = []
    shift_distribution: list[dict] = []
    selected_branch_name = None
    selected_branch_id = None
    selected_branch_city = None

    try:
        sb = get_supabase_client()
        if scope.org_id:
            try:
                branch_rows = (
                    sb.table("branches")
                    .select("id,name,location,city,created_at")
                    .eq("org_id", scope.org_id)
                    .order("created_at")
                    .execute()
                    .data
                    or []
                )
            except Exception as exc:
                # Some Supabase tenants do not have the optional city column.
                # Keep the overview and shift queries alive using location.
                logger.warning(
                    "dashboard overview: branches.city unavailable for org=%s; "
                    "retrying branch lookup without city: %s",
                    scope.org_id,
                    exc,
                )
                branch_rows = (
                    sb.table("branches")
                    .select("id,name,location,created_at")
                    .eq("org_id", scope.org_id)
                    .order("created_at")
                    .execute()
                    .data
                    or []
                )
            if total_branches <= 0:
                total_branches = len(branch_rows)
            resolved_branch = _resolve_branch_id(sb, scope.org_id, scope.branch_id)
            for index, row in enumerate(branch_rows):
                ui_id = _branch_ui_id(row, index)
                name = _txt(row.get("name"), f"Branch {ui_id}")
                city = _txt(row.get("city") or row.get("location"), "")
                branch_filter_options.append({"id": ui_id, "name": name})
                if resolved_branch and str(row.get("id")) == str(resolved_branch):
                    selected_branch_id = ui_id
                    selected_branch_name = name
                    selected_branch_city = city
                # Do not N+1 fetch branch staff counts here. Branch comparison can
                # use its own paginated/summary endpoint; overview remains fast.
                branch_performance.append({
                    "branchId": ui_id,
                    "branchName": name,
                    "city": city,
                    "totalStaff": 0,
                    "presentToday": 0,
                    "absentToday": 0,
                    "avgAttendance": 0,
                    "lateToday": 0,
                    "payroll": 0,
                    "cctvAlerts": 0,
                })
                branch_payroll_trends.append({
                    "branchId": ui_id,
                    "branchName": name,
                    "totalPayroll": 0,
                    "data": _payroll_trends(0),
                })

            if resolved_branch:
                try:
                    shift_distribution = _shift_distribution_for_branch(
                        sb, scope.org_id, resolved_branch, scope.people_type, scope.scope_ids,
                    )
                except Exception:
                    logger.exception(
                        "dashboard overview: shift distribution failed for branch %s (org %s); leaving empty",
                        resolved_branch, scope.org_id,
                    )
            elif dashboard_scope != "branch":
                # 'All Branches' — merge each branch's real configured
                # shifts into one org-wide list (see
                # _merge_shift_distributions' docstring for why merge-by-
                # name rather than one row per branch).
                #
                # Each branch's call is independent (its own 2 Supabase
                # queries: shifts + assigned staff) — this was a genuine
                # N+1, run one branch at a time in a list comprehension.
                # Fanned out to a ThreadPoolExecutor instead, same pattern
                # as get_fast_summary's card queries above: N branches now
                # cost ~1 branch's worth of wall time instead of N.
                #
                # IMPORTANT: one branch's future raising (timeout, transient
                # Supabase error, etc.) must NOT discard every other
                # branch's already-successful result. f.result() re-raises
                # inline, so a plain list comprehension over futures turns
                # one bad branch into zero shift-distribution data for the
                # whole org. Collect per-future instead and keep whatever
                # succeeded.
                
                from concurrency import gather
                _branch_jobs = {
                    str(row["id"]): (
                        lambda r=row: _shift_distribution_for_branch(
                            sb, scope.org_id, str(r["id"]),
                            scope.people_type, scope.scope_ids,
                        )
                    )
                    for row in branch_rows
                }
                _res, _err = gather(_branch_jobs, max_workers=8)
                for _bid, _exc in _err.items():
                    logger.warning(
                        "dashboard overview: shift distribution failed for "
                        "branch %s (org %s); skipping this branch only: %s",
                        _bid, scope.org_id, _exc,
                    )
                shift_distribution = _merge_shift_distributions(list(_res.values()))
    except Exception:
        logger.exception(
            "dashboard overview: branch/shift-distribution block failed for org %s; "
            "branchPerformance/branchPayrollTrends/shiftDistribution will be empty this request",
            scope.org_id,
        )

    if dashboard_scope == "branch" and not selected_branch_name and scope.branch_id:
        selected_branch_name = f"Branch {scope.branch_id}"
        selected_branch_id = scope.branch_id

    today_text = time.strftime("%A, %B %d, %Y")
    title = "Organization Overview" if dashboard_scope != "branch" else "Attendance Overview"
    subtitle = (
        f"All Branches · {total_branches} branches · {today_text}"
        if dashboard_scope != "branch"
        else f"{selected_branch_name or 'Branch'} · {today_text}"
    )

    stats = {
        "totalBranches": total_branches,
        "totalStaff": total_staff,
        "presentToday": present_today,
        "absentToday": absent_today,
        "avgAttendance": avg_attendance,
        "lateToday": late_today,
        "earlyLeft": 0,
        "pendingLeaves": pending_leaves,
        "monthlyPayroll": monthly_payroll,
        "cctvAlerts": 0,
    }

    data = {
        "success": True,
        "scope": "branch" if dashboard_scope == "branch" else "global",
        "branchId": selected_branch_id or scope.branch_id,
        "branchName": selected_branch_name,
        "branchCity": selected_branch_city,
        "title": title,
        "subtitle": subtitle,
        "selectedBranchId": selected_branch_id or scope.branch_id,
        "selectedBranchName": selected_branch_name,
        "branchFilterOptions": branch_filter_options,
        "stats": stats,
        "staff": [],
        "liveLog": [],
        "shiftDistribution": shift_distribution,
        "todayStatus": [
            {"name": "Present", "value": present_today},
            {"name": "Late", "value": late_today},
            {"name": "Absent", "value": absent_today},
        ],
        "weeklyAttendance": _weekly_attendance(present_today),
        "branchWeeklyAttendance": [],
        "pendingLeaves": [],
        "cctvStatus": [],
        "attendancePerformance": _attendance_performance(present_today, late_today, absent_today),
        "branchAttendancePerformance": [],
        "payrollTrends": _payroll_trends(monthly_payroll),
        "branchPayrollTrends": branch_payroll_trends,
        "branchPerformance": branch_performance,
        "source": summary.get("source", "dashboard-direct-fallback"),
    }
    _cache.set(key, data, ttl_seconds)
    return ok(data, cached=False)

def get_fast_page(entity: str, scope: FastScope, *, page: int = 1, page_size: int = 50, search: Optional[str] = None, sort_by: Optional[str] = None, sort_dir: str = "asc", ttl_seconds: float = 3.0) -> JsonDict:
    page = max(int(page or 1), 1)
    page_size = max(min(int(page_size or 50), 250), 1)
    entity = str(entity or "").strip().lower()
    offset = (page - 1) * page_size
    payload = {
        "p_entity": entity,
        "p_client_id": scope.client_id,
        "p_org_id": scope.org_id,
        "p_branch_id": scope.branch_id,
        "p_search": (search or "").strip() or None,
        "p_page_size": page_size,
        "p_offset": offset,
        "p_sort_col": sort_by or None,
        "p_sort_dir": "desc" if str(sort_dir).lower() == "desc" else "asc",
        "p_period_start": scope.period_start,
        "p_period_end": scope.period_end,
        # None (unscoped) vs a sorted tuple (team-scoped) must hash
        # differently, and two different managers' teams must never
        # collide on the same cache entry — sorted() makes the key
        # order-independent since scope_ids is an unordered set.
        "p_scope_ids": sorted(scope.scope_ids) if scope.scope_ids is not None else None,
        # Same collision risk as p_scope_ids above: without this, a
        # "worker" page request could be served a "staff" page request's
        # cached rows whenever every other param happened to match.
        "p_people_type": scope.people_type,
    }
    key = "page:" + _json_hash(payload)
    cached = _cache.get(key)
    if cached is not None:
        result = ok(cached, cached=True)
        result["page"] = page
        return result

    # staff/employees bypasses the generic RPC entirely, as of the
    # 2026-07 shift-display fix. get_tenant_table_page is a generic
    # cross-entity raw-select RPC with no visibility into this codebase from
    # here (its SQL lives in a Supabase migration, not this repo) — it very
    # likely does a plain `select * from client_staff`, which would carry the
    # exact same stale shift_label/duty_start/duty_end bug _direct_staff_page
    # had before it started calling support_db._resolve_shift_map.
    #
    # DECISION: correctness over the RPC's speculative perf benefit. Do not
    # re-enable this without first confirming (reading the RPC's SQL) that it
    # resolves client_staff.shift_id_ref against the `shifts` table the same
    # way support_db._resolve_shift_map / _client_staff_safe now do — same
    # precedence (shift_id_ref wins when present, legacy columns are the
    # fallback), same fields (shift/shift_id/shift_label/duty_start/duty_end/
    # shift_id_ref/shift_is_active). If/when the RPC is updated to do that
    # join, delete this `if entity not in {...}` guard and let staff/
    # employees use the RPC path like every other entity again.
    #
    # scope.scope_ids is None also gates this, for every entity: the RPC's
    # SQL lives in a Supabase migration, not this repo, and has no
    # p_scope_ids/p_people_type parameter — it cannot honor a 'team'-scoped
    # or people_type-filtered caller's visibility set. Falling through to
    # it for either would silently hand back the whole org/branch/all-types
    # result. Only take the RPC path when both are unset (unscoped:
    # org/branch admin or 'branch'-scoped, with no type filter).
    if entity not in {"staff", "employees", "payroll"} and scope.scope_ids is None and not scope.people_type:
        try:
            data = _rpc("get_tenant_table_page", payload)

            # Important:
            # Some SQL RPC versions return:
            # {"success": false, "message": "No matching table was found for entity.", "rows": []}
            # Do not accept that failed RPC response. Fall back to direct Supabase query.
            if (
                isinstance(data, dict)
                and data.get("success") is not False
                and isinstance(data.get("rows"), list)
            ):
                data["page"] = page
                _cache.set(key, data, ttl_seconds)
                return ok(data, cached=False)
        except Exception:
            pass

    if entity in {"staff", "employees"}:
        data = _direct_staff_page(scope, page, page_size, search, sort_by, sort_dir)
    elif entity == "branches":
        data = _direct_branches_page(scope, page, page_size, search, sort_by, sort_dir)
    elif entity == "attendance":
        data = _direct_attendance_page(scope, page, page_size, search, sort_by, sort_dir)
    elif entity == "leaves":
        data = _direct_leaves_page(scope, page, page_size, search, sort_by, sort_dir)
    elif entity == "payroll":
        data = _direct_payroll_page(scope, page, page_size, search, sort_by, sort_dir)
    else:
        data = _page_result(entity, [], 0, page, page_size, offset, "unsupported")
        data["success"] = False
        data["message"] = "Unsupported entity."
    _cache.set(key, data, ttl_seconds)
    return ok(data, cached=False)


def clear_fast_cache() -> None:
    _cache.clear()