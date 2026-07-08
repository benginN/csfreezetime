# How Freezetime works

A plain-language tour of what this project is, what you can do with it, and how
the pieces fit together. If you just want to run it, see the
[README](../README.md); if you want every architectural decision, see
[mimari.md](mimari.md) (Turkish). This page is the middle ground.

> This whole project — parser to UI — was built end to end with
> [Claude Code](https://claude.com/claude-code) (Claude Fable 5), pair-programmed
> by its author. That's also why it's set up to be explored and extended the
> same way (see the last section).

---

## The problem it solves

Coaches and analysts spend hours scrubbing CS2 demos by hand: opening the game,
seeking to pistol rounds, watching the same execute twenty times, jotting down
"they smoke top-mid at 1:39." Freezetime does that work **once, ahead of time.**

Every demo is parsed a single time into positions (16 Hz), kills, grenades and
economy. From that, hundreds of features are pre-computed into database tables.
After that, every question — "what does this team run on a full buy after
losing a round on A?" — is a fast table lookup, not a re-watch. The project's
motto is **parse once, query forever.**

Everything runs on your own machine. There are **no external AI services** and
no per-use cost: all the "smart" parts are deterministic statistics, geometry,
and locally-trained models.

---

## The mental model: one pipeline

A demo flows through the system like this:

```
  your .dem file
        │
        ▼
  ingest  ──►  parser-worker (Rust)  ──►  ClickHouse  (positions, 16 Hz "ticks")
        │            demoparser core        PostgreSQL (matches, rounds, kills…)
        ▼
  enrichment (Python)   trades, first-kills, buy classes, first-grenade flags
        │
        ▼
  ml-jobs (Python)      strategy clusters, tendencies, roles, win-prob,
        │               predictions, anomalies, boosts…  (writes back to PG)
        ▼
  stats-svc (Go)  ──►  serves the API and the web app on :8090
        │
        ▼
  apps/web (React + PixiJS)   the 2D replay and every analysis page
```

The two databases split the work on purpose:

- **ClickHouse** holds the heavy per-tick position data (millions of rows per
  match) — great at "where was everyone at second 15 across 300 rounds."
- **PostgreSQL** holds the relational meta: matches, rounds, kills, and all the
  pre-computed analysis tables the coach actually reads.

Messages between services go over **NATS JetStream**, and raw demos live in
**MinIO** (S3-compatible). All of it comes up with one `docker compose`.

---

## What you can actually do

Once you've fed it some demos, the web app (`:8090`) gives you:

- **2D replay** — a synchronized top-down view of any round with HP, economy,
  kill feed, grenade trajectories, smoke bloom, and flash blindness. Scrub,
  change speed, draw on the map, copy `setpos` for your practice server.
- **Heatmaps & ghost rounds** — overlay many rounds at once to see recurring
  positions and how executes differ, aligned at round start / plant / first
  kill.
- **Opponent report** (`/report/:team`) — a coach's one-pager per team & map:
  economy, execute templates, strategy tendencies, default setups (with exact
  player positions), utility habits, rush rate, "when they take area X the
  round ends on site Y," boosts, and a next-round prediction.
- **Pattern Finder** (`/patterns`) — every grenade on a map as landing dots;
  the top repeated spots are ranked for you ("smoke → TopMid ×47, usually at
  1:39 ±5s"). Drag a box on the map to isolate an area and read its timing.
- **Scenarios** (`/scenarios`) — situation queries: "as T on Mirage, full buy,
  right after losing a round on A — what do they run?" You get the historical
  mix, how far it deviates from their normal game, and real rounds to watch.
- **ML Lab** (`/insights`) — the transparency page for the prediction models:
  what they know, how they're tested, and which method wins (see below).
- **My DB** — a browser-based way to process private demos without touching the
  main archive. It was built for a *hosted* scenario, where users can't reach
  the backend, so their demos are parsed client-side and never kept on the
  server. If you're **self-hosting, you usually just backfill instead** (it's
  your server anyway — see below). My DB still works and can attach team voice
  comms synced to the replay.

---

## The "honest numbers" philosophy

Two rules run through the whole codebase:

1. **Every claim carries its sample size.** A "70% B rush" from 6 rounds is a
   lie dressed as data. Thresholds hide thin data instead of guessing (e.g. a
   role tag needs 30+ rounds; a utility spot needs 3+ repeats), and numbers show
   their `n`.

2. **A model only serves if it *earns* it.** The prediction engine runs six
   methods — from a simple league average to a gradient-boosted **LightGBM**
   model — and scores them on a **temporal test**: train on older rounds,
   predict the newest 25% of every match. Per map & side, **only the winner is
   ever shown.** A fancy model that can't beat the honest baseline stays on the
   bench. The ML Lab page shows this race openly.

Strategy "clusters" (the recurring ways a side opens a round) are found with
k-means over opening-phase positioning — no black box, no external AI,
everything deterministic and reproducible. Recent matches count more than old
ones (an exponential recency weight with a ~3-month half-life).

---

## Running it & where to read the code

The [README](../README.md) has the full quickstart. The short version:
`docker compose up` the infrastructure, run the four services, **drop your
`.dem` files into `backfill/`** (a watcher picks them up automatically), run
`ml-jobs`, open `:8090`. **You bring the demos** — the repo ships the engine,
not any data.

**How much data do you need?** Team-level intelligence — tendencies,
predictions, patterns, playbooks — gets meaningful only with a real archive;
the more demos you feed it, the sharper and more trustworthy the numbers (thin
data hides itself rather than guess). Backfilling a season or two of a team's
matches is the sweet spot. That said, if you just want to look at **one match**,
the **Analyze** page parses a single demo on its own — no archive required.

Good places to start reading:

| You want to understand… | Look at |
|---|---|
| The parsing core | `services/parser-worker` (Rust) |
| The API + query engine | `services/stats-svc` (Go) — one handler per feature |
| The analysis (clusters, roles, predictions) | `services/ml/src/ml` (Python) |
| The replay & pages | `apps/web/src` (React + PixiJS) |
| Every design decision | `docs/mimari.md` |

---

## Exploring & extending it with Claude Code

This project was built **end to end** with, and is set up to be explored with,
[Claude Code](https://claude.com/claude-code) (Claude Fable 5) — from the Rust
parser to the React UI. If you clone it and open Claude Code in the repo, it
will read:

- **`CLAUDE.md`** — the house rules (which language each service uses, where
  tick data may and may not go, the "plan → confirm → build" workflow).
- **`docs/mimari.md`** — the full architecture and the reasoning behind every
  decision.

That means you can ask things like *"where does the win-probability table get
built?"* or *"add a filter for X to the opponent report"* and Claude Code has
enough context to help. You don't need any of the original author's private
notes — everything a contributor needs is in the repo itself.

Questions, ideas, or bugs? Open an issue. Forks and pull requests welcome —
it's MIT licensed, so do what you like with it.
