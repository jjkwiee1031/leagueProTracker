import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { MatchData } from './MatchCard';

/**
 * Closing "day recap" card: shown once the narration's `recap` cue starts.
 * Lists every result of the day plus a few aggregate stats.
 */
export const RecapCard: React.FC<{ matches: MatchData[]; date: string }> = ({
  matches,
  date,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 16, mass: 0.9 } });

  const toSec = (d: string) => {
    const p = String(d || '').split(':').map((n) => parseInt(n, 10));
    if (p.length === 2 && p.every((n) => !isNaN(n))) return p[0] * 60 + p[1];
    if (p.length === 3 && p.every((n) => !isNaN(n))) return p[0] * 3600 + p[1] * 60 + p[2];
    return 0;
  };
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };

  const allGames = matches.flatMap((m) => (m.games || []).map((g) => g.duration));
  const longest = allGames.length
    ? fmt(Math.max(...allGames.map(toSec)))
    : '';
  const bo3 = matches.filter((m) => (m.bestOf || 1) > 1).length;
  const sweeps = matches.filter(
    (m) =>
      Math.max(Number(m.scoreA), Number(m.scoreB)) >= 2 &&
      Number(m.scoreA) !== Number(m.scoreB)
  ).length;

  const stats = [
    `${matches.length} 场对局`,
    `BO3 × ${bo3}`,
    `横扫 × ${sweeps}`,
    longest ? `最长一局 ${longest}` : '',
  ].filter(Boolean);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 0%, #0f172a 0%, #030712 70%)',
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '0 60px',
        transform: `scale(${enter})`,
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 800, color: '#38bdf8', letterSpacing: 6 }}>
        DAY RECAP · {date}
      </div>
      <div
        style={{
          fontSize: 62,
          fontWeight: 900,
          marginTop: 8,
          marginBottom: 30,
          background: 'linear-gradient(135deg, #f8fafc 0%, #38bdf8 60%, #818cf8 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
      >
        今日战报
      </div>

      <div style={{ width: '100%', maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {matches.map((m, i) => {
          const winA = parseInt(m.scoreA) > parseInt(m.scoreB);
          const winner = winA ? m.teamA : m.teamB;
          const loser = winA ? m.teamB : m.teamA;
          const hi = winA ? m.scoreA : m.scoreB;
          const lo = winA ? m.scoreB : m.scoreA;
          const rowIn = spring({
            frame: frame - (8 + i * 5),
            fps,
            config: { damping: 18, mass: 0.7 },
          });
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 14,
                padding: '12px 20px',
                borderRadius: 12,
                background: 'rgba(15, 23, 42, 0.75)',
                border: '1px solid rgba(148, 163, 184, 0.15)',
                opacity: rowIn,
                transform: `translateX(${(1 - rowIn) * 40}px)`,
              }}
            >
              <span style={{ flex: 1, fontSize: 34, fontWeight: 900, color: '#38bdf8' }}>
                {winner}
              </span>
              <span style={{ fontSize: 30, fontWeight: 900, letterSpacing: 4, color: '#f8fafc' }}>
                {hi}:{lo}
              </span>
              <span style={{ flex: 1, fontSize: 34, fontWeight: 900, color: '#94a3b8', textAlign: 'right' }}>
                {loser}
              </span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 12,
          marginTop: 30,
        }}
      >
        {stats.map((s, i) => (
          <span
            key={i}
            style={{
              padding: '6px 16px',
              borderRadius: 9999,
              border: '1px solid rgba(56, 189, 248, 0.3)',
              background: 'rgba(56, 189, 248, 0.1)',
              color: '#e2e8f0',
              fontSize: 20,
              fontWeight: 700,
            }}
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
};