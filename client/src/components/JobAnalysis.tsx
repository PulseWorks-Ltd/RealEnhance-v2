// client/src/components/JobAnalysis.tsx
// Admin UI for viewing job failure analysis

import React, { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RefreshCw, AlertCircle, CheckCircle, XCircle } from "lucide-react";

interface AnalysisOutput {
  job_summary: {
    stages_run: string[];
    final_outcome: string;
  };
  primary_issue: string;
  supporting_evidence: string[];
  assessment: {
    classification: string;
    confidence: string;
    notes: string;
  };
  recommended_actions: {
    prompt_changes: string[];
    validator_adjustments: string[];
    pipeline_logic_changes: string[];
    model_changes: string[];
  };
  do_not_recommend: string[];
}

interface JobAnalysis {
  id: string;
  jobId: string;
  status: "PENDING" | "COMPLETE" | "FAILED";
  trigger: "AUTO_ON_FAIL" | "MANUAL";
  model: string;
  createdAt: string;
  completedAt?: string;
  promptVersion: string;
  output?: AnalysisOutput;
  error?: string;
}

interface JobAnalysisProps {
  jobId: string;
}

export function JobAnalysisPanel({ jobId }: JobAnalysisProps) {
  const [analysis, setAnalysis] = useState<JobAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const { toast } = useToast();

  const loadAnalysis = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/admin/jobs/${jobId}/analysis/latest`, {
        credentials: "include",
      });

      if (response.status === 404) {
        setAnalysis(null);
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to load analysis");
      }

      const data = await response.json();
      setAnalysis(data.analysis);
    } catch (error) {
      console.error("Error loading analysis:", error);
      toast({
        title: "Error",
        description: "Failed to load analysis",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const runAnalysis = async () => {
    try {
      setRunning(true);
      const response = await fetch(`/api/admin/jobs/${jobId}/analysis/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to run analysis");
      }

      const data = await response.json();
      setAnalysis(data.analysis);

      toast({
        title: "Success",
        description: "Analysis completed successfully",
      });

      // Reload after a delay to get final status
      if (data.analysis.status === "PENDING") {
        setTimeout(loadAnalysis, 2000);
      }
    } catch (error: any) {
      console.error("Error running analysis:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to run analysis",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    loadAnalysis();
  }, [jobId]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>AI Failure Analysis</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading analysis...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!analysis) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>AI Failure Analysis</CardTitle>
          <CardDescription>No analysis available for this job</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={runAnalysis} disabled={running}>
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Running Analysis...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Run Analysis
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const getStatusBadge = () => {
    switch (analysis.status) {
      case "COMPLETE":
        return <Badge className="bg-green-500"><CheckCircle className="mr-1 h-3 w-3" /> Complete</Badge>;
      case "FAILED":
        return <Badge variant="destructive"><XCircle className="mr-1 h-3 w-3" /> Failed</Badge>;
      case "PENDING":
        return <Badge variant="secondary"><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Pending</Badge>;
    }
  };

  const getClassificationColor = (classification: string) => {
    switch (classification) {
      case "REAL_IMAGE_ISSUE":
        return "bg-orange-500";
      case "SYSTEM_ISSUE":
        return "bg-red-500";
      case "MIXED":
        return "bg-yellow-500";
      default:
        return "bg-gray-500";
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>AI Failure Analysis</CardTitle>
            <CardDescription>
              Generated {new Date(analysis.createdAt).toLocaleString()}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {getStatusBadge()}
            <Button
              size="sm"
              variant="outline"
              onClick={runAnalysis}
              disabled={running || analysis.status === "PENDING"}
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {analysis.status === "FAILED" && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Analysis failed: {analysis.error || "Unknown error"}
            </AlertDescription>
          </Alert>
        )}

        {analysis.status === "COMPLETE" && analysis.output && (
          <>
            {/* Job Summary */}
            <div>
              <h3 className="font-semibold mb-2">Job Summary</h3>
              <div className="flex items-center gap-2">
                <Badge variant="outline">
                  Stages: {analysis.output.job_summary.stages_run.join(", ")}
                </Badge>
                <Badge variant="outline">
                  Outcome: {analysis.output.job_summary.final_outcome}
                </Badge>
              </div>
            </div>

            {/* Primary Issue */}
            <div>
              <h3 className="font-semibold mb-2">Primary Issue</h3>
              <Alert>
                <AlertDescription>{analysis.output.primary_issue}</AlertDescription>
              </Alert>
            </div>

            {/* Assessment */}
            <div>
              <h3 className="font-semibold mb-2">Assessment</h3>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge className={getClassificationColor(analysis.output.assessment.classification)}>
                    {analysis.output.assessment.classification.replace(/_/g, " ")}
                  </Badge>
                  <Badge variant="outline">
                    Confidence: {analysis.output.assessment.confidence}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {analysis.output.assessment.notes}
                </p>
              </div>
            </div>

            {/* Supporting Evidence */}
            {analysis.output.supporting_evidence.length > 0 && (
              <div>
                <h3 className="font-semibold mb-2">Supporting Evidence</h3>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  {analysis.output.supporting_evidence.map((evidence, i) => (
                    <li key={i}>{evidence}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recommended Actions */}
            <div>
              <h3 className="font-semibold mb-2">Recommended Actions</h3>
              <div className="space-y-3">
                {analysis.output.recommended_actions.prompt_changes.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Prompt Changes:</h4>
                    <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                      {analysis.output.recommended_actions.prompt_changes.map((action, i) => (
                        <li key={i}>{action}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {analysis.output.recommended_actions.validator_adjustments.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Validator Adjustments:</h4>
                    <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                      {analysis.output.recommended_actions.validator_adjustments.map((action, i) => (
                        <li key={i}>{action}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {analysis.output.recommended_actions.pipeline_logic_changes.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Pipeline Logic Changes:</h4>
                    <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                      {analysis.output.recommended_actions.pipeline_logic_changes.map((action, i) => (
                        <li key={i}>{action}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {analysis.output.recommended_actions.model_changes.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Model Changes:</h4>
                    <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                      {analysis.output.recommended_actions.model_changes.map((action, i) => (
                        <li key={i}>{action}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            {/* Do Not Recommend */}
            {analysis.output.do_not_recommend.length > 0 && (
              <div>
                <h3 className="font-semibold mb-2">Do Not Recommend</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-red-600">
                  {analysis.output.do_not_recommend.map((action, i) => (
                    <li key={i}>{action}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Metadata */}
            <div className="pt-4 border-t text-xs text-muted-foreground space-y-1">
              <p>Model: {analysis.model}</p>
              <p>Prompt Version: {analysis.promptVersion}</p>
              <p>Trigger: {analysis.trigger}</p>
              {analysis.completedAt && (
                <p>Completed: {new Date(analysis.completedAt).toLocaleString()}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
