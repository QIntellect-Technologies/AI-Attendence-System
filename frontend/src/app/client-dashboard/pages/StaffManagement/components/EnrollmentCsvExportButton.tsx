import React, { useMemo } from "react";
import ExportCsvButton, {
    type ExportCsvColumn,
} from "../../../components/ui/ExportCsvButton";
import { normalizePeopleType } from "../types/types";
import type { StaffMember } from "../types/staffTypes";

interface Props {
    data: StaffMember[];
    filenamePrefix: string;
    videoExtension?: string;
}

const clean = (value: unknown): string => String(value ?? "").trim();

const codeOf = (m: StaffMember): string =>
    clean(m.personCode || m.registrationNumber || m.employeeId);

export default function EnrollmentCsvExportButton({
    data,
    filenamePrefix,
    videoExtension = "mp4",
}: Props) {
    const ext = videoExtension.replace(/^\./, "");

    const columns = useMemo<ExportCsvColumn<StaffMember>[]>(
        () => [
            { header: "people_type", accessor: (m) => normalizePeopleType(m.peopleType) },
            { header: "person_code", accessor: (m) => codeOf(m) },
            { header: "full_name", accessor: (m) => clean(m.name) },
            { header: "video_file_name", accessor: (m) => `${codeOf(m)}.${ext}` },
            { header: "group", accessor: (m) => clean(m.department) },
            {
                header: "subgroup",
                accessor: (m) => clean(m.designationName || m.role || m.position),
            },
            { header: "branch", accessor: (m) => clean(m.branchName) },
            { header: "department_id", accessor: (m) => clean(m.departmentId) },
            { header: "class_id", accessor: (m) => clean(m.classId) },
            { header: "section_id", accessor: (m) => clean(m.sectionId) },
        ],
        [ext],
    );

    const rows = useMemo(() => data.filter((m) => codeOf(m) !== ""), [data]);

    return (
        <ExportCsvButton
            data={rows}
            columns={columns}
            filename={`${filenamePrefix}_trainer_enrollment`}
            label="Trainer CSV"
            emptyMessage="No people with a person code to export."
            variant="secondary"
        />
    );
}