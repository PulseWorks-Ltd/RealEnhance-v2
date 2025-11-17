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
      <span key="scene" className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
        {scene.replace(/_/g,' ')}
      </span>
    );
  }
  if (room) {
    parts.push(
      <span key="room" className="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">
        Room: {room.replace(/_/g,' ')}
      </span>
    );
  }
  if (stagingAllowed === false) {
    parts.push(<span key="staging-block" className="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">Staging blocked</span>);
  } else if (stagingAllowed) {
    parts.push(<span key="staging-ok" className="bg-green-100 text-green-700 px-2 py-0.5 rounded">Staging OK</span>);
  }
  if (!parts.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? 'text-[10px]' : 'text-xs'} mt-2`}>
      {parts}
      {onOverrideRoom && (
        <button
          type="button"
          onClick={onOverrideRoom}
          className="underline text-blue-600 hover:text-blue-700"
        >Override room</button>
      )}
    </div>
  );
}
