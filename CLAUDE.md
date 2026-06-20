# Ksefnik — TypeScript SDK

## Project Overview

Open-source TypeScript SDK for KSeF (Polish National e-Invoice System) reconciliation.
Core value: matching KSeF invoices with bank statement transactions.

**Organization**: CodeFormers-it
**Repo**: CodeFormers-it/ksefnik (private → public when ready)
**Sister repo**: CodeFormers-it/ksefnik-pro (always private)
**Domain**: ksefnik.pl

## Tech Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript (strict) |
| Runtime | Node.js 22 |
| Package Manager | pnpm (workspace monorepo) |
| Validation | Zod |
| Testing | Vitest |
| KSeF API client | @ksef/client (adapter pattern) |
| MCP SDK | @modelcontextprotocol/sdk |
| CLI | Commander.js |
| Interactive | @clack/prompts |
| Fuzzy matching | fuzzball |
| MT940 parsing | mt940js |
| DB (local) | bun:sqlite |
| Binary | bun build --compile |

## Monorepo Structure

```
packages/
  shared/        @ksefnik/shared    — Zod schemas, types, plugin interface
  core/          @ksefnik/core      — SDK facade, reconciliation engine, bank parsers
  simulator/     @ksefnik/simulator — Offline KSeF mock server
  mcp/           @ksefnik/mcp       — MCP server (thin wrapper on core)

apps/
  cli/           @ksefnik/cli       — CLI entry point → standalone binary
```

## Key Conventions

- **pnpm workspace** with `apps/*` and `packages/*` (same as codeformers-website)
- **SDK-first**: all logic lives in `@ksefnik/core`. CLI, MCP, and hosted API are thin wrappers.
- **Plugin system**: pro features loaded via `try { await import(pkg) } catch {}` — missing = free tier.
- **No DRM**: zero license validation in runtime, zero phone-home.
- **Zod everywhere**: all domain models (Invoice, BankTransaction, Match) are Zod schemas.
- **Money as integers**: amounts in grosze (1 PLN = 100), never floats.
- **Adapter pattern**: @ksef/client wrapped in adapter for retry, cache, swappability.
- **.nvmrc**: 22
- **Formatting**: Prettier (no ESLint in root)

## Architecture Principles

- `Ksefnik` facade with namespaces: `invoices`, `bank`, `reconciliation`, `plugins`
- Factory: `createKsefnik()`
- Reconciliation engine: 6-pass pipeline (KSeF ref → exact NIP → invoice ref → fuzzy → partial → proximity)
- Each pass implements `ReconciliationPass` interface with `order` number (core: 50-500, plugins: 600+)
- Bank parsers implement `BankStatementParser` protocol with auto-detection

## Development Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all packages in watch mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Run Vitest |
| `pnpm typecheck` | Type-check all packages |
| `pnpm smoke` | Smoke test against KSeF test environment (requires `.env` with credentials — see `docs/spec/send-invoice-interactive-session.md`) |

## Documentation Reference

Always read the relevant architecture docs before writing code — they encode project-wide conventions and design decisions. Pick from this list based on what you're implementing:

- **docs/01-monorepo-structure.md** — read before adding a package or moving code between packages
- **docs/02-sdk-facade-pattern.md** — read before exposing new functionality through the SDK
- **docs/03-thin-wrapper-architecture.md** — read before writing CLI, MCP, or any delivery layer
- **docs/04-zod-domain-models.md** — read before defining a new domain model or schema
- **docs/05-money-as-integers.md** — read before handling any monetary amount
- **docs/06-typed-error-hierarchy.md** — read before throwing or catching errors
- **docs/07-ksef-adapter-pattern.md** — read before adding a new adapter or modifying KSeF integration
- **docs/08-storage-interface.md** — read before persisting or querying data
- **docs/09-bank-parser-strategy.md** — read before adding a bank format parser
- **docs/10-reconciliation-pipeline.md** — read before adding a matching strategy or pass
- **docs/11-plugin-system.md** — read before adding a plugin or extensibility point
- **docs/12-validation-rules-engine.md** — read before adding a validation rule
- **docs/13-testing-patterns.md** — read before writing tests
- **docs/14-cli-design.md** — read before adding a CLI command
- **docs/15-mcp-server-design.md** — read before adding an MCP tool
- **docs/16-http-client-architecture.md** — read before implementing any KSeF HTTP call

## What NOT to do

- Don't add fetch/send KSeF as standalone value — it's commodity
- Don't build a web dashboard — buyer is a developer, not a bookkeeper
- Don't add Google Drive / storage integrations — not our problem
- Don't implement all 87 validation rules — do top 20 max
- Don't use Turborepo yet — overkill for 4-5 packages
