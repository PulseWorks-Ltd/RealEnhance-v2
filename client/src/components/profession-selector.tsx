import { Card, CardContent } from "@/components/ui/card";
import { professionPresets } from "@/lib/presets";

interface ProfessionSelectorProps {
  selectedProfession: string | null;
  onProfessionSelect: (professionId: string) => void;
}

export function ProfessionSelector({ selectedProfession, onProfessionSelect }: ProfessionSelectorProps) {
  return (
    <div className="space-y-6" data-testid="profession-selector">
      <h3 className="text-2xl font-semibold mb-4">Choose Your Profession</h3>
      
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {professionPresets.map((profession) => (
          <Card 
            key={profession.id}
            className={`cursor-pointer transition-all duration-200 hover:shadow-lg ${
              selectedProfession === profession.id 
                ? 'border-primary bg-primary/10 shadow-lg shadow-primary/20' 
                : 'border-border hover:border-primary/50'
            }`}
            onClick={() => onProfessionSelect(profession.id)}
            data-testid={`profession-card-${profession.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-center space-x-3">
                <div className="text-purple-500">
                  <i className={profession.icon}></i>
                </div>
                <span className="font-medium text-sm">{profession.name}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
