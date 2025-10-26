import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getPresetById, composePrompt } from "@/lib/presets";

interface QuestionnaireProps {
  professionId: string;
  onSubmit: (answers: Record<string, string>, prompt: string) => void;
  isProcessing?: boolean;
}

export function Questionnaire({ professionId, onSubmit, isProcessing }: QuestionnaireProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  
  const preset = getPresetById(professionId);
  
  if (!preset) {
    return null;
  }

  const handleAnswerChange = (questionId: string, value: string) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: value
    }));
  };

  const handleSubmit = () => {
    const prompt = composePrompt(preset, answers);
    onSubmit(answers, prompt);
  };

  const isFormValid = preset.questions
    .filter(q => q.required)
    .every(q => answers[q.id] && answers[q.id].trim());

  return (
    <section className="mb-12" data-testid="questionnaire-section">
      <Card className="border border-border">
        <CardContent className="p-6">
          <h3 className="text-2xl font-semibold mb-6">Tell us about your photo needs</h3>
          <p className="text-muted-foreground mb-6">{preset.description}</p>
          
          <div className="space-y-6">
            <div className="grid md:grid-cols-2 gap-6">
              {preset.questions.map((question) => (
                <div key={question.id} className="space-y-2">
                  <Label htmlFor={question.id} className="block text-sm font-medium">
                    {question.label}
                    {question.required && <span className="text-red-500 ml-1">*</span>}
                  </Label>
                  
                  {question.type === 'select' ? (
                    <Select 
                      value={answers[question.id] || ''} 
                      onValueChange={(value) => handleAnswerChange(question.id, value)}
                    >
                      <SelectTrigger data-testid={`select-${question.id}`}>
                        <SelectValue placeholder="Select an option..." />
                      </SelectTrigger>
                      <SelectContent>
                        {question.options?.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Textarea
                      id={question.id}
                      value={answers[question.id] || ''}
                      onChange={(e) => handleAnswerChange(question.id, e.target.value)}
                      placeholder={question.placeholder}
                      className="resize-none h-24"
                      data-testid={`textarea-${question.id}`}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
          
          <div className="flex justify-end mt-8">
            <Button 
              type="button"
              onClick={handleSubmit}
              disabled={!isFormValid || isProcessing}
              className="bg-gradient-to-r from-brand-primary to-brand-accent hover:from-purple-600 hover:to-purple-700 text-white shadow-lg shadow-purple-500/30 px-8 py-3"
              data-testid="button-enhance-photos"
            >
              <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
                <path d="M7.5 5.6L10 7 8.6 4.5 10 2 7.5 3.4 5 2l1.4 2.5L5 7zm12 9.8L17 14l1.4 2.5L17 19l2.5-1.4L22 19l-1.4-2.5L22 14zM22 2l-2.5 1.4L17 2l1.4 2.5L17 7l2.5-1.4L22 7l-1.4-2.5zm-7.63 5.29c-.39-.39-1.02-.39-1.41 0L1.29 18.96c-.39.39-.39 1.02 0 1.41l2.34 2.34c.39.39 1.02.39 1.41 0L16.7 11.05c.39-.39.39-1.02 0-1.41l-2.33-2.35z"/>
              </svg>
              {isProcessing ? 'Enhancing...' : 'Enhance My Photos'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
