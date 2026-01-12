import React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";

interface UsageBarProps {
  label: string;
  used: number;
  total: number;
  warningLevel: "none" | "approaching" | "critical" | "exhausted";
  type?: "main" | "staging";
}

export function UsageBar({ label, used, total, warningLevel, type = "main" }: UsageBarProps) {
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;

  // Determine color based on warning level
  const getColorClass = () => {
    switch (warningLevel) {
      case "exhausted":
        return "bg-red-500";
      case "critical":
        return "bg-orange-500";
      case "approaching":
        return "bg-yellow-500";
      default:
        return "bg-green-500";
    }
  };

  const getTextColor = () => {
    switch (warningLevel) {
      case "exhausted":
        return "text-red-700";
      case "critical":
        return "text-orange-700";
      case "approaching":
        return "text-yellow-700";
      default:
        return "text-gray-700";
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className={`font-medium ${getTextColor()}`}>{label}</span>
        <span className={`text-sm ${getTextColor()}`}>
          {used} / {total} used
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all ${getColorClass()}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      {warningLevel === "exhausted" && (
        <p className="text-xs text-red-600 font-medium">
          Limit reached. Upgrade your plan to continue.
        </p>
      )}
      {warningLevel === "critical" && (
        <p className="text-xs text-orange-600">
          You've used {percent}% of your monthly allowance.
        </p>
      )}
      {warningLevel === "approaching" && (
        <p className="text-xs text-yellow-600">
          You've used {percent}% of your monthly allowance.
        </p>
      )}
    </div>
  );
}

interface UsageSummaryProps {
  mainUsed: number;
  mainTotal: number;
  mainWarning: "none" | "approaching" | "critical" | "exhausted";
  stagingUsed?: number;
  stagingTotal?: number;
  stagingWarning?: "none" | "approaching" | "critical" | "exhausted";
  planName: string;
  monthKey: string;
  stagingNote?: string;
  topUsers?: Array<{ userId: string; name: string; used: number }>;
}

export function UsageSummary({
  mainUsed,
  mainTotal,
  mainWarning,
  stagingUsed,
  stagingTotal,
  stagingWarning,
  planName,
  monthKey,
  stagingNote,
  topUsers,
}: UsageSummaryProps) {
  const hasStaging = stagingTotal && stagingTotal > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Monthly Usage</h3>
        <span className="text-sm text-gray-500">{monthKey}</span>
      </div>

      <UsageBar
        label="Enhanced Images"
        used={mainUsed}
        total={mainTotal}
        warningLevel={mainWarning}
        type="main"
      />

      {mainWarning === "exhausted" && (
        <Alert variant="destructive">
          <AlertDescription>
            Your agency has reached its monthly image limit. Please upgrade your plan or wait until next month to continue enhancing images.
          </AlertDescription>
        </Alert>
      )}

      <div className="text-xs text-gray-600 bg-gray-50 p-3 rounded border border-gray-200">
        <p className="font-semibold mb-1">Image consumption:</p>
        <ul className="space-y-0.5 ml-2">
          <li>• Enhancement only (1A): <span className="font-medium">1 image</span></li>
          <li>• Enhancement + Declutter (1A + 1B): <span className="font-medium">1 image</span></li>
          <li>• Enhancement + Staging (1A + Stage 2): <span className="font-medium">2 images</span></li>
          <li>• Enhancement + Declutter + Staging (1A + 1B + Stage 2): <span className="font-medium">2 images</span></li>
        </ul>
      </div>

      {topUsers && topUsers.length > 0 && (
        <div className="pt-4 border-t border-gray-200">
          <h4 className="text-sm font-semibold mb-2">Top Users This Month</h4>
          <div className="space-y-1">
            {topUsers.map((u) => (
              <div key={u.userId} className="flex items-center justify-between text-sm">
                <span className="text-gray-700 truncate">{u.name}</span>
                <span className="text-gray-500 font-mono">{u.used}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
