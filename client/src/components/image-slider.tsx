import { useState, useRef, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface ImageSliderProps {
  originalImage: string;
  image: string;
  onDownload: () => void;
  onEnhanceAnother: () => void;
}

export function ImageSlider({ originalImage, image, onDownload, onEnhanceAnother }: ImageSliderProps) {
  const [sliderPosition, setSliderPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    e.preventDefault();
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const percentage = (x / rect.width) * 100;
    setSliderPosition(percentage);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging]);

  return (
    <section className="mb-12" data-testid="image-slider-section">
      <h3 className="text-2xl font-semibold mb-6 text-center">
        Your Enhanced Photo
        <span className="ml-2">✨</span>
      </h3>
      
      <div className="max-w-4xl mx-auto">
        <Card className="overflow-hidden relative" style={{ height: '500px' }} data-testid="slider-container">
          <div ref={containerRef} className="relative w-full h-full">
            {/* Original Image */}
            <img 
              src={originalImage}
              alt="Original"
              className="absolute inset-0 w-full h-full object-cover"
              style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
              data-testid="image-original"
            />
            
            {/* Enhanced Image */}
            <img 
              src={image}
              alt="Enhanced"
              className="absolute inset-0 w-full h-full object-cover"
              style={{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }}
              data-testid="image-enhanced"
            />
            
            {/* Slider Handle */}
            <div 
              className="absolute top-0 bottom-0 w-1 bg-gradient-to-b from-brand-primary to-brand-accent cursor-ew-resize z-10"
              style={{ left: `${sliderPosition}%` }}
              onMouseDown={handleMouseDown}
              data-testid="slider-handle"
            >
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center border-2 border-purple-500">
                <svg className="w-4 h-4 text-purple-500" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18 9v6h-2V9h2zm-8 0v6H8V9h2z"/>
                </svg>
              </div>
            </div>
            
            {/* Labels */}
            <div className="absolute top-4 left-4 bg-black/70 text-white px-3 py-1 rounded-lg text-sm font-medium">
              Before
            </div>
            <div className="absolute top-4 right-4 bg-gradient-to-r from-brand-primary to-brand-accent text-white px-3 py-1 rounded-lg text-sm font-medium">
              After ✨
            </div>
          </div>
        </Card>
        
        <div className="flex justify-center mt-6 space-x-4">
          <Button 
            type="button"
            onClick={onDownload}
            variant="secondary"
            data-testid="button-download-enhanced"
          >
            <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
            Download Enhanced
          </Button>
          <Button 
            type="button"
            onClick={onEnhanceAnother}
            variant="outline"
            data-testid="button-enhance-another"
          >
            <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
            Enhance Another
          </Button>
        </div>
      </div>
    </section>
  );
}
