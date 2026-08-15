"""
hr_assistant_service.py
───────────────────────────────────────────────────────────────────────────────
Server-side counterpart of hr_chatbot_widget.dart. Two things moved here
that must NEVER live on the client:

  1. The LLM provider API key. It was previously hardcoded as a literal
     string in hr_chatbot_widget.dart (_apiKey), which ships inside the
     compiled APK and is trivially extractable. It now lives in this
     process's environment only (OPENROUTER_API_KEY), read the same way
     client_staff_auth.py reads CLIENT_STAFF_JWT_SECRET.

     Provider: OpenRouter (https://openrouter.ai) — chosen for its
     OpenAI-compatible /chat/completions shape and models available on a
     free tier (:free suffix). OPENROUTER_MODEL is configurable via env
     var because OpenRouter's free-model lineup changes over time; check
     https://openrouter.ai/models?max_price=0 for what's currently free
     before deploying, and pin whichever one you pick as an env var
     rather than hardcoding it, since a model can be deprecated/renamed
     out from under you with no code change on this end otherwise.

  2. The employee data the model is told about. The client used to build
     its own HREmployeeData object with whatever fields the calling screen
     happened to wire up (most silently defaulted to 0/placeholder — see
     the PR discussion). The model now only ever sees a `context` dict
     assembled server-side by support_db_hr_assistant.build_hr_assistant_context,
     which is scoped to the caller's own JWT-verified staff_id — the same
     trust boundary every other /api/staff/* route already enforces.

No HTTP client library (requests/httpx) was found anywhere in this codebase
for outbound third-party calls, so this uses only the Python stdlib
(urllib.request) rather than assume a new dependency is already installed.
If `requests` is in fact already a transitive dependency, swap
_call_openrouter's body for `requests.post(...)` — the call shape is the same.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
import urllib.error

_OPENROUTER_API_KEY: str | None = None
# Free-tier model. Using OpenRouter's auto-router ('openrouter/free')
# rather than a specific model id -- OpenRouter's free-model lineup
# rotates (providers add/remove :free variants over time), and the
# auto-router picks a currently-available free model for you instead of
# this breaking every time a specific model gets retired. Override via
# OPENROUTER_MODEL if you want to pin one specific free model instead
# (check https://openrouter.ai/models?max_price=0 for what's live).
_DEFAULT_MODEL = 'openrouter/free'
_OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
_MAX_TOKENS = 800
_REQUEST_TIMEOUT_SECONDS = 20


def _get_api_key() -> str:
    global _OPENROUTER_API_KEY
    if _OPENROUTER_API_KEY is None:
        key = os.environ.get('OPENROUTER_API_KEY', '').strip()
        if not key:
            raise RuntimeError(
                'OPENROUTER_API_KEY must be set in the server environment — '
                'the HR Assistant no longer accepts a client-supplied key.'
            )
        _OPENROUTER_API_KEY = key
    return _OPENROUTER_API_KEY


def _get_model() -> str:
    return os.environ.get('OPENROUTER_MODEL', '').strip() or _DEFAULT_MODEL


# ─── System prompt ──────────────────────────────────────────────────────────

def _fmt_money(n: float) -> str:
    return f'{n:,.0f}'


def _build_system_prompt(context: dict) -> str:
    staff = context['staff']
    salary = context['salary']
    attendance = context['attendance']
    leave = context['leave']
    overtime = context['overtime']

    leave_lines = '\n'.join(
        f"  - {leave_type}: {b['approved_days']} taken (approved), {b['pending_days']} pending"
        for leave_type, b in leave['by_type'].items()
    ) or '  - No leave requests filed this year.'

    salary_block = (
        f"- Basic Salary: Rs. {_fmt_money(salary['basic_salary'])}\n"
        f"- Allowances: Rs. {_fmt_money(salary['allowances'])}\n"
        f"- Deductions: Rs. {_fmt_money(salary['deductions'])}\n"
        f"- Net Pay (last processed): Rs. {_fmt_money(salary['net_pay'])}\n"
        f"- Payroll Status: {salary['status']}"
        + (f" (as of {salary['last_paid_date']})" if salary.get('last_paid_date') else '')
        if salary['configured']
        else "- Salary has not been configured for this employee yet in the system."
    )

    return f'''Tum Attendance Pro ka HR Assistant chatbot ho — Pakistani company ka helpful HR helper.

Employee ki verified info (yeh sirf yehi data hai jo tumhe pata hai — is se bahar kuch mat banao):
- Naam: {staff['name']}
- ID: {staff['employee_id']}
- Department: {staff['department']}
- Role: {staff['role']} | Type: {staff['staff_type']}

SALARY ({("last processed payroll" if salary['configured'] else "not configured")}):
{salary_block}

ATTENDANCE ({attendance['month_label']}):
- Present: {attendance['present_days']} / {attendance['working_days_elapsed']} working days so far
- Absent (estimated): {attendance['absent_days']}
- Rate: {attendance['attendance_rate_pct']}%

LEAVE USAGE ({leave['year']}, actual requests only):
{leave_lines}
- Total approved this year: {leave['total_approved_days']} days
- Total pending: {leave['total_pending_days']} days

OVERTIME (live request status):
- Approved: {overtime['approved_hours']} hrs (Rs. {_fmt_money(overtime['approved_pay'])})
- Pending: {overtime['pending_hours']} hrs across {overtime['pending_count']} request(s)

STRICT RULES:
1. ONLY use the numbers above. Never invent or estimate a figure that isn't listed.
2. This company has NO leave-quota/entitlement system yet — there is no "total annual leave"
   or "leaves remaining" number. If asked for it, say plainly that only usage is tracked
   right now (not a total/balance), and give the usage numbers above instead.
3. This company does NOT track a performance rating anywhere. If asked about performance,
   say clearly this isn't tracked in the system and suggest asking their manager directly.
   Never invent a rating.
4. If something is asked that isn't covered by the data above, say so and suggest contacting
   HR/their manager — do not guess.

LANGUAGE RULE:
- Urdu script mein pooche → Urdu script mein jawab do
- English mein pooche → English mein jawab do
- Mix → friendly mix mein jawab do

Topics: Salary, Leave, Attendance, Overtime. Exact numbers use karo.
'''


# ─── Info card (server-built now, from the same verified context) ─────────

def _detect_intent(message: str) -> str | None:
    q = message.lower()
    if re.search(r'salary|تنخواہ|pay|deduction', q):
        return 'salary'
    if re.search(r'leave|چھٹی', q):
        return 'leave'
    if re.search(r'attendance|حاضری', q):
        return 'attendance'
    if re.search(r'overtime|\bot\b|اوور', q):
        return 'overtime'
    return None


def _build_info_card(intent: str | None, context: dict) -> list[list[str]] | None:
    if intent is None:
        return None

    salary = context['salary']
    attendance = context['attendance']
    leave = context['leave']
    overtime = context['overtime']

    if intent == 'salary':
        if not salary['configured']:
            return [['Status', 'Salary not configured yet']]
        rows = [
            ['Basic Salary', f"Rs. {_fmt_money(salary['basic_salary'])}"],
            ['Allowances', f"+ Rs. {_fmt_money(salary['allowances'])}"],
            ['Deductions', f"- Rs. {_fmt_money(salary['deductions'])}"],
            ['Net Pay', f"Rs. {_fmt_money(salary['net_pay'])} ✓"],
        ]
        if salary.get('last_paid_date'):
            rows.append(['Last Paid', str(salary['last_paid_date'])])
        return rows

    if intent == 'leave':
        rows = [
            [leave_type, f"{b['approved_days']} taken, {b['pending_days']} pending"]
            for leave_type, b in leave['by_type'].items()
        ]
        rows.append(['Total This Year', f"{leave['total_approved_days']} days taken"])
        return rows or [['Leave', 'No requests filed this year']]

    if intent == 'attendance':
        return [
            ['This Month', f"{attendance['present_days']}/{attendance['working_days_elapsed']} days"],
            ['Absent (est.)', f"{attendance['absent_days']} days"],
            ['Rate', f"{attendance['attendance_rate_pct']}%"],
        ]

    if intent == 'overtime':
        return [
            ['Approved', f"{overtime['approved_hours']} hrs"],
            ['Approved Pay', f"Rs. {_fmt_money(overtime['approved_pay'])}"],
            ['Pending', f"{overtime['pending_hours']} hrs ({overtime['pending_count']} req.)"],
        ]

    return None


# ─── OpenRouter call ─────────────────────────────────────────────────────

def _call_openrouter(system_prompt: str, message: str) -> str:
    body = json.dumps({
        'model': _get_model(),
        'max_tokens': _MAX_TOKENS,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': message},
        ],
    }).encode('utf-8')

    req = urllib.request.Request(
        _OPENROUTER_URL,
        data=body,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {_get_api_key()}',
            # OpenRouter uses these two (optional, no client secret in
            # them) purely for its own attribution/rate-limit dashboards
            # -- not required for the call to work, but recommended by
            # their docs. Safe to leave as-is or point at your real app.
            'HTTP-Referer': os.environ.get('OPENROUTER_SITE_URL', 'https://qintellect.local'),
            'X-Title': 'QIntellect HR Assistant',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')[:300]
        raise RuntimeError(f'HR Assistant upstream error ({e.code}): {detail}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(f'HR Assistant is unreachable: {e.reason}') from e

    choices = data.get('choices') or []
    if not choices:
        # Free-tier models on OpenRouter can return an empty choices list
        # under load-shedding/rate-limit conditions even on a 200 -- surface
        # whatever error field they attached instead of a blank KeyError.
        err = data.get('error')
        if err:
            raise RuntimeError(f"HR Assistant upstream error: {err}")
        raise RuntimeError('HR Assistant returned an empty response')

    reply = (choices[0].get('message') or {}).get('content', '')
    if not reply:
        raise RuntimeError('HR Assistant returned an empty response')
    return reply


# ─── Entry point used by the route ──────────────────────────────────────────

def get_hr_assistant_reply(context: dict, message: str) -> dict:
    """context comes from support_db_hr_assistant.build_hr_assistant_context
    (already scoped to the caller's own JWT-verified staff_id). Returns
    { reply: str, info_card: list[[str,str]] | None }."""
    system_prompt = _build_system_prompt(context)
    reply = _call_openrouter(system_prompt, message)
    info_card = _build_info_card(_detect_intent(message), context)
    return {'reply': reply, 'info_card': info_card}