// shared/src/auth/types.ts
// Agency and authentication type definitions

export type UserRole = "owner" | "admin" | "member";
export type PlanTier = "starter" | "pro" | "agency";

export interface Agency {
  agencyId: string;
  name: string;
  planTier: PlanTier;
  maxSeats: number;
  createdAt: string;
  updatedAt?: string;
}

export interface SeatLimitCheck {
  over: boolean;
  active: number;
  maxSeats: number;
}
