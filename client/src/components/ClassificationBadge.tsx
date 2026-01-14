import React from 'react';

interface ClassificationBadgeProps {
  scene?: string | null;
  room?: string | null;
  stagingAllowed?: boolean | null;
  onOverrideRoom?: () => void;
  compact?: boolean;
}

export function ClassificationBadge({ scene, room, stagingAllowed, onOverrideRoom, compact }: ClassificationBadgeProps) {
  const parts: React.ReactNode[] = [];
  if (scene) {
    parts.push(
      <span key="scene" className="bg-status-info/10 text-status-info px-2 py-0.5 rounded text-xs font-medium">
        {scene.replace(/_/g,' ')}
      </span>
    );
  }
  if (room) {
    parts.push(
      <span key="room" className="bg-brand-500/10 text-brand-600 px-2 py-0.5 rounded text-xs font-medium">
        Room: {room.replace(/_/g,' ')}
      </span>
    );
  }
  if (stagingAllowed === false) {
    parts.push(<span key="staging-block" className="bg-status-warning/10 text-status-warning px-2 py-0.5 rounded text-xs font-medium">Staging blocked</span>);
  } else if (stagingAllowed) {
    parts.push(<span key="staging-ok" className="bg-status-success/10 text-status-success px-2 py-0.5 rounded text-xs font-medium">Staging OK</span>);
  }
  if (!parts.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? 'text-[10px]' : 'text-xs'} mt-2`}>
      {parts}
      {onOverrideRoom && (
        <button
          type="button"
          onClick={onOverrideRoom}
          className="underline text-action-600 hover:text-action-700"
        >Override room</button>
      )}
    </div>
  );
}
