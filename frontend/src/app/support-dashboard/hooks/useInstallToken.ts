import { useCallback, useState } from "react";

export interface InstallTokenResult {
    install_token: string;
    expires_at: string;
    org_id: string;
    organization_name?: string;
    branch_id: string;
    branch_name?: string;
}

interface UseInstallTokenReturn {
    token: InstallTokenResult | null;
    isGenerating: boolean;
    error: string | null;
    generate: (orgId: string, branchId: string) => Promise<void>;
    clear: () => void;
}

/**
 * Generic hook: takes any (orgId, branchId) => Promise<InstallTokenResult>
 * generator so both the org-scoped API module and the global branches API
 * module can share identical modal/state behavior without duplicating logic.
 */
export function useInstallToken(
    generator: (orgId: string, branchId: string) => Promise<InstallTokenResult>,
): UseInstallTokenReturn {
    const [token, setToken] = useState<InstallTokenResult | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const generate = useCallback(
        async (orgId: string, branchId: string) => {
            setIsGenerating(true);
            setError(null);
            setToken(null);
            try {
                const result = await generator(orgId, branchId);
                setToken(result);
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : "Failed to generate install token";
                setError(message);
            } finally {
                setIsGenerating(false);
            }
        },
        [generator],
    );

    const clear = useCallback(() => {
        setToken(null);
        setError(null);
    }, []);

    return { token, isGenerating, error, generate, clear };
}