# brain.md — Rizuu-Router knowledge base

Everything learned about this gateway, how it is built, how to change it safely, and how to prove a change works. Topic files live in [`brain/`](brain/).

## Start here

| I want to… | Read |
|---|---|
| Know what this repo is and how it runs | [brain/01-project.md](brain/01-project.md) |
| Understand request flow / where logic lives | [brain/02-architecture.md](brain/02-architecture.md) |
| Change code and prove it still works | [brain/03-dev-and-verify.md](brain/03-dev-and-verify.md) |
| Know the Rizuu-vs-Neko branding state | [brain/04-branding.md](brain/04-branding.md) |
| Port a commit from the upstream main repo | [brain/05-porting-upstream.md](brain/05-porting-upstream.md) |
| Avoid known traps (env, git, Windows, tooling) | [brain/06-gotchas.md](brain/06-gotchas.md) |
| See what is still unfinished | [brain/07-pending.md](brain/07-pending.md) |

## Snapshot (2026-10-04)

- **What**: Rizuu-Router — fork of *Neko-Router*, a headless AI gateway/router for OpenAI- & Anthropic-compatible endpoints.
- **Stack**: Bun 1.3 + ElysiaJS, `bun:sqlite` (WAL) + Drizzle, React 19 frontend bundled **in memory** (zero-build), Tailwind v4 precompiled to `src/web/compiled.css`.
- **Origin**: `origin = https://github.com/RizkyDaffy/gateway.git`, upstream = `https://github.com/ShirokamiRyzen/Neko-Router`.
- **HEAD**: `9a3327d copycat` (parent `552f785`). Blue theme + Rizuu branding live in this commit; the upstream port of `d262bf4` and legacy-key fix sit **uncommitted** on top.
- **Run**: `bun --watch src/index.ts` on port **3000** (admin UI at `/`, Swagger at `/swagger`).
- **State of checks**: `bunx tsc --noEmit` → **32 pre-existing errors, 0 new**; `bun build src/web/main.tsx` → exit 0; key/session test matrix all green (see [03-dev-and-verify.md](brain/03-dev-and-verify.md)).
