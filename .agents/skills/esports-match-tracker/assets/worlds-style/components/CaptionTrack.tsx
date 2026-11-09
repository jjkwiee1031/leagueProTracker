import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

export interface SubtitleItem {
  start: number; // in frames
  end: number;   // in frames
  text: string;
  /** Narration segment this cue belongs to (drives card timing). */
  kind?: 'intro' | 'match' | 'recap' | 'outro';
  matchIndex?: number;
}

export const CaptionTrack: React.FC<{
  subtitles: SubtitleItem[];
}> = ({ subtitles }) => {
  const frame = useCurrentFrame();

  const current = subtitles.find(s => frame >= s.start && frame <= s.end);
  if (!current) return null;

  const opacity = interpolate(frame, [current.start, current.start + 5], [0, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 120,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 40px',
        pointerEvents: 'none',
        opacity,
      }}
    >
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.75)',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          padding: '12px 28px',
          borderRadius: 16,
          color: '#ffffff',
          fontSize: 32,
          fontWeight: 700,
          textAlign: 'center',
          lineHeight: 1.3,
          boxShadow: '0 10px 25px rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(8px)',
        }}
      >
        {current.text}
      </div>
    </div>
  );
};
