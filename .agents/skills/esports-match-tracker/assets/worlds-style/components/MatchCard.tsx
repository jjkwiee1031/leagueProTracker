import React from 'react';
import { Img, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

export interface MatchGame {
  game: number;
  duration: string;
  winner?: string | null;
  screenshot?: string;
  champions?: string[];
  kdaStats?: string[];
  teamA?: { champions: string[]; kdaStats: string[] };
  teamB?: { champions: string[]; kdaStats: string[] };
}

export interface MatchData {
  round: string;
  /** Calendar date of the match, e.g. "2026-10-24" (from the scraper). */
  date?: string;
  teamA: string;
  scoreA: string;
  teamB: string;
  scoreB: string;
  winner: string;
  duration: string;
  /** Games in the series (Bo1 = 1, Bo3 = 2-3), with per-game detail. */
  games?: MatchGame[];
  /** Series format from the round label, e.g. 3 for "(Bo3)". */
  bestOf?: number;
  /** Per-game lengths, e.g. ["35:45", "26:32", "31:57"]. */
  gameDurations?: string[];
  champions?: string[];
  kdaStats?: string[];
  /** Optional player-performance popup screenshot (path under remotion/public). */
  screenshot?: string;
}

export const MatchCard: React.FC<{
  match: MatchData;
  index: number;
  total: number;
}> = ({ match, index, total }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const cardScale = spring({
    frame,
    fps,
    config: { damping: 14, mass: 0.8 },
  });

  const isWinA = parseInt(match.scoreA) > parseInt(match.scoreB);
  const isWinB = parseInt(match.scoreB) > parseInt(match.scoreA);

  // Cycle through each played game's performance shot across the card's span
  // (Bo1 -> single shot; Bo3 -> one per game, split evenly).
  const shotGames = (match.games || []).filter((g) => g && g.screenshot);
  const shotCount = shotGames.length || (match.screenshot ? 1 : 0);
  const perShot = shotCount > 0 ? Math.max(1, Math.floor(durationInFrames / shotCount)) : durationInFrames;
  const shotIndex = shotCount > 1 ? Math.min(shotCount - 1, Math.floor(frame / perShot)) : 0;
  const activeGame = shotGames.length ? shotGames[shotIndex] : null;
  const shotSrc = activeGame ? activeGame.screenshot : match.screenshot;
  const gameLabel = activeGame ? activeGame.game : 1;
  const multiGame = shotCount > 1;

  // "Round 3 Low Matches (Bo3)" -> "Round 3 Low · BO3"
  const roundLabel = (match.round || '')
    .replace(/\s*Matches\b/i, '')
    .replace(/\s*\(Bo(\d)\)/i, ' · BO$1')
    .trim();

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(180deg, #090d16 0%, #030712 100%)',
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '0 50px',
      }}
    >
      {/* Top Badge */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <span
          style={{
            background: 'rgba(56, 189, 248, 0.15)',
            border: '1px solid rgba(56, 189, 248, 0.4)',
            color: '#38bdf8',
            padding: '6px 16px',
            borderRadius: 8,
            fontSize: 22,
            fontWeight: 800,
            letterSpacing: '1px',
          }}
        >
          {roundLabel}
        </span>
        <span style={{ color: '#94a3b8', fontSize: 20 }}>
          MATCH {index + 1} OF {total}
        </span>
      </div>

      {/* Main Score Card Container */}
      <div
        style={{
          transform: `scale(${cardScale})`,
          width: '100%',
          maxWidth: 960,
          background: 'rgba(15, 23, 42, 0.75)',
          border: '1px solid rgba(148, 163, 184, 0.15)',
          borderRadius: 24,
          padding: '28px 30px 30px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(20px)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Matchup Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 12px 22px',
          }}
        >
          {/* Team A */}
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div
              style={{
                fontSize: 54,
                fontWeight: 900,
                color: isWinA ? '#38bdf8' : '#94a3b8',
                textShadow: isWinA ? '0 0 25px rgba(56, 189, 248, 0.6)' : 'none',
              }}
            >
              {match.teamA}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 18,
                fontWeight: 700,
                color: isWinA ? '#4ade80' : '#ef4444',
                letterSpacing: 2,
              }}
            >
              {isWinA ? 'VICTORY' : 'DEFEAT'}
            </div>
          </div>

          {/* Score & Duration */}
          <div style={{ textAlign: 'center', padding: '0 12px' }}>
            <div
              style={{
                fontSize: 66,
                fontWeight: 900,
                letterSpacing: 6,
                color: '#f8fafc',
              }}
            >
              {match.scoreA} : {match.scoreB}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 22,
                fontWeight: 600,
                color: '#64748b',
              }}
            >
              ⏱ {match.duration}
            </div>
          </div>

          {/* Team B */}
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div
              style={{
                fontSize: 54,
                fontWeight: 900,
                color: isWinB ? '#38bdf8' : '#94a3b8',
                textShadow: isWinB ? '0 0 25px rgba(56, 189, 248, 0.6)' : 'none',
              }}
            >
              {match.teamB}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 18,
                fontWeight: 700,
                color: isWinB ? '#4ade80' : '#ef4444',
                letterSpacing: 2,
              }}
            >
              {isWinB ? 'VICTORY' : 'DEFEAT'}
            </div>
          </div>
        </div>

        {/* Series game breakdown (Bo3) */}
        {match.gameDurations && match.gameDurations.length > 1 && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              flexWrap: 'wrap',
              gap: 10,
              marginTop: 14,
            }}
          >
            {match.gameDurations.map((d, gi) => (
              <span
                key={gi}
                style={{
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  color: '#bae6fd',
                  padding: '3px 12px',
                  borderRadius: 6,
                  fontSize: 16,
                  fontWeight: 700,
                }}
              >
                G{gi + 1} {d}
              </span>
            ))}
          </div>
        )}

        {/* Player Performance Screenshot (or champion fallback) */}
        {shotSrc ? (
          <div style={{ marginTop: 18 }}>
            <div
              style={{
                fontSize: 18,
                color: '#94a3b8',
                marginBottom: 12,
                textAlign: 'center',
                letterSpacing: 1,
              }}
            >
              PLAYER PERFORMANCE{multiGame ? ` · GAME ${gameLabel}` : ''}
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <Img
                src={staticFile(shotSrc)}
                style={{
                  width: '100%',
                  maxWidth: 900,
                  borderRadius: 14,
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  boxShadow: '0 12px 35px rgba(0, 0, 0, 0.55)',
                }}
              />
            </div>
            {multiGame && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  gap: 8,
                  marginTop: 14,
                }}
              >
                {shotGames.map((g, gi) => (
                  <span
                    key={gi}
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 9999,
                      background: gi === shotIndex ? '#38bdf8' : 'rgba(148, 163, 184, 0.35)',
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          match.champions &&
          match.champions.length > 0 && (
            <div
              style={{
                marginTop: 20,
                paddingTop: 22,
                borderTop: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              <div
                style={{
                  fontSize: 18,
                  color: '#94a3b8',
                  marginBottom: 12,
                  textAlign: 'center',
                  letterSpacing: 1,
                }}
              >
                KEY CHAMPIONS
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  justifyContent: 'center',
                }}
              >
                {match.champions.map((champ, cIdx) => (
                  <span
                    key={cIdx}
                    style={{
                      background: 'rgba(30, 41, 59, 0.8)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      padding: '4px 14px',
                      borderRadius: 6,
                      fontSize: 18,
                      fontWeight: 600,
                      color: '#e2e8f0',
                    }}
                  >
                    {champ}
                  </span>
                ))}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
};
