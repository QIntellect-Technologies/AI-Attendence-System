export interface User {
  id: string;
  email: string;
  name: string; // ← Ye field add kar di hai
  password: string;
  role:
    | "admin"
    | "staff"
    | "manager"
    | "developer"
    | "hr_executive"
    | "ceo"
    | "product_lead"
    | "strategic_advisor";
  staffId?: string;
}

export interface Staff {
  id: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  position: string;
  joinDate: string;
  photo?: string;
  userId: string;
}

export interface AttendanceRecord {
  id: string;
  staffId: string;
  date: string;
  inTime?: string;
  outTime?: string;
  inPhoto?: string;
  outPhoto?: string;
  status: "present" | "absent" | "half-day";
}

export interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  isAuthenticated: boolean;
}
