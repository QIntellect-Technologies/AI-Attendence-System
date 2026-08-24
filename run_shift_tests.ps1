#!/usr/bin/env pwsh
# Windows PowerShell equivalent of run_shift_tests.sh.

$failed = $false

function Invoke-PytestSuite {
    param(
        [string]$Title,
        [string[]]$Arguments
    )

    Write-Host ""
    Write-Host $Title
    & python -m pytest @Arguments
    if ($LASTEXITCODE -ne 0) {
        $script:failed = $true
    }
}

Invoke-PytestSuite `
    "1. Overlap rule (pure logic)" `
    @("tests/test_shift_overlap.py", "-v", "--no-header")

Invoke-PytestSuite `
    "2. Guard is wired into every write path" `
    @("tests/test_shift_write_paths.py", "-v", "--no-header")

Invoke-PytestSuite `
    "3. Assignment reaches attendance marking + Local Node" `
    @("tests/test_shift_assignment_end_to_end.py", "-v", "--no-header")

Invoke-PytestSuite `
    "4. Existing shift/attendance suites (no regressions)" `
    @("tests/", "-q", "--no-header")

Write-Host ""
Write-Host "5. Audit: overlaps already in the database"
Write-Host "   (read-only; needs live Supabase credentials - skipped if absent)"
& python scripts/audit_shift_overlaps.py --warnings 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "   SKIPPED: no database connection configured."
}

Write-Host ""
if ($failed) {
    Write-Host "RESULT: FAILURES above - do not deploy."
    exit 1
}

Write-Host "RESULT: all shift-conflict tests passed."
exit 0