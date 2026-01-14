interface StepperProps {
  currentStep: number;
  steps: string[];
}

export function Stepper({ currentStep, steps }: StepperProps) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-center space-x-4">
        {steps.map((step, index) => (
          <div key={index} className="flex items-center">
            <div className="flex items-center space-x-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                index + 1 <= currentStep 
                  ? 'bg-action-600 text-white' 
                  : 'bg-muted text-muted-foreground'
              }`}>
                {index + 1}
              </div>
              <span className={`text-sm font-medium ${
                index + 1 <= currentStep 
                  ? 'text-foreground' 
                  : 'text-muted-foreground'
              }`}>
                {step}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div className={`ml-4 w-8 h-0.5 ${
                index + 1 < currentStep 
                  ? 'bg-action-600' 
                  : 'bg-muted'
              }`} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}