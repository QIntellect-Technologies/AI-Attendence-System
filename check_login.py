#!/usr/bin/env python3
"""Quick standalone login probe — prints status + full body, no quoting
issues like curl has on Windows PowerShell. Edit EMAIL/PASSWORD below,
or pass them as argv[1] / argv[2]."""
import sys
import requests

BASE_URL = "http://localhost:5000"
EMAIL = sys.argv[1] if len(sys.argv) > 1 else "fatimafertilizers@gmail.com"
PASSWORD = sys.argv[2] if len(sys.argv) > 2 else " AwNPSSP%Kd$KzjDE"

r = requests.post(f"{BASE_URL}/api/login", json={"email": EMAIL, "password": PASSWORD}, timeout=10)
print("Status:", r.status_code)
print("Body:", r.text)
