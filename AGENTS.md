# Project Guidelines

Three branches. Each has a skill in `.agents/skills/` — load it before branch work.

- **esports-match-tracker** — track a day's pro matches → Worlds daily report video.
- **lol-pro-video-transcript** — pro match commentary video → Whisper transcript → summary grounded in match data.
- **leagueProDB** — upload match data to Supabase. Read `leagueProDB/DATABASE.md` before any Postgres work; load `supabase` + `supabase-postgres-best-practices` skills.

## Remotion (shared)
- Commands run from `remotion/`: `npm run dev` / `build` / `lint`.
- Fixed 30 fps and dimensions; static assets via `staticFile()` from `public/`.
- All colors live in `remotion/src/theme.ts`.

## Task Execution
- Track state in `PROGRESS.md` (goal, `[ ]`/`[x]`, active step, verification); update after each step, read when resuming.
- `video-shotcraft`: follow its skill — no coding before Phase 0–3 sign-offs; never auto-run the audit subagent.
