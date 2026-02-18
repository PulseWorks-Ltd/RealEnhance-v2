import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";

export interface UsageSummary {
  hasAgency: boolean;
  monthKey: string;
  planCode?: string;
  planName?: string;
  status?: "active" | "trial" | "inactive" | "cancelled";
  price?: number;
  mainAllowance?: number;
  mainUsed?: number;
  mainRemaining?: number;
  mainUsagePercent?: number;
  mainWarning?: "none" | "approaching" | "critical" | "exhausted";
  addonRemaining?: number;
  remaining?: number; // Total remaining credits (main + addon)
  stagingAllowance?: number;
  stagingUsed?: number;
  stagingRemaining?: number;
  stagingUsagePercent?: number;
  stagingWarning?: "none" | "approaching" | "critical" | "exhausted";
  agencyName?: string;
  userRole?: string;
  stagingNote?: string;
  topUsers?: Array<{ userId: string; name: string; used: number }>;
  trial?: {
    status: "none" | "pending" | "active" | "expired" | "converted";
    expiresAt?: string | null;
    creditsTotal?: number;
    creditsUsed?: number;
    remaining?: number;
  };
}

export function useUsage() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiFetch("/api/usage/summary");
      const data = (await response.json()) as UsageSummary;
      setUsage(data);
    } catch (err) {
      console.error("Error fetching usage:", err);
      setError("Failed to fetch usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  return {
    usage,
    loading,
    error,
    refetch: fetchUsage,
  };
}
