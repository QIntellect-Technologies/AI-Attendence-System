#!/usr/bin/env bash
#
# verify_security_fixes.sh — apply-and-verify helper for the security patch.
#
# Run this from your backend/ directory (the one containing app.py).
# It never touches your working tree until the dry run passes.
#
#   ./verify_security_fixes.sh check    # dry run only, changes nothing
#   ./verify_security_fixes.sh apply    # back up, apply, then run the tests
#   ./verify_security_fixes.sh test     # just run the tests on whatever is there
#   ./verify_security_fixes.sh rollback # restore the most recent backup
#
set -euo pipefail

PATCH="${PATCH:-security_fixes.patch}"
BACKUP_DIR="${BACKUP_DIR:-.security_patch_backup}"
FILES=(app.py support_routes.py client_staff_auth_routes.py)

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

need_here() {
  [[ -f app.py ]] || { red "app.py not found — run this from your backend/ directory."; exit 1; }
  [[ -f "$PATCH" ]] || { red "$PATCH not found. Put the patch here, or set PATCH=/path/to/it."; exit 1; }
}

do_check() {
  need_here
  if command -v git >/dev/null && git apply --check -p1 "$PATCH" 2>/dev/null; then
    grn "Dry run clean (git apply)."; return 0
  fi
  if patch -p1 --dry-run --forward < "$PATCH" >/dev/null 2>&1; then
    grn "Dry run clean (GNU patch)."; return 0
  fi
  red "Patch does NOT apply cleanly to these files."
  ylw "Most likely your app.py has already diverged from the audited version."
  ylw "Show the conflict with:  patch -p1 --dry-run < $PATCH"
  return 1
}

do_apply() {
  need_here
  do_check || exit 1

  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR/$stamp"
  for f in "${FILES[@]}"; do [[ -f "$f" ]] && cp -p "$f" "$BACKUP_DIR/$stamp/"; done
  echo "$stamp" > "$BACKUP_DIR/latest"
  grn "Backed up originals to $BACKUP_DIR/$stamp/"

  if command -v git >/dev/null && git apply -p1 "$PATCH" 2>/dev/null; then
    grn "Applied (git apply)."
  else
    patch -p1 --forward < "$PATCH"
    grn "Applied (GNU patch)."
  fi

  do_test
}

do_test() {
  need_here
  [[ -f test_security_fixes.py ]] || { red "test_security_fixes.py missing — the patch adds it."; exit 1; }

  ylw "Running the suite..."
  if python3 test_security_fixes.py; then
    grn "All tests passed."
  else
    red "Tests FAILED. Roll back with: $0 rollback"
    exit 1
  fi

  echo
  ylw "Reminder — two things the tests cannot check for you:"
  echo "  1. Set CORS_ALLOWED_ORIGINS to your real dashboard origin(s)."
  echo "     The default is localhost-only, so production WILL break loudly without it."
  echo "  2. Rotate every secret in .env (SUPABASE_SERVICE_KEY, the three JWT"
  echo "     secrets, LOCAL_NODE_API_KEY, OPENROUTER_API_KEY). The dashboard JWT"
  echo "     secret alone lets anyone mint an admin token and defeat these fixes."
}

do_rollback() {
  need_here
  [[ -f "$BACKUP_DIR/latest" ]] || { red "No backup found in $BACKUP_DIR."; exit 1; }
  local stamp; stamp="$(cat "$BACKUP_DIR/latest")"
  for f in "${FILES[@]}"; do
    [[ -f "$BACKUP_DIR/$stamp/$f" ]] && cp -p "$BACKUP_DIR/$stamp/$f" "$f"
  done
  rm -f login_throttle.py test_security_fixes.py
  grn "Rolled back to $stamp."
}

case "${1:-check}" in
  check)    do_check ;;
  apply)    do_apply ;;
  test)     do_test ;;
  rollback) do_rollback ;;
  *) echo "Usage: $0 {check|apply|test|rollback}"; exit 1 ;;
esac
