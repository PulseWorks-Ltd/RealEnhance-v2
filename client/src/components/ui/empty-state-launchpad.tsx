import { CloudUpload, ShieldCheck, Timer, Layers, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button';

interface EmptyStateLaunchpadProps {
  onFileSelect: () => void;
  onFileDrop: (files: File[]) => void;
  onSampleSelect?: (sampleType: 'interior' | 'exterior' | 'kitchen') => void;
}

export function EmptyStateLaunchpad({ onFileSelect, onFileDrop }: EmptyStateLaunchpadProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    // Extract files from drop event and pass to parent handler
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      onFileDrop(droppedFiles);
    }
  };

  return (
    <div className="relative w-full min-h-screen overflow-hidden bg-white px-8 py-6">
      {/* Dot Pattern Background */}
      <div 
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage: `radial-gradient(circle, rgb(148 163 184) 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
        }}
      />

      {/* Content Container */}
      <div className="relative z-10 w-full px-6 py-12 space-y-12">
        
        {/* Hero Dropzone Card */}
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`
            relative group cursor-pointer
            max-w-3xl mx-auto
            bg-white rounded-3xl shadow-2xl
            border-2 border-dashed transition-all duration-300
            ${isDragOver 
              ? 'border-blue-500 bg-blue-50/30 scale-[1.02] shadow-2xl' 
              : 'border-slate-300 hover:border-blue-400 hover:shadow-2xl hover:scale-[1.01]'
            }
          `}
          onClick={onFileSelect}
        >
          <div className="p-12 flex flex-col items-center text-center space-y-6">
            
            {/* Animated Icon */}
            <div className={`
              p-6 rounded-full bg-gradient-to-br from-blue-50 to-purple-50
              transition-all duration-300
              ${isDragOver ? 'scale-110 bg-gradient-to-br from-blue-50 to-blue-100 animate-pulse' : 'group-hover:scale-105'}
            `}>
              <CloudUpload 
                className={`
                  w-16 h-16 text-blue-500 transition-all duration-300
                  ${isDragOver ? 'text-blue-600 animate-bounce' : 'group-hover:text-blue-600'}
                `}
              />
            </div>

            {/* Heading with Structure-Preserving Badge */}
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2">
                <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">
                  {isDragOver ? 'Drop to Upload' : 'Prepare Your Next Listing'}
                </h1>
                {!isDragOver && (
                  <div className="group/badge relative">
                    <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide">Structure-Safe</span>
                    </div>
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover/badge:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap shadow-xl z-10">
                      <div className="font-medium mb-0.5">Professional Structural Cleanup</div>
                      <div className="text-slate-300">Floor plans and walls stay intact</div>
                      <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                    </div>
                  </div>
                )}
              </div>
              <p className="text-base text-slate-600 max-w-lg">
                {isDragOver 
                  ? 'Release to start enhancing your images' 
                  : 'Professional staging and structural cleanup for entire photo batches. Market-ready results in 120 seconds'
                }
              </p>
            </div>

            {/* Call to Action */}
            <Button
              size="lg"
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white px-10 py-7 text-lg font-bold shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-[1.02]"
              onClick={(e) => {
                e.stopPropagation();
                onFileSelect();
              }}
            >
              Choose Files
            </Button>

            {/* Technical Details - Subtle at bottom */}
            <div className="flex items-center gap-4 text-xs text-slate-600 font-medium">
              <div className="flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Up to 50 images</span>
              </div>
              <span className="text-slate-400">•</span>
              <div className="flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>Max 15MB each</span>
              </div>
            </div>
          </div>
        </div>

        {/* What Happens Next - Process Flow with Stronger Active States */}
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-4 items-start gap-3 sm:gap-6 text-sm text-center">
            <div className="flex flex-col items-center gap-2 min-w-0">
              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-white font-bold text-sm shadow-lg ring-2 ring-blue-200">
                1
              </div>
              <span className="text-slate-800 font-semibold leading-tight">Gallery Upload</span>
            </div>
            <div className="flex flex-col items-center gap-2 min-w-0">
              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-purple-600 text-white font-bold text-sm shadow-lg ring-2 ring-purple-200">
                2
              </div>
              <span className="text-slate-800 font-semibold leading-tight">Studio Settings</span>
            </div>
            <div className="flex flex-col items-center gap-2 min-w-0">
              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-teal-600 to-sky-700 text-white font-bold text-sm shadow-lg ring-2 ring-teal-200">
                3
              </div>
              <span className="text-sky-800 font-semibold inline-flex items-center gap-1.5 leading-tight">
                <ShieldCheck className="w-4 h-4" />
                Quality Assurance
              </span>
            </div>
            <div className="flex flex-col items-center gap-2 min-w-0">
              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 text-white font-bold text-sm shadow-lg ring-2 ring-emerald-200">
                4
              </div>
              <span className="text-slate-800 font-semibold leading-tight">Market Ready</span>
            </div>
          </div>
        </div>

        {/* Features Grid (Optional) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl mx-auto pt-6 border-t border-border/40">
          <div className="flex items-start gap-3 p-4 rounded-lg bg-white/60 backdrop-blur-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-lg">
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
              <Timer className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <div className="font-medium text-sm text-slate-900">2-Minute Turnaround</div>
              <div className="text-xs text-slate-600">Go from upload to download in less time than it takes to brew a coffee</div>
            </div>
          </div>

          <div className="flex items-start gap-3 p-4 rounded-lg bg-white/60 backdrop-blur-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-lg">
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
              <Layers className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <div className="font-medium text-sm text-slate-900">Batch Excellence</div>
              <div className="text-xs text-slate-600">Consistent, pro-grade staging applied across your entire gallery simultaneously</div>
            </div>
          </div>

          <div className="flex items-start gap-3 p-4 rounded-lg bg-white/60 backdrop-blur-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-lg">
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-emerald-600" />
            </div>
            <div>
              <div className="font-medium text-sm text-slate-900">Effortless Operation</div>
              <div className="text-xs text-slate-600">One-click processing. No complex editing skills or manual tweaking required</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
