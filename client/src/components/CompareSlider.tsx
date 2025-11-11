import { useState, useRef, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";

export interface CompareSliderProps {
  originalImage: string;
  enhancedImage: string;
  initialPosition?: number;
  position?: number; // For controlled component
  onPositionChange?: (position: number) => void;
  height?: number | string;
  showLabels?: boolean;
  originalLabel?: string;
  enhancedLabel?: string;
  className?: string;
  "data-testid"?: string;
}

export function CompareSlider({
  originalImage,
  enhancedImage,
  initialPosition = 50,
  position,
  onPositionChange,
  height = 500,
  showLabels = true,
  originalLabel = "Original",
  enhancedLabel = "Enhanced",
  className,
  "data-testid": testId = "compare-slider"
}: CompareSliderProps) {
  const [internalPosition, setInternalPosition] = useState(initialPosition);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Use controlled position if provided, otherwise internal position
  const currentPosition = position !== undefined ? position : internalPosition;

  const updatePosition = useCallback((newPosition: number) => {
    const clampedPosition = Math.max(0, Math.min(100, newPosition));
    
    if (position === undefined) {
      setInternalPosition(clampedPosition);
    }
    
    onPositionChange?.(clampedPosition);
  }, [position, onPositionChange]);

  // Mouse events
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    e.preventDefault();
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const percentage = (x / rect.width) * 100;
    updatePosition(percentage);
  }, [isDragging, updatePosition]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Touch events for mobile support
  const handleTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true);
    e.preventDefault();
  };

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging || !containerRef.current || e.touches.length === 0) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.touches[0].clientX - rect.left));
    const percentage = (x / rect.width) * 100;
    updatePosition(percentage);
  }, [isDragging, updatePosition]);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Event listeners setup
  useEffect(() => {
    if (isDragging) {
      // Mouse events
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      
      // Touch events
      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleTouchEnd);
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  const containerStyle = {
    height: typeof height === 'number' ? `${height}px` : height
  };

  return (
    <Card 
      className={`overflow-hidden relative bg-gray-900 ${className || ''}`} 
      style={containerStyle}
      data-testid={testId}
    >
      <div ref={containerRef} className="relative w-full h-full">
        {/* Original Image */}
        <img 
          src={originalImage}
          alt="Original"
          className="absolute inset-0 w-full h-full object-contain"
          style={{ clipPath: `inset(0 ${100 - currentPosition}% 0 0)` }}
          data-testid={`${testId}-original-image`}
        />
        
        {/* Enhanced Image */}
        <img 
          src={enhancedImage}
          alt="Enhanced"
          className="absolute inset-0 w-full h-full object-contain"
          style={{ clipPath: `inset(0 0 0 ${currentPosition}%)` }}
          data-testid={`${testId}-enhanced-image`}
        />
        
        {/* Slider Handle */}
        <div 
          className="absolute top-0 bottom-0 w-1 bg-gradient-to-b from-brand-primary to-brand-accent cursor-ew-resize z-10 touch-none"
          style={{ left: `${currentPosition}%` }}
          onMouseDown={handleMouseDown}
          onTouchStart={handleTouchStart}
          data-testid={`${testId}-handle`}
        >
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center border-2 border-purple-500">
            <svg className="w-4 h-4 text-purple-500" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18 9v6h-2V9h2zm-8 0v6H8V9h2z"/>
            </svg>
          </div>
        </div>
        
                {/* Labels - Positioned near center for visibility */}
        {showLabels && (
          <>
            {/* Original label - left side, vertically centered */}
            <div 
              className="absolute left-6 top-1/2 -translate-y-1/2 bg-blue-600/95 text-white px-4 py-2 rounded-lg text-sm font-bold shadow-xl backdrop-blur-sm border-2 border-white/30"
              data-testid={`${testId}-original-label`}
            >
              {originalLabel}
            </div>
            {/* Enhanced label - right side, vertically centered */}
            <div 
              className="absolute right-6 top-1/2 -translate-y-1/2 bg-green-600/95 text-white px-4 py-2 rounded-lg text-sm font-bold shadow-xl backdrop-blur-sm border-2 border-white/30"
              data-testid={`${testId}-enhanced-label`}
            >
              {enhancedLabel}
            </div>
          </>
        )}
        
        {/* Instruction hint */}
        {currentPosition === initialPosition && !isDragging && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-black/80 text-white text-sm rounded-full animate-pulse backdrop-blur-sm shadow-lg">
            ← Drag to compare →
          </div>
        )}
      </div>
    </Card>
  );
}