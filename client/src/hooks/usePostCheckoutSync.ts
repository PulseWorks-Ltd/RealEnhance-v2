import { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useUsage } from "@/hooks/use-usage";
import { apiFetch } from "@/lib/api";
import { clearPendingEnhancementJobs, getPendingEnhancementJobIds } from "@/lib/pending-enhancement";
import { useToast } from "@/hooks/use-toast";

/**
 * usePostCheckoutSync - Post-Checkout Sync Hook
 * 
 * RULE 4: Stripe Success Return Handling
 * 
 * On Stripe success return (?subscription=success or ?bundle=success):
 * 1. Detect success query param
 * 2. Trigger refetchAgency, refetchBilling, refetchUsage
 * 3. Poll for subscription activation (agency.subscriptionStatus === "ACTIVE")
 * 4. After activation → redirect to /home (Enhance page)
 * 
 * Must NOT require logout/login or hard browser refresh.
 */
export function usePostCheckoutSync() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { refreshUser } = useAuth();
  const { refetch: refetchUsage } = useUsage();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);

  const refetchAgency = useCallback(async () => {
    try {
      const res = await apiFetch("/api/agency/info");
      if (res.ok) {
        const data = await res.json();
        return data.agency;
      }
    } catch (error) {
      console.error("[PostCheckoutSync] Failed to refetch agency:", error);
    }
    return null;
  }, []);

  const pollForSubscriptionActivation = useCallback(
    async (maxAttempts = 15, intervalMs = 1500): Promise<boolean> => {
      console.log("[PostCheckoutSync] Polling for subscription activation...");
      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[PostCheckoutSync] Poll attempt ${attempt}/${maxAttempts}`);
        
        // Refetch all data
        await Promise.all([
          refreshUser(),
          refetchAgency(),
          refetchUsage(),
        ]);

        // Check agency subscription status
        const agency = await refetchAgency();
        
        if (agency?.subscriptionStatus === "ACTIVE" || agency?.stripeSubscriptionId) {
          console.log("[PostCheckoutSync] Subscription activated!");
          return true;
        }

        // Wait before next attempt (except on last attempt)
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }

      console.warn("[PostCheckoutSync] Subscription not activated after polling");
      return false;
    },
    [refreshUser, refetchAgency, refetchUsage]
  );

  const handleSubscriptionSuccess = useCallback(async () => {
    if (syncing) return; // Prevent duplicate processing
    
    setSyncing(true);
    console.log("[PostCheckoutSync] Processing subscription success...");

    try {
      // Step 1: Initial refetch
      await Promise.all([
        refreshUser(),
        refetchAgency(),
        refetchUsage(),
      ]);

      // Step 2: Poll for activation
      const activated = await pollForSubscriptionActivation();
      let resumed = 0;
      const pendingJobIds = getPendingEnhancementJobIds();
      for (const jobId of pendingJobIds) {
        try {
          const resp = await apiFetch("/api/enhance/resume", {
            method: "POST",
            body: JSON.stringify({ jobId }),
          });
          const data = await resp.json().catch(() => ({}));
          if (data?.status === "processing") {
            resumed += 1;
          }
        } catch (error) {
          console.warn("[PostCheckoutSync] Failed to resume pending enhancement after subscription", { jobId, error });
        }
      }

      if (resumed > 0) {
        clearPendingEnhancementJobs();
      }

      if (activated) {
        // Step 3: Show success message
        toast({
          title: "Subscription Activated!",
          description: resumed > 0
            ? "Subscription activated and enhancement resumed. Redirecting to processing..."
            : "Your subscription is now active. Redirecting to Enhance...",
        });

        // Step 4: Clean up URL and redirect
        // Remove query params
        const newParams = new URLSearchParams(searchParams);
        newParams.delete("subscription");
        setSearchParams(newParams, { replace: true });

        // Wait a moment for user to see toast, then redirect
        setTimeout(() => {
          navigate(resumed > 0 ? "/processing" : "/home", { replace: true });
        }, 1500);
      } else {
        // Activation polling timed out - still redirect but show warning
        toast({
          title: "Subscription Processing",
          description: "Your subscription is being activated. You may need to refresh in a moment.",
          variant: "default",
        });

        // Clean up URL and redirect anyway
        const newParams = new URLSearchParams(searchParams);
        newParams.delete("subscription");
        setSearchParams(newParams, { replace: true });

        setTimeout(() => {
          navigate(resumed > 0 ? "/processing" : "/home", { replace: true });
        }, 2000);
      }
    } catch (error) {
      console.error("[PostCheckoutSync] Error during sync:", error);
      toast({
        title: "Sync Error",
        description: "There was an issue syncing your subscription. Please refresh the page.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  }, [
    syncing,
    refreshUser,
    refetchAgency,
    refetchUsage,
    pollForSubscriptionActivation,
    toast,
    navigate,
    searchParams,
    setSearchParams,
  ]);

  const handleBundleSuccess = useCallback(async () => {
    if (syncing) return;
    
    setSyncing(true);
    console.log("[PostCheckoutSync] Processing bundle purchase success...");

    try {
      // Refetch all data
      await Promise.all([
        refreshUser(),
        refetchAgency(),
        refetchUsage(),
      ]);

      const pendingJobIds = getPendingEnhancementJobIds();
      let resumed = 0;
      for (const jobId of pendingJobIds) {
        try {
          const resp = await apiFetch("/api/enhance/resume", {
            method: "POST",
            body: JSON.stringify({ jobId }),
          });
          const data = await resp.json().catch(() => ({}));
          if (data?.status === "processing") {
            resumed += 1;
          }
        } catch (error) {
          console.warn("[PostCheckoutSync] Failed to resume pending enhancement", { jobId, error });
        }
      }

      if (resumed > 0) {
        clearPendingEnhancementJobs();
      }

      toast({
        title: "Bundle Purchase Complete!",
        description: resumed > 0
          ? "Your credits were added and enhancement resumed. Redirecting to processing..."
          : "Your credits have been added. Redirecting to Enhance...",
      });

      // Clean up URL
      const newParams = new URLSearchParams(searchParams);
      newParams.delete("bundle");
      setSearchParams(newParams, { replace: true });

      // Redirect to Enhance
      setTimeout(() => {
        navigate(resumed > 0 ? "/processing" : "/home", { replace: true });
      }, 1500);
    } catch (error) {
      console.error("[PostCheckoutSync] Error during bundle sync:", error);
      toast({
        title: "Sync Error",
        description: "There was an issue syncing your purchase. Please refresh the page.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  }, [
    syncing,
    refreshUser,
    refetchAgency,
    refetchUsage,
    toast,
    navigate,
    searchParams,
    setSearchParams,
  ]);

  // Effect to detect and handle success returns
  useEffect(() => {
    const subscriptionSuccess = searchParams.get("subscription") === "success";
    const bundleSuccess = searchParams.get("bundle") === "success";

    if (subscriptionSuccess && !syncing) {
      handleSubscriptionSuccess();
    } else if (bundleSuccess && !syncing) {
      handleBundleSuccess();
    }
  }, [searchParams, syncing, handleSubscriptionSuccess, handleBundleSuccess]);

  return {
    syncing,
    refetchAgency,
  };
}
