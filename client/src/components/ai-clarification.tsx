import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Sparkles, AlertTriangle, Shield } from "lucide-react";

interface AIClarificationProps {
  professionId: string;
  onSubmit: (answers: Record<string, string>, prompt: string) => void;
  isProcessing?: boolean;
}

interface ClarificationQuestion {
  key: string;
  label: string;
  hint?: string;
  type: "text" | "select";
  options?: string[];
}

interface ClarificationResponse {
  done: boolean;
  missing: string[];
  questions: ClarificationQuestion[];
  notes?: string;
}

export function AIClarification({ professionId, onSubmit, isProcessing }: AIClarificationProps) {
  const [goal, setGoal] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [questions, setQuestions] = useState<ClarificationQuestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [currentStep, setCurrentStep] = useState<"goal" | "clarify" | "ready">("goal");
  const [hasConsent, setHasConsent] = useState(false);
  const [containsFaces, setContainsFaces] = useState<boolean | null>(null);
  const [safetyWarning, setSafetyWarning] = useState<string | null>(null);

  const handleGoalSubmit = async () => {
    if (!goal.trim()) return;
    
    // Safety check for minors and public figures
    const safetyCheck = checkSafetyViolations(goal);
    if (safetyCheck) {
      setSafetyWarning(safetyCheck);
      return;
    }
    
    setIsLoading(true);
    try {
      const context = {
        presetKey: professionId,
        hasFace: containsFaces,
        imageCategory: professionId
      };

      const response = await apiRequest("POST", "/api/clarify", {
        goal: goal.trim(),
        answers: {},
        context,
        consent: hasConsent
      });

      const result: ClarificationResponse = await response.json();
      
      if (result.done) {
        setIsDone(true);
        setCurrentStep("ready");
      } else {
        setQuestions(result.questions);
        setCurrentStep("clarify");
      }
    } catch (error) {
      console.error("Error getting clarification:", error);
      
      // Check for safety violations in the error response
      const safetyViolation = await parseApiError(error);
      if (safetyViolation) {
        setSafetyWarning(safetyViolation);
      } else {
        // Fallback to ready state if API fails for non-safety reasons
        setIsDone(true);
        setCurrentStep("ready");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleAnswerChange = (key: string, value: string) => {
    setAnswers(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleClarificationSubmit = async () => {
    // Safety check for any new answers that might contain problematic content
    const allText = goal + ' ' + Object.values(answers).join(' ');
    const safetyCheck = checkSafetyViolations(allText);
    if (safetyCheck) {
      setSafetyWarning(safetyCheck);
      return;
    }
    
    setIsLoading(true);
    try {
      const context = {
        presetKey: professionId,
        hasFace: containsFaces,
        imageCategory: professionId
      };

      const response = await apiRequest("POST", "/api/clarify", {
        goal,
        answers,
        context,
        consent: hasConsent
      });

      const result: ClarificationResponse = await response.json();
      
      if (result.done) {
        setIsDone(true);
        setCurrentStep("ready");
      } else {
        setQuestions(result.questions);
      }
    } catch (error) {
      console.error("Error getting clarification:", error);
      
      // Check for safety violations in the error response
      const safetyViolation = await parseApiError(error);
      if (safetyViolation) {
        setSafetyWarning(safetyViolation);
      } else {
        // Fallback to ready state if API fails for non-safety reasons
        setIsDone(true);
        setCurrentStep("ready");
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Detect faces or face-related content
  useEffect(() => {
    if (goal) {
      const faceKeywords = ['face', 'skin', 'headshot', 'portrait', 'person', 'people', 'selfie', 'linkedin', 'profile', 'beauty', 'makeup'];
      const hasFaceContent = faceKeywords.some(keyword => 
        goal.toLowerCase().includes(keyword) || 
        professionId.toLowerCase().includes(keyword)
      );
      setContainsFaces(hasFaceContent);
    }
  }, [goal, professionId]);

  // Clear safety warning when goal/answers change (if new content is safe)
  useEffect(() => {
    if (safetyWarning && (goal || Object.keys(answers).length > 0)) {
      const fullText = goal + ' ' + Object.values(answers).join(' ');
      const newSafetyCheck = checkSafetyViolations(fullText);
      if (!newSafetyCheck) {
        setSafetyWarning(null);
      }
    }
  }, [goal, answers, safetyWarning]);

  // Clear safety warning when consent is given (for consent-related warnings)
  useEffect(() => {
    if (safetyWarning && hasConsent && containsFaces && safetyWarning.includes('consent')) {
      setSafetyWarning(null);
    }
  }, [hasConsent, containsFaces, safetyWarning]);
  
  // Safety check function
  const checkSafetyViolations = (text: string): string | null => {
    const lowerText = text.toLowerCase();
    
    // Check for minors
    const minorKeywords = ['child', 'kid', 'baby', 'toddler', 'teenager', 'minor', 'school photo', 'yearbook'];
    if (minorKeywords.some(keyword => lowerText.includes(keyword))) {
      return "We cannot enhance photos of minors for safety reasons. Please use photos of adults only.";
    }
    
    // Check for public figures
    const publicFigureKeywords = ['celebrity', 'famous', 'politician', 'actor', 'actress', 'singer', 'influencer'];
    if (publicFigureKeywords.some(keyword => lowerText.includes(keyword))) {
      return "We cannot enhance photos of public figures or celebrities without explicit consent.";
    }
    
    return null;
  };

  // Helper function to parse API errors and extract safety violations
  const parseApiError = async (error: any): Promise<string | null> => {
    try {
      // Check if it's a Response object with status 400
      if (error?.status === 400 || (error?.response && error.response.status === 400)) {
        const response = error.response || error;
        let errorData;
        
        // Try to parse response body
        if (typeof response.json === 'function') {
          errorData = await response.json();
        } else if (response.data) {
          errorData = response.data;
        }
        
        // Check for safety violation error types
        if (errorData) {
          if (errorData.type === 'SAFETY_VIOLATION' || errorData.type === 'CONSENT_REQUIRED') {
            return errorData.message || errorData.error || "Safety violation detected.";
          }
          
          // Check for other error patterns
          if (errorData.message && (
            errorData.message.includes('safety') || 
            errorData.message.includes('consent') ||
            errorData.message.includes('violation') ||
            errorData.message.includes('minor') ||
            errorData.message.includes('celebrity')
          )) {
            return errorData.message;
          }
          
          if (errorData.error && typeof errorData.error === 'string') {
            return errorData.error;
          }
        }
      }
    } catch (parseError) {
      console.error("Error parsing API error response:", parseError);
    }
    
    return null; // No safety violation found, allow silent fallback
  };
  
  const [composedPrompt, setComposedPrompt] = useState<string | null>(null);
  
  const composePrompt = async () => {
    // Check face consent requirement
    if (containsFaces && !hasConsent) {
      setSafetyWarning("Please confirm consent before enhancing photos with faces.");
      return;
    }

    // Complete safety check for goal + answers
    const fullText = goal + ' ' + Object.values(answers).join(' ');
    const safetyCheck = checkSafetyViolations(fullText);
    if (safetyCheck) {
      setSafetyWarning(safetyCheck);
      return;
    }
    
    setIsLoading(true);
    try {
      // Use the compose API to create a professional enhancement prompt
      const context = {
        presetKey: professionId,
        imageCategory: professionId,
        hasFace: containsFaces
      };

      const response = await apiRequest("POST", "/api/compose", {
        goal,
        answers,
        context,
        consent: hasConsent
      });

      const result = await response.json();
      const finalPrompt = result.prompt || `Goal: ${goal}`;

      setComposedPrompt(finalPrompt);
      // Don't auto-submit, let user review the prompt
    } catch (error) {
      console.error("Error composing prompt:", error);
      
      // Check for safety violations in the error response
      const safetyViolation = await parseApiError(error);
      if (safetyViolation) {
        setSafetyWarning(safetyViolation);
      } else {
        // Fallback to basic prompt if API fails for non-safety reasons
        let fallbackPrompt = `Goal: ${goal}`;
        
        if (Object.keys(answers).length > 0) {
          fallbackPrompt += "\n\nSpecific requirements:";
          Object.entries(answers).forEach(([key, value]) => {
            fallbackPrompt += `\n- ${key}: ${value}`;
          });
        }

        setComposedPrompt(fallbackPrompt);
      }
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleFinalSubmit = () => {
    if (composedPrompt) {
      onSubmit(answers, composedPrompt);
    }
  };

  const canSubmitGoal = goal.trim().length > 0 && !safetyWarning;
  const canSubmitClarification = (questions.length === 0 || questions.every(q => 
    q.type === "select" ? answers[q.key] : (answers[q.key] || "").trim()
  )) && !safetyWarning;

  return (
    <section className="mb-12" data-testid="ai-clarification-section">
      <Card className="border border-border">
        <CardContent className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <Sparkles className="w-6 h-6 text-purple-500" />
            <h3 className="text-2xl font-semibold">AI-Powered Enhancement</h3>
          </div>
          
          {currentStep === "goal" && (
            <div className="space-y-6">
              <p className="text-muted-foreground">
                Describe what you want to achieve with your photos. Our AI will ask follow-up questions to create the perfect enhancement plan.
              </p>
              
              <div className="space-y-2">
                <Label htmlFor="goal" className="block text-sm font-medium">
                  What would you like to do with your photos? *
                </Label>
                <Textarea
                  id="goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="e.g., Make my restaurant food photos more appetizing for social media, enhance property photos for real estate listing, create professional headshots..."
                  className="resize-none h-32"
                  data-testid="textarea-goal"
                />
              </div>

              {safetyWarning && (
                <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                    <p className="text-sm font-medium text-red-800 dark:text-red-200">Safety Notice</p>
                  </div>
                  <p className="text-sm text-red-700 dark:text-red-300">{safetyWarning}</p>
                </div>
              )}

              {containsFaces && (
                <div className="bg-brand-light dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <Shield className="w-5 h-5 text-blue-600 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                        Face Enhancement Consent
                      </p>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="consent-checkbox"
                          checked={hasConsent}
                          onCheckedChange={(checked) => setHasConsent(Boolean(checked))}
                          data-testid="checkbox-face-consent"
                        />
                        <Label 
                          htmlFor="consent-checkbox" 
                          className="text-sm text-blue-700 dark:text-blue-300 cursor-pointer"
                        >
                          I have consent from the person(s) in the photo to enhance their image
                        </Label>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="flex justify-end">
                <Button 
                  type="button"
                  onClick={handleGoalSubmit}
                  disabled={!canSubmitGoal || isLoading}
                  className="bg-gradient-to-r from-brand-primary to-brand-accent hover:from-purple-600 hover:to-purple-700 text-white shadow-lg shadow-purple-500/30 px-8 py-3"
                  data-testid="button-submit-goal"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Get AI Recommendations
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {currentStep === "clarify" && (
            <div className="space-y-6">
              <div className="bg-purple-50 dark:bg-purple-950/20 p-4 rounded-lg border border-purple-200 dark:border-purple-800">
                <p className="text-sm text-purple-800 dark:text-purple-200">
                  <strong>Your Goal:</strong> {goal}
                </p>
              </div>
              
              <p className="text-muted-foreground">
                Please provide some additional details to create the perfect enhancement:
              </p>

              {safetyWarning && (
                <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                    <p className="text-sm font-medium text-red-800 dark:text-red-200">Safety Notice</p>
                  </div>
                  <p className="text-sm text-red-700 dark:text-red-300">{safetyWarning}</p>
                </div>
              )}

              {containsFaces && (
                <div className="bg-brand-light dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <Shield className="w-5 h-5 text-blue-600 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                        Face Enhancement Consent
                      </p>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="consent-checkbox-clarify"
                          checked={hasConsent}
                          onCheckedChange={(checked) => setHasConsent(Boolean(checked))}
                          data-testid="checkbox-face-consent-clarify"
                        />
                        <Label 
                          htmlFor="consent-checkbox-clarify" 
                          className="text-sm text-blue-700 dark:text-blue-300 cursor-pointer"
                        >
                          I have consent from the person(s) in the photo to enhance their image
                        </Label>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="space-y-6">
                {questions.map((question) => (
                  <div key={question.key} className="space-y-2">
                    <Label htmlFor={question.key} className="block text-sm font-medium">
                      {question.label}
                    </Label>
                    {question.hint && (
                      <p className="text-xs text-muted-foreground">{question.hint}</p>
                    )}
                    
                    {question.type === 'select' && question.options ? (
                      <Select 
                        value={answers[question.key] || ''} 
                        onValueChange={(value) => handleAnswerChange(question.key, value)}
                      >
                        <SelectTrigger data-testid={`select-${question.key}`}>
                          <SelectValue placeholder="Select an option..." />
                        </SelectTrigger>
                        <SelectContent>
                          {question.options.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={question.key}
                        value={answers[question.key] || ''}
                        onChange={(e) => handleAnswerChange(question.key, e.target.value)}
                        placeholder={question.hint || "Enter your answer..."}
                        data-testid={`input-${question.key}`}
                      />
                    )}
                  </div>
                ))}
              </div>
              
              <div className="flex justify-between">
                <Button 
                  type="button"
                  variant="outline"
                  onClick={() => setCurrentStep("goal")}
                  data-testid="button-back-to-goal"
                >
                  Back to Goal
                </Button>
                <Button 
                  type="button"
                  onClick={handleClarificationSubmit}
                  disabled={!canSubmitClarification || isLoading}
                  className="bg-gradient-to-r from-brand-primary to-brand-accent hover:from-purple-600 hover:to-purple-700 text-white shadow-lg shadow-purple-500/30 px-8 py-3"
                  data-testid="button-submit-clarification"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    "Continue"
                  )}
                </Button>
              </div>
            </div>
          )}

          {currentStep === "ready" && (
            <div className="space-y-6">
              <div className="bg-brand-accent dark:bg-brand-accent/20 p-4 rounded-lg border border-green-200 dark:border-green-800">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-green-600" />
                  <p className="text-sm font-medium text-green-800 dark:text-green-200">
                    AI Enhancement Plan Ready!
                  </p>
                </div>
                <p className="text-sm text-green-800 dark:text-green-200">
                  <strong>Goal:</strong> {goal}
                </p>
                {Object.keys(answers).length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-green-700 dark:text-green-300 font-medium">Requirements:</p>
                    <ul className="text-xs text-green-700 dark:text-green-300 mt-1">
                      {Object.entries(answers).map(([key, value]) => (
                        <li key={key}>• {key}: {value}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {safetyWarning && (
                <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                    <p className="text-sm font-medium text-red-800 dark:text-red-200">Safety Notice</p>
                  </div>
                  <p className="text-sm text-red-700 dark:text-red-300">{safetyWarning}</p>
                </div>
              )}

              {containsFaces && (
                <div className="bg-brand-light dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <Shield className="w-5 h-5 text-blue-600 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                        Face Enhancement Consent
                      </p>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="consent-checkbox-ready"
                          checked={hasConsent}
                          onCheckedChange={(checked) => setHasConsent(Boolean(checked))}
                          data-testid="checkbox-face-consent-ready"
                        />
                        <Label 
                          htmlFor="consent-checkbox-ready" 
                          className="text-sm text-blue-700 dark:text-blue-300 cursor-pointer"
                        >
                          I have consent from the person(s) in the photo to enhance their image
                        </Label>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {composedPrompt && (
                <div className="bg-brand-accent dark:bg-brand-accent/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Sparkles className="w-4 h-4 text-green-600" />
                    <p className="text-sm font-medium text-green-800 dark:text-green-200">
                      Final Enhancement Instructions
                    </p>
                  </div>
                  <div className="bg-background border rounded p-3">
                    <pre className="text-sm text-foreground whitespace-pre-wrap font-mono">
                      {composedPrompt}
                    </pre>
                  </div>
                  <p className="text-xs text-green-700 dark:text-green-300 mt-2">
                    Review the instructions above. When you're ready, click "Enhance My Photos" to proceed.
                  </p>
                </div>
              )}
              
              {!composedPrompt && (
                <p className="text-muted-foreground">
                  Your enhancement plan is ready! Click "Generate Enhancement Plan" to create the final instructions.
                </p>
              )}
              
              <div className="flex justify-between">
                <Button 
                  variant="outline"
                  onClick={() => {
                    setCurrentStep("goal");
                    setAnswers({});
                    setQuestions([]);
                    setIsDone(false);
                    setComposedPrompt(null);
                    setSafetyWarning(null);
                    setHasConsent(false);
                    setContainsFaces(null);
                  }}
                  data-testid="button-start-over"
                >
                  Start Over
                </Button>
                
                {!composedPrompt ? (
                  <Button 
                    onClick={composePrompt}
                    disabled={isLoading || safetyWarning !== null}
                    className="bg-gradient-to-r from-brand-primary to-brand-accent hover:from-purple-600 hover:to-purple-700 text-white shadow-lg shadow-purple-500/30 px-8 py-3"
                    data-testid="button-generate-prompt"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Generating Plan...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 mr-2" />
                        Generate Enhancement Plan
                      </>
                    )}
                  </Button>
                ) : (
                  <Button 
                    onClick={handleFinalSubmit}
                    disabled={isProcessing || (containsFaces && !hasConsent) || safetyWarning !== null}
                    className="bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white shadow-lg shadow-green-500/30 px-8 py-3"
                    data-testid="button-enhance-photos"
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Enhancing...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M7.5 5.6L10 7 8.6 4.5 10 2 7.5 3.4 5 2l1.4 2.5L5 7zm12 9.8L17 14l1.4 2.5L17 19l2.5-1.4L22 19l-1.4-2.5L22 14zM22 2l-2.5 1.4L17 2l1.4 2.5L17 7l2.5-1.4L22 7l-1.4-2.5zm-7.63 5.29c-.39-.39-1.02-.39-1.41 0L1.29 18.96c-.39.39-.39 1.02 0 1.41l2.34 2.34c.39.39 1.02.39 1.41 0L16.7 11.05c.39-.39.39-1.02 0-1.41l-2.33-2.35z"/>
                        </svg>
                        Enhance My Photos
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}