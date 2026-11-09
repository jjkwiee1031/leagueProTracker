import React from 'react';
import { Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import { HeadlineOpener } from './components/HeadlineOpener';
import { MatchCard, MatchData } from './components/MatchCard';
import { RecapCard } from './components/RecapCard';
import { CaptionTrack, SubtitleItem } from './components/CaptionTrack';

export interface WorldsReportProps {
  date: string;
  matches: MatchData[];
  subtitles: SubtitleItem[];
  enableNarration?: boolean;
  [key: string]: unknown;
}

const FIXED_OPENER = 90; // 3s fallback when no TTS timing is available
const FIXED_CARD = 190; // ~6.3s fallback per match

export const WorldsReport: React.FC<WorldsReportProps> = ({
  date,
  matches,
  subtitles,
  enableNarration = true,
}) => {
  const { durationInFrames } = useVideoConfig();

  // Match cues from the TTS track, in spoken order.
  const matchCues = [...subtitles]
    .filter((s) => s.kind === 'match')
    .sort((a, b) => a.start - b.start);
  const outroCue = [...subtitles]
    .filter((s) => s.kind === 'outro')
    .sort((a, b) => a.start - b.start)[0];
  const recapCue = [...subtitles]
    .filter((s) => s.kind === 'recap')
    .sort((a, b) => a.start - b.start)[0];

  // Only trust cue timing when it covers every match.
  const hasTiming = matches.length > 0 && matchCues.length === matches.length;

  const boundaries = hasTiming ? matchCues.map((s) => s.start) : [];
  const openerDuration = hasTiming ? Math.max(24, boundaries[0]) : FIXED_OPENER;
  const outroStart = hasTiming
    ? outroCue
      ? outroCue.start
      : durationInFrames
    : FIXED_OPENER + matches.length * FIXED_CARD;
  // The last match card ends where the day recap begins (if there is one).
  const lastMatchEnd =
    hasTiming && recapCue && recapCue.start < outroStart ? recapCue.start : outroStart;

  const cardRange = (idx: number) => {
    if (!hasTiming) {
      return { from: FIXED_OPENER + idx * FIXED_CARD, duration: FIXED_CARD };
    }
    const from = boundaries[idx];
    const to = idx + 1 < boundaries.length ? boundaries[idx + 1] : lastMatchEnd;
    return { from, duration: Math.max(1, to - from) };
  };

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: '#030712',
        overflow: 'hidden',
      }}
    >
      {/* Voiceover Track */}
      {enableNarration && (
        <Audio src={staticFile('worlds/narration.mp3')} volume={1.0} />
      )}

      {/* Opening Shot — runs until the first match line is spoken */}
      <Sequence durationInFrames={openerDuration}>
        <HeadlineOpener
          title="SWISS STAGE 赛况总览"
          subtitle={`${date} · 共 ${matches.length} 场焦点之战`}
        />
      </Sequence>

      {/* Per-Match Cards — each card lasts exactly as long as its spoken line */}
      {matches.map((m, idx) => {
        const { from, duration } = cardRange(idx);
        return (
          <Sequence key={idx} from={from} durationInFrames={duration}>
            <MatchCard match={m} index={idx} total={matches.length} />
          </Sequence>
        );
      })}

      {/* Day recap card — from the recap cue until the outro cue */}
      {hasTiming && recapCue && recapCue.start < outroStart && (
        <Sequence from={recapCue.start} durationInFrames={outroStart - recapCue.start}>
          <RecapCard matches={matches} date={date} />
        </Sequence>
      )}

      {/* Closing card once the outro line begins */}
      {hasTiming && outroStart < durationInFrames && (
        <Sequence from={outroStart} durationInFrames={durationInFrames - outroStart}>
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
                fontSize: 28,
                fontWeight: 700,
                color: '#38bdf8',
                letterSpacing: '4px',
                marginBottom: 18,
              }}
            >
              WORLDS 2026 · SWISS STAGE
            </div>
            <div
              style={{
                fontSize: 68,
                fontWeight: 900,
                background: 'linear-gradient(135deg, #f8fafc 0%, #38bdf8 50%, #818cf8 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              感谢观看
            </div>
            <div
              style={{
                marginTop: 22,
                padding: '8px 24px',
                borderRadius: 9999,
                border: '1px solid rgba(56, 189, 248, 0.3)',
                background: 'rgba(56, 189, 248, 0.1)',
                color: '#e2e8f0',
                fontSize: 26,
                fontWeight: 600,
              }}
            >
              {date}
            </div>
          </div>
        </Sequence>
      )}

      {/* Global Captions */}
      <CaptionTrack subtitles={subtitles} />
    </div>
  );
};
