import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { apiJson } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { CompareSlider } from "@/components/CompareSlider";

/* Admin > Review: every job's upload and results, newest first, with the
   staging work images for each attempt and quick "good / problem" marks.
   Image links come from the server, last 10 minutes, and are never logged. */

type Mark = { verdict: "good" | "problem"; tags: string[]; note: string; by: string; at: string } | null;
type Images = { original: string | null; enhanced: string | null; decluttered: string | null; staged: string | null; final: string | null };
interface ReviewJob {
  jobId: string;
  createdAt: string | null;
  imageName: string;
  userEmail?: string;
  agencyId: string | null;
  retry: string | null;
  options: { roomType: string | null; sceneType: string | null; declutter: boolean; stage: boolean; style: string | null };
  status: string;
  outcome: string;
  note: string | null;
  staging: { ok: boolean; attempts: number; reasons: string[]; steps: { attempt: number; outcome: string }[] } | null;
  images: Images;
  mark: Mark;
  attempts?: { attempt: number; outcome: string; images: { name: string; url: string | null }[]; texts: { name: string; url: string | null }[] }[];
}

const FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "published", label: "Published" },
  { value: "fell back", label: "Fell back" },
  { value: "failed", label: "Failed" },
  { value: "problem", label: "Marked problem" },
  { value: "good", label: "Marked good" },
  { value: "unmarked", label: "Not marked" },
];

// Plain names for the work images, in the order they're made.
const STEP_LABELS: [RegExp, string][] = [
  [/^2_staged_raw/, "Gemini's staging"],
  [/^2_staged_aligned/, "Staging lined up with the photo"],
  [/^3_mask_overlay/, "What was cut out (furniture)"],
  [/^3b_skirting_lined_up/, "Furniture moved onto the real floor"],
  [/^3c_floating_lined_up/, "Floating furniture moved down"],
  [/^4_changes_removed_by_pasteback/, "Room changes undone"],
  [/^9_safe_composite/, "Furniture on the real room"],
  [/^9_harmonise_raw/, "Gemini's lighting pass"],
  [/^10_final_harmonise/, "Relit final"],
  [/^11_checked_blend_repairs/, "Lighting pass: repaired areas (red)"],
  [/^11_final_checked_blend/, "Checked final"],
  [/^13_edge_cropped/, "Edge-cropped final"],
];
function stepLabel(name: string) {
  for (const [re, label] of STEP_LABELS) if (re.test(name)) return label;
  return name;
}
function stepOrder(name: string) {
  const i = STEP_LABELS.findIndex(([re]) => re.test(name));
  return i < 0 ? 99 : i;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function outcomeClass(outcome: string) {
  if (outcome === "published") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (outcome === "fell back") return "bg-amber-100 text-amber-800 border-amber-200";
  if (outcome === "failed") return "bg-red-100 text-red-800 border-red-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}
function apiErrorMessage(err: any, fallback: string): string {
  try {
    const body = JSON.parse(String(err?.body || ""));
    return String(body?.message || body?.error || fallback);
  } catch {
    return fallback;
  }
}

type Side = "original" | "enhanced" | "decluttered" | "staged";
const SIDE_LABEL: Record<Side, string> = { original: "Upload", enhanced: "Enhanced", decluttered: "Decluttered", staged: "Staged" };

// Before/after slider, like the one customers get. Either side can be switched.
function ReviewCompare({ images }: { images: Images }) {
  const have = (["original", "enhanced", "decluttered", "staged"] as Side[]).filter((k) => !!images[k]);
  const pickAfter = (): Side | null => (images.staged ? "staged" : images.decluttered ? "decluttered" : images.enhanced ? "enhanced" : null);
  const [left, setLeft] = useState<Side | null>(images.original ? "original" : have[0] || null);
  const [right, setRight] = useState<Side | null>(pickAfter());
  if (!left || !right || left === right || have.length < 2) return null;
  const choose = (side: "left" | "right") => (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground mr-1">{side === "left" ? "Left:" : "Right:"}</span>
      {have.map((k) => (
        <Button
          key={k}
          size="sm"
          variant={(side === "left" ? left : right) === k ? "default" : "outline"}
          className="h-7 px-2 text-xs"
          disabled={(side === "left" ? right : left) === k}
          onClick={() => (side === "left" ? setLeft(k) : setRight(k))}
        >
          {SIDE_LABEL[k]}
        </Button>
      ))}
    </div>
  );
  return (
    <div className="space-y-2">
      <CompareSlider
        key={`${left}-${right}`}
        originalImage={images[left]!}
        enhancedImage={images[right]!}
        originalLabel={SIDE_LABEL[left]}
        enhancedLabel={SIDE_LABEL[right]}
        height={420}
        className="w-full rounded-lg overflow-hidden"
        data-testid="review-compare-slider"
      />
      <div className="flex flex-wrap justify-between gap-2">
        {choose("left")}
        {choose("right")}
      </div>
    </div>
  );
}

function Thumb({ url, label, onOpen }: { url: string | null; label: string; onOpen?: (u: string, l: string) => void }) {
  return (
    <figure className="min-w-0">
      {url ? (
        <button type="button" className="block w-full" onClick={() => onOpen?.(url, label)}>
          <img src={url} alt={label} loading="lazy" className="w-full aspect-[4/3] object-cover rounded border bg-muted" />
        </button>
      ) : (
        <div className="w-full aspect-[4/3] rounded border bg-muted flex items-center justify-center text-xs text-muted-foreground">none</div>
      )}
      <figcaption className="mt-1 text-xs text-muted-foreground truncate">{label}</figcaption>
    </figure>
  );
}

export default function AdminReview() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<ReviewJob | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [zoom, setZoom] = useState<{ url: string; label: string } | null>(null);
  const [markTags, setMarkTags] = useState<string[]>([]);
  const [markNote, setMarkNote] = useState("");

  useEffect(() => {
    if (!loading && (!user || !(user as any).isSiteAdmin)) navigate("/home", { replace: true });
  }, [user, loading, navigate]);

  const load = useCallback(async (reset: boolean) => {
    setBusy(true);
    try {
      const offset = reset ? 0 : nextOffset;
      const res = await apiJson<{ jobs: ReviewJob[]; nextOffset: number; tags: string[] }>(
        `/api/admin/review/jobs?limit=30&offset=${offset}&filter=${encodeURIComponent(filter)}`,
      );
      setTags(res.tags || []);
      setJobs((prev) => (reset ? res.jobs : [...prev, ...res.jobs]));
      setNextOffset(res.nextOffset);
      setHasMore(res.jobs.length === 30);
    } catch (err: any) {
      if (err?.status === 403) return navigate("/home", { replace: true });
      toast({ title: "Could not load jobs", description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [filter, nextOffset, navigate, toast]);

  useEffect(() => {
    if ((user as any)?.isSiteAdmin) load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, filter]);

  async function openDetail(jobId: string) {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await apiJson<{ job: ReviewJob }>(`/api/admin/review/jobs/${encodeURIComponent(jobId)}`);
      setDetail(res.job);
      setMarkTags(res.job.mark?.tags || []);
      setMarkNote(res.job.mark?.note || "");
    } catch (err: any) {
      toast({ title: "Could not open job", description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveMark(verdict: "good" | "problem" | "clear") {
    if (!detail) return;
    try {
      const res = await apiJson<{ mark: Mark }>(`/api/admin/review/jobs/${encodeURIComponent(detail.jobId)}/mark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, tags: markTags, note: markNote }),
      });
      setDetail({ ...detail, mark: res.mark });
      setJobs((prev) => prev.map((j) => (j.jobId === detail.jobId ? { ...j, mark: res.mark } : j)));
      toast({ title: verdict === "clear" ? "Mark removed" : `Marked ${verdict}` });
    } catch (err: any) {
      toast({ title: "Could not save", description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
    }
  }

  if (loading || !(user as any)?.isSiteAdmin) return null;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Image review</h1>
          <p className="text-sm text-muted-foreground">Every upload and its results, newest first. Click a job for the staging steps.</p>
        </div>
        <Link to="/admin" className="text-sm underline">Back to Admin Dashboard</Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button key={f.value} size="sm" variant={filter === f.value ? "default" : "outline"} onClick={() => setFilter(f.value)}>
            {f.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {jobs.map((j) => (
          <button
            key={j.jobId}
            type="button"
            onClick={() => openDetail(j.jobId)}
            className="text-left rounded-lg border bg-card p-3 hover:shadow-sm transition-shadow space-y-2"
          >
            <div className="grid grid-cols-2 gap-2">
              <Thumb url={j.images.original || j.images.enhanced} label="Upload" />
              <Thumb url={j.images.final || j.images.staged || j.images.enhanced} label="Result" />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn("border", outcomeClass(j.outcome))}>{j.outcome}</Badge>
              {j.options.roomType && <Badge variant="outline">{j.options.roomType.replace(/_/g, " ")}</Badge>}
              {j.options.stage && <Badge variant="outline">staging</Badge>}
              {j.options.declutter && <Badge variant="outline">declutter</Badge>}
              {j.retry && <Badge variant="outline">retry</Badge>}
              {j.mark && (
                <Badge variant="outline" className={j.mark.verdict === "good" ? "border-emerald-300 text-emerald-700" : "border-red-300 text-red-700"}>
                  {j.mark.verdict}{j.mark.tags.length ? `: ${j.mark.tags.join(", ")}` : ""}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {fmtDate(j.createdAt)} · {j.imageName || j.jobId} · {j.userEmail || "unknown user"}
            </div>
            {j.staging && !j.staging.ok && j.staging.reasons.length > 0 && (
              <div className="text-xs text-amber-700 line-clamp-2">Staging: {j.staging.reasons.join(", ")}</div>
            )}
          </button>
        ))}
      </div>

      <div className="flex justify-center py-2">
        {hasMore ? (
          <Button variant="outline" disabled={busy} onClick={() => load(false)}>{busy ? "Loading…" : "Load more"}</Button>
        ) : (
          <span className="text-sm text-muted-foreground">{jobs.length ? "That's everything." : busy ? "Loading…" : "No jobs to show."}</span>
        )}
      </div>

      <Sheet open={detailLoading || !!detail} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-[900px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{detail?.imageName || "Job"}</SheetTitle>
            <SheetDescription>
              {detail ? `${fmtDate(detail.createdAt)} · ${detail.userEmail || "unknown user"} · ${detail.jobId}` : "Loading…"}
            </SheetDescription>
          </SheetHeader>
          {detail && (
            <div className="space-y-6 mt-4">
              <section className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className={cn("border", outcomeClass(detail.outcome))}>{detail.outcome}</Badge>
                  {detail.options.roomType && <Badge variant="outline">{detail.options.roomType.replace(/_/g, " ")}</Badge>}
                  {detail.options.style && <Badge variant="outline">{detail.options.style.replace(/_/g, " ")}</Badge>}
                </div>
                {detail.note && <p className="text-sm text-muted-foreground">{detail.note}</p>}
                <ReviewCompare key={detail.jobId} images={detail.images} />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Thumb url={detail.images.original} label="Upload" onOpen={(url, label) => setZoom({ url, label })} />
                  <Thumb url={detail.images.enhanced} label="Enhanced" onOpen={(url, label) => setZoom({ url, label })} />
                  {detail.options.declutter && <Thumb url={detail.images.decluttered} label="Decluttered" onOpen={(url, label) => setZoom({ url, label })} />}
                  {detail.options.stage && <Thumb url={detail.images.staged} label="Staged" onOpen={(url, label) => setZoom({ url, label })} />}
                </div>
              </section>

              <section className="space-y-2 rounded-lg border p-3">
                <h3 className="font-medium">Your mark</h3>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant={detail.mark?.verdict === "good" ? "default" : "outline"} onClick={() => saveMark("good")}>Good</Button>
                  <Button size="sm" variant={detail.mark?.verdict === "problem" ? "destructive" : "outline"} onClick={() => saveMark("problem")}>Problem</Button>
                  {detail.mark && <Button size="sm" variant="ghost" onClick={() => saveMark("clear")}>Clear</Button>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setMarkTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
                      className={cn("text-xs rounded-full border px-2 py-0.5", markTags.includes(t) ? "bg-red-50 border-red-300 text-red-700" : "text-muted-foreground")}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <Input placeholder="Note (optional) — e.g. step in the skirting left of the bed" value={markNote} onChange={(e) => setMarkNote(e.target.value)} />
                <p className="text-xs text-muted-foreground">Pick tags and add a note, then press Problem (or Good) to save.</p>
              </section>

              {detail.attempts && detail.attempts.length > 0 ? (
                detail.attempts.map((a) => (
                  <section key={a.attempt} className="space-y-2">
                    <h3 className="font-medium">Staging attempt {a.attempt}</h3>
                    <p className="text-sm text-muted-foreground">{a.outcome || "—"}</p>
                    {a.images.length ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {[...a.images].sort((x, y) => stepOrder(x.name) - stepOrder(y.name)).map((img) => (
                          <Thumb key={img.name} url={img.url} label={stepLabel(img.name)} onOpen={(url, label) => setZoom({ url, label })} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No work images were saved for this attempt.</p>
                    )}
                    {a.texts.length > 0 && (
                      <div className="flex flex-wrap gap-3 text-xs">
                        {a.texts.map((t) => t.url && (
                          <a key={t.name} href={t.url} target="_blank" rel="noreferrer" className="underline">
                            {t.name.includes("prompt") ? "Staging instructions" : t.name.includes("brief") ? "Room plan" : t.name}
                          </a>
                        ))}
                      </div>
                    )}
                  </section>
                ))
              ) : (
                detail.options.stage && <p className="text-sm text-muted-foreground">No staging steps were recorded for this job.</p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {zoom && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex flex-col items-center justify-center p-4" onClick={() => setZoom(null)}>
          <img src={zoom.url} alt={zoom.label} className="max-h-[85vh] max-w-full object-contain rounded" />
          <p className="mt-2 text-sm text-white">{zoom.label} — click anywhere to close</p>
        </div>
      )}
    </div>
  );
}
