interface ModeToggleProps {
  mode: 'smart' | 'ai';
  onModeChange: (mode: 'smart' | 'ai') => void;
}

export function ModeToggle({ mode, onModeChange }: ModeToggleProps) {
  return (
    <div className="flex items-center space-x-1 bg-muted p-1 rounded-lg">
      <button
        type="button"
        onClick={() => onModeChange('smart')}
        className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
          mode === 'smart'
            ? 'bg-background text-foreground shadow-sm' 
            : 'text-muted-foreground hover:text-foreground'
        }`}
        data-testid="button-mode-smart"
      >
        ⚡ Smart
      </button>
      <button
        type="button"
        onClick={() => onModeChange('ai')}
        className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
          mode === 'ai'
            ? 'bg-background text-foreground shadow-sm' 
            : 'text-muted-foreground hover:text-foreground'
        }`}
        data-testid="button-mode-ai"
      >
        🤖 AI-Powered
      </button>
    </div>
  );
}