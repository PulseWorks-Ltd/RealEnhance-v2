// client/src/components/features/UploadZone.tsx
import { UploadCloud } from 'lucide-react';
import React from 'react';

interface UploadZoneProps {
  onDrop?: () => void; // Placeholder for logic
  onClick?: () => void;
}

export const UploadZone = ({ onDrop, onClick }: UploadZoneProps) => (
  <div 
    onClick={onClick}
    className="border-2 border-dashed border-slate-300 rounded-lg p-12 text-center hover:bg-slate-50 hover:border-brand-400 transition-colors cursor-pointer group"
  >
    <div className="w-12 h-12 bg-brand-50 text-brand-600 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
      <UploadCloud size={24} />
    </div>
    <h3 className="text-lg font-medium text-slate-900">Upload property photos</h3>
    <p className="text-slate-500 mt-1 mb-4">Drag and drop or click to browse</p>
    <p className="text-xs text-slate-400">Supports JPG, PNG up to 25MB</p>
  </div>
);
