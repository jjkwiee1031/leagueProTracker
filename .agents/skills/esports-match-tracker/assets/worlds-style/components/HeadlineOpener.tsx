import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export const HeadlineOpener: React.FC<{
  title: string;
  subtitle: string;
}> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({
    frame,
    fps,
    config: { damping: 12 },
  });

  const subtitleOpacity = interpolate(frame, [15, 30], [0, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at center, #1e1b4b 0%, #030712 100%)',
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        style={{
          fontSize: 32,
          fontWeight: 700,
          color: '#38bdf8',
          letterSpacing: '4px',
          textTransform: 'uppercase',
          marginBottom: 16,
          opacity: subtitleOpacity,
        }}
      >
        WORLDS 2026 · SWISS STAGE
      </div>

      <div
        style={{
          transform: `scale(${titleScale})`,
          fontSize: 72,
          fontWeight: 900,
          textAlign: 'center',
          lineHeight: 1.1,
          padding: '0 40px',
          background: 'linear-gradient(135deg, #f8fafc 0%, #38bdf8 50%, #818cf8 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          filter: 'drop-shadow(0 0 35px rgba(56, 189, 248, 0.4))',
        }}
      >
        {title}
      </div>

      <div
        style={{
          marginTop: 24,
          padding: '8px 24px',
          borderRadius: 9999,
          border: '1px solid rgba(56, 189, 248, 0.3)',
          background: 'rgba(56, 189, 248, 0.1)',
          color: '#e2e8f0',
          fontSize: 28,
          fontWeight: 600,
          opacity: subtitleOpacity,
        }}
      >
        {subtitle}
      </div>
    </div>
  );
};
