import { CloudUpload } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button';

interface EmptyStateLaunchpadProps {
  onUploadClick: () => void;
  onSampleSelect?: (sampleType: 'interior' | 'exterior' | 'kitchen') => void;
}

export function EmptyStateLaunchpad({ onUploadClick, onSampleSelect }: EmptyStateLaunchpadProps) {
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
    onUploadClick();
  };

  const sampleImages = [
    { 
      type: 'interior' as const, 
      label: 'Interior', 
      gradient: 'from-blue-500 to-purple-600',
      icon: '🏠'
    },
    { 
      type: 'exterior' as const, 
      label: 'Exterior', 
      gradient: 'from-emerald-500 to-teal-600',
      icon: '🏡'
    },
    { 
      type: 'kitchen' as const, 
      label: 'Kitchen', 
      gradient: 'from-orange-500 to-pink-600',
      icon: '🍳'
    },
  ];

  return (
    <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-theme(spacing.16))] w-full overflow-hidden bg-slate-50">
      {/* Dot Pattern Background */}
      <div 
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage: `radial-gradient(circle, rgb(148 163 184) 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
        }}
      />

      {/* Content Container */}
      <div className="relative z-10 w-full max-w-4xl px-6 py-12 space-y-12">
        
        {/* Hero Dropzone Card */}
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`
            relative group cursor-pointer
            max-w-2xl mx-auto
            bg-white rounded-2xl shadow-xl
            border-2 border-dashed transition-all duration-300
            ${isDragOver 
              ? 'border-emerald-500 bg-emerald-50/50 scale-[1.02] shadow-2xl' 
              : 'border-slate-300 hover:border-blue-400 hover:shadow-2xl'
            }
          `}
          onClick={onUploadClick}
        >
          <div className="p-12 flex flex-col items-center text-center space-y-6">
            
            {/* Animated Icon */}
            <div className={`
              p-6 rounded-full bg-gradient-to-br from-blue-50 to-purple-50
              transition-all duration-300
              ${isDragOver ? 'scale-110 bg-gradient-to-br from-emerald-50 to-teal-50' : 'group-hover:scale-105'}
            `}>
              <CloudUpload 
                className={`
                  w-16 h-16 text-blue-500 transition-all duration-300
                  ${isDragOver ? 'text-emerald-600 animate-bounce' : 'group-hover:text-blue-600'}
                `}
              />
            </div>

            {/* Heading */}
            <div className="space-y-2">
              <h2 className="text-3xl font-bold text-slate-900">
                {isDragOver ? 'Drop to Upload' : 'Enhance Property Photos with AI Staging & Cleanup'}
              </h2>
              <p className="text-lg text-slate-600 max-w-md">
                {isDragOver 
                  ? 'Release to start enhancing your images' 
                  : 'Upload property photos to declutter, enhance, and stage them in seconds'
                }
              </p>
            </div>

            {/* Technical Details */}
            <div className="flex items-center gap-6 text-sm text-slate-500">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Up to 50 images</span>
              </div>
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>Max 15MB each</span>
              </div>
            </div>

            {/* Call to Action */}
            <Button
              size="lg"
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white px-8 py-6 text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-300"
              onClick={(e) => {
                e.stopPropagation();
                onUploadClick();
              }}
            >
              Choose Files
            </Button>
          </div>
        </div>

        {/* What Happens Next - Process Flow */}
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-center gap-3 text-sm">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-semibold text-xs">
                1
              </div>
              <span className="text-slate-700 font-medium">Upload</span>
            </div>
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-purple-100 text-purple-700 font-semibold text-xs">
                2
              </div>
              <span className="text-slate-700 font-medium">Choose Room Type</span>
            </div>
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 font-semibold text-xs">
                3
              </div>
              <span className="text-slate-700 font-medium">Get Staged Results</span>
            </div>
          </div>
        </div>

        {/* Sample Images Gallery */}
        <div className="space-y-6">
          <div className="text-center space-y-2">
            <h3 className="text-xl font-semibold text-slate-800">
              Try with Sample Images
            </h3>
            <p className="text-sm text-slate-600">
              See the transformation instantly with our demo photos
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto">
            {sampleImages.map((sample) => (
              <button
                key={sample.type}
                onClick={() => onSampleSelect?.(sample.type)}
                className="group relative overflow-hidden rounded-xl bg-white shadow-md hover:shadow-xl transition-all duration-300 hover:scale-105 border border-slate-200 cursor-pointer"
              >
                {/* Gradient Background */}
                <div className={`
                  absolute inset-0 bg-gradient-to-br ${sample.gradient} opacity-10 
                  group-hover:opacity-20 transition-opacity duration-300
                `} />
                
                {/* Content */}
                <div className="relative p-6 flex flex-col items-center space-y-3">
                  <div className="text-4xl">{sample.icon}</div>
                  <div>
                    <div className="font-semibold text-slate-900">{sample.label}</div>
                    <div className="text-xs text-slate-600 mt-1">Try a demo enhancement</div>
                  </div>
                  
                  {/* Hover Effect */}
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <div className={`
                      inline-flex items-center gap-1 text-xs font-medium 
                      bg-gradient-to-r ${sample.gradient} bg-clip-text text-transparent
                    `}>
                      Start demo
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Features Grid (Optional) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl mx-auto pt-8">
          <div className="flex items-start gap-3 p-4 rounded-lg bg-white/60 backdrop-blur-sm">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <div className="font-medium text-sm text-slate-900">Lightning Fast</div>
              <div className="text-xs text-slate-600">Process images in seconds</div>
            </div>
          </div>

          <div className="flex items-start gap-3 p-4 rounded-lg bg-white/60 backdrop-blur-sm">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <div className="font-medium text-sm text-slate-900">Studio Quality</div>
              <div className="text-xs text-slate-600">Professional results every time</div>
            </div>
          </div>

          <div className="flex items-start gap-3 p-4 rounded-lg bg-white/60 backdrop-blur-sm">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <div>
              <div className="font-medium text-sm text-slate-900">Secure & Private</div>
              <div className="text-xs text-slate-600">Your images stay confidential</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
