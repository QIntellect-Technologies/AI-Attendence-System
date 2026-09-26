import { useEffect } from "react";

const BRAND_NAME = "QIntellect Technologies AI Attendance System";

export function useDocumentTitle(section?: string | null): void {
    useEffect(() => {
        const previousTitle = document.title;
        document.title = section ? `${section} · ${BRAND_NAME}` : BRAND_NAME;

        return () => {
            document.title = previousTitle;
        };
    }, [section]);
}