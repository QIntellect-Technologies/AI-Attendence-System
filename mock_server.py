"""Mock backends used to validate audit_endpoints.py itself.

An audit script that reports "all clear" is worthless unless you've proven
it can also report "still broken". This spins up two stub servers with the
same routes and opposite behaviour, runs the audit against each, and
asserts the audit passes on the fixed one and fails on the vulnerable one.

    python mock_server.py          # runs both scenarios, self-checking
"""

from __future__ import annotations

import subprocess
import sys
import threading
import time

from flask import Flask, jsonify, request
from flask_cors import CORS

# Paths the audit probes, and how a FIXED server should answer.
RETIRED = [
    ('/api/users', ['GET']),
    ('/api/users/<uid>', ['GET']),
    ('/api/enroll/upload-video', ['POST']),
    ('/api/recognize/frame', ['POST']),
    ('/api/recognize/rtsp', ['POST']),
    ('/api/legal/<doc>', ['GET', 'POST']),
    ('/get_staff_list', ['GET']),
    ('/get_attendance_today', ['GET']),
    ('/get_detected_name/all', ['GET']),
    ('/get_pending_leaves', ['GET']),
    ('/update_leave_status', ['POST']),
    ('/api/staff/<sid>/training-video', ['POST']),
]

AUTHED = [
    ('/api/salary', ['GET']),
    ('/api/salary/<uid>', ['GET']),
    ('/api/users/<uid>/delete', ['POST']),
    ('/api/change-password', ['POST']),
    ('/api/staff/<uid>/restore', ['POST']),
    ('/api/attendance/mark-absent', ['POST']),
    ('/api/attendance/today', ['GET']),
    ('/api/live-detections', ['GET']),
    ('/api/staff/archived', ['GET']),
    ('/api/payroll/mark-paid', ['POST']),
    ('/api/payroll/mark-pending', ['POST']),
    ('/api/dashboard/embeddings/import', ['POST']),
    ('/api/stream/<cid>', ['GET']),
    ('/video_feed/<cid>', ['GET']),
    ('/api/cctv/live-tracking', ['GET']),
    ('/api/overtime', ['GET', 'POST']),
    ('/api/overtime/<oid>', ['PUT']),
    ('/api/notifications', ['GET']),
    ('/api/org/retention-policy', ['GET', 'PUT']),
    ('/api/attendance', ['GET']),
    ('/api/leaves', ['GET']),
    ('/api/leaves/<lid>', ['PUT', 'DELETE']),
    ('/api/staff', ['GET', 'POST']),
    ('/api/payroll/policy', ['GET']),
    ('/api/users/<uid>/profile', ['PATCH']),
    ('/v1/node/heartbeat', ['POST']),
]


def build(vulnerable: bool) -> Flask:
    app = Flask(f'mock_{"vuln" if vulnerable else "fixed"}')

    if vulnerable:
        CORS(app)  # the original wildcard
    else:
        CORS(app, resources={r'/api/*': {'origins': ['https://dashboard.example.com']},
                             r'/v1/*': {'origins': ['https://dashboard.example.com']}},
             supports_credentials=True)

    @app.route('/api/health')
    def health():
        return jsonify({'status': 'ok'})

    def make(endpoint_name, retired):
        def handler(**kwargs):
            if vulnerable:
                # The original behaviour: hand the data over, or 400 because
                # the payload was parsed before any auth check.
                if request.method in ('POST', 'PUT', 'PATCH'):
                    return jsonify({'error': 'organization_id is required'}), 400
                return jsonify({'data': 'SENSITIVE'}), 200
            if retired:
                return jsonify({'error': 'This endpoint has been retired.'}), 410
            return jsonify({'error': 'Authorization header required'}), 401
        handler.__name__ = endpoint_name
        return handler

    seen = set()
    for i, (rule, methods) in enumerate(RETIRED):
        app.add_url_rule(rule, f'ret_{i}', make(f'ret_{i}', True), methods=methods)
        seen.add(rule)
    for i, (rule, methods) in enumerate(AUTHED):
        app.add_url_rule(rule, f'auth_{i}', make(f'auth_{i}', False), methods=methods)

    # Login: 401 on bad creds; the fixed server also throttles.
    state = {'fails': 0}

    @app.route('/api/login', methods=['POST'])
    def login():
        state['fails'] += 1
        if not vulnerable and state['fails'] > 8:
            resp = jsonify({'message': 'Too many failed login attempts.'})
            resp.status_code = 429
            resp.headers['Retry-After'] = '900'
            return resp
        return jsonify({'success': False, 'message': 'Invalid credentials'}), 401

    return app


def serve(app, port):
    t = threading.Thread(
        target=lambda: app.run(port=port, debug=False, use_reloader=False),
        daemon=True)
    t.start()
    time.sleep(1.5)


def run_audit(port: int):
    """Run the audit as a subprocess, capturing output safely.

    encoding + PYTHONIOENCODING matter here: on Windows, capture_output pipes
    default to cp1252, which cannot encode the report's emoji. Without these
    the audit dies on UnicodeEncodeError and this harness misreads that as an
    audit failure.
    """
    import os
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    return subprocess.run(
        [sys.executable, 'audit_endpoints.py', f'http://127.0.0.1:{port}',
         '--no-color', '--test-bruteforce'],
        capture_output=True, text=True, encoding='utf-8', env=env)


def main():
    fixed_port, vuln_port = 8811, 8812
    serve(build(vulnerable=False), fixed_port)
    serve(build(vulnerable=True), vuln_port)

    print('=' * 78)
    print('SCENARIO A - audit against a FIXED server (expect: all pass)')
    print('=' * 78)
    a = run_audit(fixed_port)
    print(a.stdout[-2500:])
    if a.returncode != 0 and a.stderr:
        print('stderr:', a.stderr[-800:])
    print(f'exit code: {a.returncode}')

    print('=' * 78)
    print('SCENARIO B - audit against a VULNERABLE server (expect: failures)')
    print('=' * 78)
    b = run_audit(vuln_port)
    print(b.stdout[-1800:])
    print(f'exit code: {b.returncode}')

    print('=' * 78)
    ok = (a.returncode == 0 and b.returncode == 1)
    print('SELF-CHECK:', 'PASS — audit distinguishes fixed from vulnerable'
          if ok else 'FAIL — audit does not discriminate')
    print('=' * 78)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())