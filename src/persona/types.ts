export interface PersonaProfile {
  userId: string;
  displayName: string;
  role: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaTrait {
  id: number;
  userId: string;
  label: string;
  value: string;
  confidence: number;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export type QueryCategory =
  | "placements"
  | "admissions"
  | "student_health"
  | "product_execution"
  | "finance"
  | "nst_operations"
  | "general";
