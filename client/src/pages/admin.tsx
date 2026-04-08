import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { apiJson } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/* ── Types ─────────────────────────────────────────────── */

interface SummaryData {
  totalAgencies: number;
  activeSubscriptions: number;
  trialUsers: number;
  imagesLast30Days: number;
}

interface AgencyRow {
  agencyId: string;
  agencyName: string;
  planTier: string | null;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  seats: number;
  monthlyIncluded: number;
  usedThisMonth: number;
  remainingThisMonth: number;
  trialRemaining: number;
  addonBalance: number;
  createdAt: string;
  lastActiveAt: string | null;
  usagePercent: number;
  isNearLimit: boolean;
  isInactive: boolean;
}

interface AgencyDetail {
  agencyId: string;
  agencyName: string;
  planTier: string | null;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  createdAt: string;
  seats: number;
  monthlyIncluded: number;
  usedThisMonth: number;
  remainingThisMonth: number;
  trialRemaining: number;
  addonBalance: number;
  lastActiveAt: string | null;
  usage: {
    totalImagesProcessed: number;
    imagesThisMonth: number;
    retryCount: number;
    editCount: number;
  };
  users: Array<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
  }>;
}

type SortKey = keyof AgencyRow;
type SortDir = "asc" | "desc";

/* ── Helpers ───────────────────────────────────────────── */

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-NZ", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return "Today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return fmtDate(iso);
}

function statusColor(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "bg-green-100 text-green-800";
    case "TRIAL":
      return "bg-blue-100 text-blue-800";
    case "PAST_DUE":
      return "bg-orange-100 text-orange-800";
    case "CANCELLED":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

/* ── Component ─────────────────────────────────────────── */

export default function AdminDashboard() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [agencies, setAgencies] = useState<AgencyRow[]>([]);
  const [detail, setDetail] = useState<AgencyDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(true);

  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Guard: redirect non-admins
  useEffect(() => {
    if (!loading && (!user || !user.isSiteAdmin)) {
      navigate("/home", { replace: true });
    }
  }, [user, loading, navigate]);

  // Fetch data
  useEffect(() => {
    if (!user?.isSiteAdmin) return;
    let cancelled = false;

    async function load() {
      try {
        const [summaryRes, agenciesRes] = await Promise.all([
          apiJson<SummaryData>("/api/admin/dashboard/summary"),
          apiJson<{ agencies: AgencyRow[] }>("/api/admin/dashboard/agencies"),
        ]);
        if (cancelled) return;
        setSummary(summaryRes);
        setAgencies(agenciesRes.agencies);
      } catch (err: any) {
        if (cancelled) return;
        if (err?.status === 403) {
          navigate("/home", { replace: true });
          return;
        }
        setError(err.message || "Failed to load admin data");
      } finally {
        if (!cancelled) setLoadingData(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [user, navigate]);

  // Sort
  const sorted = useMemo(() => {
    const copy = [...agencies];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      if (typeof av === "boolean" && typeof bv === "boolean") {
        return sortDir === "asc" ? (av ? 1 : 0) - (bv ? 1 : 0) : (bv ? 1 : 0) - (av ? 1 : 0);
      }
      return 0;
    });
    return copy;
  }, [agencies, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  async function openDetail(agencyId: string) {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const data = await apiJson<AgencyDetail>(`/api/admin/dashboard/agencies/${encodeURIComponent(agencyId)}`);
      setDetail(data);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  if (loading || loadingData) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto" />
          <p className="text-sm text-muted-foreground">Loading admin dashboard…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">Admin Dashboard</h1>

      {/* Summary Cards */}
      {summary && (
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <SummaryCard title="Total Agencies" value={summary.totalAgencies} />
          <SummaryCard title="Active Subscriptions" value={summary.activeSubscriptions} />
          <SummaryCard title="Active Trials" value={summary.trialUsers} />
          <SummaryCard title="Images (30d)" value={summary.imagesLast30Days} />
        </div>
      )}

      {/* Agency Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Agencies</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead k="agencyName" label="Agency" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <SortableHead k="planTier" label="Plan" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <SortableHead k="subscriptionStatus" label="Status" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <SortableHead k="seats" label="Seats" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <SortableHead k="usedThisMonth" label="Used / Incl." sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <SortableHead k="remainingThisMonth" label="Remaining" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <SortableHead k="trialRemaining" label="Trial Rem." sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <SortableHead k="addonBalance" label="Add-on" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <SortableHead k="lastActiveAt" label="Last Active" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
                <TableHead className="w-[100px]">Flags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                    No agencies found
                  </TableCell>
                </TableRow>
              )}
              {sorted.map((a) => (
                <TableRow
                  key={a.agencyId}
                  className={cn(
                    "cursor-pointer",
                    a.isInactive && "opacity-60"
                  )}
                  onClick={() => openDetail(a.agencyId)}
                >
                  <TableCell className="font-medium max-w-[200px] truncate">{a.agencyName || a.agencyId}</TableCell>
                  <TableCell>{a.planTier || "—"}</TableCell>
                  <TableCell>
                    <Badge className={cn("text-xs", statusColor(a.subscriptionStatus))} variant="outline">
                      {a.subscriptionStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>{a.seats}</TableCell>
                  <TableCell>
                    {a.usedThisMonth} / {a.monthlyIncluded || "∞"}
                  </TableCell>
                  <TableCell>{a.remainingThisMonth}</TableCell>
                  <TableCell>{a.trialRemaining || "—"}</TableCell>
                  <TableCell>{a.addonBalance || "—"}</TableCell>
                  <TableCell className="text-xs">{fmtRelative(a.lastActiveAt)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {a.isNearLimit && (
                        <Badge className="bg-orange-100 text-orange-800 text-[10px]" variant="outline">
                          Near Limit
                        </Badge>
                      )}
                      {a.isInactive && (
                        <Badge className="bg-gray-100 text-gray-600 text-[10px]" variant="outline">
                          Inactive
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Detail Drawer */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{detail?.agencyName || "Agency Detail"}</SheetTitle>
            <SheetDescription>{detail?.agencyId}</SheetDescription>
          </SheetHeader>

          {detailLoading && (
            <div className="py-12 text-center text-muted-foreground">Loading…</div>
          )}

          {!detailLoading && detail && (
            <div className="mt-6 space-y-6">
              {/* Overview */}
              <Section title="Overview">
                <DL label="Plan" value={detail.planTier || "—"} />
                <DL label="Status" value={detail.subscriptionStatus} />
                <DL label="Seats" value={detail.seats} />
                <DL label="Created" value={fmtDate(detail.createdAt)} />
              </Section>

              {/* Usage */}
              <Section title="Usage">
                <DL label="This Month" value={detail.usage.imagesThisMonth} />
                <DL label="Lifetime" value={detail.usage.totalImagesProcessed} />
                <DL label="Retries" value={detail.usage.retryCount} />
                <DL label="Edits" value={detail.usage.editCount} />
              </Section>

              {/* Billing */}
              <Section title="Billing">
                <DL label="Plan Tier" value={detail.planTier || "—"} />
                <DL label="Stripe Customer" value={detail.stripeCustomerId || "—"} />
                <DL label="Period Start" value={fmtDate(detail.currentPeriodStart)} />
                <DL label="Period End" value={fmtDate(detail.currentPeriodEnd)} />
                <DL label="Trial Remaining" value={detail.trialRemaining} />
                <DL label="Add-on Balance" value={detail.addonBalance} />
              </Section>

              {/* Users */}
              <Section title="Users">
                {detail.users.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No users</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.users.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell className="text-xs">{u.email}</TableCell>
                          <TableCell className="text-xs">{u.role}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Section>
            </div>
          )}

          {!detailLoading && !detail && (
            <div className="py-12 text-center text-muted-foreground">Failed to load details</div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────── */

function SummaryCard({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DL({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{String(value)}</span>
    </div>
  );
}

function SortableHead({
  k,
  label,
  sortKey,
  sortDir,
  toggle,
}: {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  toggle: (key: SortKey) => void;
}) {
  return (
    <TableHead
      className="cursor-pointer select-none whitespace-nowrap"
      onClick={() => toggle(k)}
    >
      {label}
      {sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
    </TableHead>
  );
}
