import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  ReactNode,
} from "react";

export interface OvertimeRequest {
  id: string;
  employeeName: string;
  employeeId: string;
  date: string;
  regularEndTime: string;
  overtimeEndTime: string;
  hours: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  appliedDate: string;
  department?: string;
  organizationId?: string;
  branchId?: number | string | null;
}

interface OvertimeContextValue {
  requests: OvertimeRequest[];
  addNewRequest: (newRequest: OvertimeRequest) => void;
  approveRequest: (id: string) => void;
  rejectRequest: (id: string) => void;
  resetRequests: (items: OvertimeRequest[]) => void;
}

const OvertimeContext = createContext<OvertimeContextValue | null>(null);

export const OvertimeProvider = ({ children }: { children: ReactNode }) => {
  // No seeded demo records. Production pages should hydrate overtime from the
  // backend/API layer so another organization's sample data never appears.
  const [requests, setRequests] = useState<OvertimeRequest[]>([]);

  const addNewRequest = useCallback((newRequest: OvertimeRequest) => {
    setRequests((prev) => [newRequest, ...prev]);
  }, []);

  const approveRequest = useCallback((id: string) => {
    setRequests((prev) =>
      prev.map((req) => (req.id === id ? { ...req, status: "approved" } : req)),
    );
  }, []);

  const rejectRequest = useCallback((id: string) => {
    setRequests((prev) =>
      prev.map((req) => (req.id === id ? { ...req, status: "rejected" } : req)),
    );
  }, []);

  const resetRequests = useCallback((items: OvertimeRequest[]) => {
    setRequests(Array.isArray(items) ? items : []);
  }, []);

  const value = useMemo<OvertimeContextValue>(
    () => ({
      requests,
      addNewRequest,
      approveRequest,
      rejectRequest,
      resetRequests,
    }),
    [requests, addNewRequest, approveRequest, rejectRequest, resetRequests],
  );

  return (
    <OvertimeContext.Provider value={value}>
      {children}
    </OvertimeContext.Provider>
  );
};

export const useOvertime = () => {
  const ctx = useContext(OvertimeContext);
  if (!ctx) throw new Error("useOvertime must be used inside OvertimeProvider");
  return ctx;
};
