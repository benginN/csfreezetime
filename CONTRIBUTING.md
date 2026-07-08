# Contributing to Freezetime

Thanks for taking a look — issues, ideas, forks and pull requests are all
welcome. It's MIT licensed, so you can also just take it and run.

## Getting it running

See the [README](README.md) for step-by-step setup and how to feed it demos,
and [docs/how-it-works.md](docs/how-it-works.md) for a tour of what everything
does and where to start reading the code.

## Ground rules (kept in `CLAUDE.md`)

The repo has a short `CLAUDE.md` with the house rules. The important ones:

- **Language per service:** parser-worker is Rust, `ingest`/`stats-svc` are Go,
  `enrichment`/`ml` are Python. Keep to each service's stack.
- **Data separation:** per-tick position data lives in ClickHouse; relational
  meta lives in PostgreSQL. Never write tick/position data to PostgreSQL, and
  never write relational meta to ClickHouse.
- **Honest numbers:** every stat carries its sample size, and thin data hides
  itself rather than guess. Please keep new features to that standard.
- **Schema changes** come with a migration and a note in `docs/mimari.md`.
- **Commits** are in English, imperative mood ("add parser retry logic").
- **Tests:** run `scripts/test-ml.sh` / `scripts/test-dsl.sh` before opening a PR
  where relevant.

## Using Claude Code

This project was built with, and is easy to extend with,
[Claude Code](https://claude.com/claude-code). Open it in the repo and it will
read `CLAUDE.md` and `docs/mimari.md` for context — enough to help you find
where a feature lives or add a new one. You don't need any private notes.

## Questions?

- **How do I…, setup help, open-ended ideas** → start a
  [Discussion](https://github.com/benginN/csfreezetime/discussions).
- **A concrete bug or feature** → open an [Issue](https://github.com/benginN/csfreezetime/issues).

By contributing you agree your work is under the project's MIT license.
