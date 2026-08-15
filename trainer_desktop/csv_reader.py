from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Iterable

from trainer_desktop.models import EnrollmentPerson
from trainer_desktop.identity import identity_key

class EnrollmentCsvError(RuntimeError):
    pass


COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "people_type": ("people_type", "people type", "person type", "type", "role type"),
    "person_code": (
        "person_code",
        "person code",
        "registration number",
        "registration no",
        "reg no",
        "student registration number",
        "student id",
        "roll no",
        "roll number",
        "employee id",
        "employee number",
        "staff id",
        "teacher code",
        "worker id",
        "code",
    ),
    "full_name": ("full name", "name", "person name", "student name", "employee name", "staff name"),
    "video_file_name": ("video file name", "video filename", "video", "video file", "video name"),
    "group": ("group", "class", "department", "grade", "team"),
    "subgroup": ("subgroup", "sub group", "section", "role", "designation"),
    "branch": ("branch", "branch name", "location"),
    "profile_image_file_name": (
        "profile image file name",
        "profile image",
        "photo file name",
        "photo",
        "image file name",
        "image",
    ),
}


REQUIRED_CANONICAL_COLUMNS = ("person_code", "full_name", "video_file_name")

# Encodings to try, in order, when decoding operator-supplied CSVs. This
# covers the two save formats Excel on Windows actually offers:
#   - "CSV UTF-8 (Comma delimited)"  -> utf-8, optionally with a BOM
#   - "CSV (Comma delimited)"        -> the system ANSI codepage, which on
#                                        virtually all Windows installs is
#                                        Windows-1252 (cp1252)
# cp1252 assigns a printable character to almost every byte value (unlike
# strict utf-8), so it is tried last as a permissive fallback rather than
# first, to avoid silently misreading a file that is genuinely UTF-8.
CSV_TEXT_ENCODINGS: tuple[str, ...] = ("utf-8-sig", "cp1252")


def _read_csv_text(csv_path: Path) -> str:
    """Reads the full CSV file as text, tolerating both CSV save formats
    Excel produces on Windows. Raises a clear, actionable error only if
    the file matches neither."""
    last_error: UnicodeDecodeError | None = None
    for encoding in CSV_TEXT_ENCODINGS:
        try:
            return csv_path.read_text(encoding=encoding)
        except UnicodeDecodeError as exc:
            last_error = exc
            continue
    raise EnrollmentCsvError(
        f"Could not decode '{csv_path.name}' using any supported encoding {CSV_TEXT_ENCODINGS}: "
        f"{last_error}. In Excel, use File > Save As > 'CSV UTF-8 (Comma delimited)' and re-export."
    )


def _sniff_dialect(sample: str) -> type[csv.Dialect]:
    """Detects the actual delimiter used in the file rather than assuming
    comma. Enrollment CSVs are frequently hand-edited/exported from Excel
    by non-technical branch staff, and some regional Excel locales emit
    ';'-delimited output even with a .csv extension. Falls back to
    standard comma-delimited if sniffing is inconclusive (e.g. a
    single-column file, which legitimately has no delimiter to detect)."""
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        return csv.excel


def _normalize_header(value: str) -> str:
    return " ".join(str(value or "").replace("_", " ").strip().lower().split())


def _normalize_people_type(value: str) -> str:
    key = _normalize_header(value)
    if key in {"student", "students"}:
        return "student"
    if key in {"teacher", "teachers"}:
        return "teacher"
    if key in {"employee", "employees"}:
        return "employee"
    if key in {"worker", "workers"}:
        return "worker"
    if key in {"staff", "staff member", "staff members"}:
        return "staff"
    return key.replace(" ", "_") or "staff"


def _build_header_map(fieldnames: Iterable[str] | None) -> dict[str, str]:
    if not fieldnames:
        raise EnrollmentCsvError("CSV file has no header row.")

    fieldnames = list(fieldnames)
    normalized_to_original = {_normalize_header(header): header for header in fieldnames}
    header_map: dict[str, str] = {}

    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            original = normalized_to_original.get(_normalize_header(alias))
            if original:
                header_map[canonical] = original
                break

    missing = [column for column in REQUIRED_CANONICAL_COLUMNS if column not in header_map]
    if missing:
        labels = ", ".join(missing)
        detected = ", ".join(repr(name) for name in fieldnames)
        hint = ""
        if len(fieldnames) == 1 and (";" in fieldnames[0] or "\t" in fieldnames[0]):
            hint = (
                " The entire header row was read as a single column, which means the file's "
                "delimiter was not detected correctly (likely ';' or tab instead of ','). "
                "Re-save the file as a standard comma-delimited CSV."
            )
        raise EnrollmentCsvError(
            f"CSV is missing required column(s): {labels}. Detected header(s): {detected}.{hint}"
        )

    return header_map


def _read_cell(row: dict[str, str], header_map: dict[str, str], canonical: str) -> str:
    original = header_map.get(canonical)
    if not original:
        return ""
    return str(row.get(original, "") or "").strip()


def read_enrollment_csv(csv_path: Path) -> list[EnrollmentPerson]:
    if not csv_path.exists() or not csv_path.is_file():
        raise EnrollmentCsvError(f"Enrollment CSV was not found: {csv_path}")

    text = _read_csv_text(csv_path)
    dialect = _sniff_dialect(text[:8192])
    # io.StringIO is used instead of a re-opened file handle because we
    # already have the fully-decoded text in memory from the encoding
    # fallback above; Path.read_text() performs universal newline
    # translation, so \r\n / \r are already normalized to \n before the
    # csv module ever sees them.
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    header_map = _build_header_map(reader.fieldnames)
    people: list[EnrollmentPerson] = []
    seen_codes: set[tuple[str, str]] = set()

    for index, row in enumerate(reader, start=2):
        raw_people_type = _read_cell(row, header_map, "people_type") or "staff"
        people_type = _normalize_people_type(raw_people_type)
        person_code = _read_cell(row, header_map, "person_code")
        full_name = _read_cell(row, header_map, "full_name")
        video_file_name = _read_cell(row, header_map, "video_file_name")
        group = _read_cell(row, header_map, "group")
        subgroup = _read_cell(row, header_map, "subgroup")
        branch = _read_cell(row, header_map, "branch")
        profile_image_file_name = _read_cell(row, header_map, "profile_image_file_name")

        if not any(str(value or "").strip() for value in row.values()):
            continue
        if not person_code:
            raise EnrollmentCsvError(f"Row {index}: person code / registration number is required.")
        if not full_name:
            raise EnrollmentCsvError(f"Row {index}: full name is required.")
        if not video_file_name:
            raise EnrollmentCsvError(f"Row {index}: video file name is required.")

        key = identity_key(people_type, person_code)
        if not key[1]:
            raise EnrollmentCsvError(
                f"Row {index}: person code '{person_code}' has no usable characters after normalization."
            )
        if key in seen_codes:
            raise EnrollmentCsvError(
                f"Row {index}: person code '{person_code}' collides with another row after "
                f"filename normalization (people type '{people_type}'). Registration numbers "
                f"that differ only by punctuation (e.g. '2024/CS/001' vs '2024_CS_001') are "
                f"treated as the same identity."
            )
        seen_codes.add(key)
        

        known_original_headers = set(header_map.values())
        extra = {
            str(key): str(value or "").strip()
            for key, value in row.items()
            if key not in known_original_headers and str(value or "").strip()
        }

        people.append(
            EnrollmentPerson(
                row_number=index,
                people_type=people_type,
                person_code=person_code,
                full_name=full_name,
                video_file_name=video_file_name,
                group=group,
                subgroup=subgroup,
                branch=branch,
                profile_image_file_name=profile_image_file_name,
                extra=extra,
            )
        )

    if not people:
        raise EnrollmentCsvError("Enrollment CSV does not contain any people rows.")

    return people