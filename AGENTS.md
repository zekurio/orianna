# AGENTS.md

## Dev shell

devenv provides the shell through direnv. Outside direnv, prefix commands
with `devenv shell`, like `devenv shell bun run typecheck`. `nix develop`
doesn't work here.

There is no test suite, so run `bun run typecheck` before every commit.

## Code

The bot uses [Effect](https://effect.website) v4; `node_modules/effect/CLAUDE.md`
points at its docs.

- Call Fluxer through `request` in `src/fluxer.ts`. fluxer.js already
  retries and waits out rate limits, so don't retry on top.
- Fail with `refuse(...)` (a `UserError`) for anything a member should read.
  Other failures are only logged.
- Use `listen` from `src/fluxer.ts` for gateway events. Every guild's
  listeners see every guild's events, so ignore the other guilds' ones.
- Rows that belong to a guild carry its `guildId`, and queries filter by it.
- Read bot settings through `Settings` (`src/settings/settings.ts`), not
  `AppConfig`, which only has the config file's deployment keys.
- Bun only: use Bun's APIs or Effect's platform services, not `node:`
  modules.

## Web app

- Add UI primitives with `bunx --bun shadcn@latest add <name>`. Use only the
  semantic colours from `src/web/app/styles.css`, and build pages on
  `src/web/app/components/page.tsx` instead of setting widths or colours.
- Put a feature's settings on its own page. The Admin tab is for server-wide
  settings and features without a page.
- Report how an action went with `toast` from `sonner`. Inline messages are
  for form field problems and data that didn't load.
- While loading, show skeletons inside `Placeholder`
  (`src/web/app/components/loading.tsx`). No "Loading…" text; spinners only
  in buttons whose action is running.
- Shared or page-surviving UI state goes in a zustand store; the rest in
  `useState`.
- RPC calls are defined in `src/web/rpc.ts` and implemented in
  `src/web/handlers.ts`. A failure a member should read is an error in the
  call's schema; wrap anything else in `hide`.

## Nix

- Run `nix build` after touching `nix/`, `package.json` or `bun.lock`.
  `git add` new files first, or the flake won't see them.
- When `bun.lock` changes, set `outputHash` in `nix/package.nix` to
  `lib.fakeHash`, build, and commit the hash from the error with the
  lockfile.
- A file the bot reads at runtime has to be embedded like `drizzle/`: in
  `compile.assets` in `scripts/build.ts`, in the fileset in
  `nix/package.nix`, and found like the migrations in `src/db/index.ts`.
- Format with `nix fmt -- flake.nix nix/*.nix`. Pass files, not directories.

## Database and settings

- No migration code, and no code that upgrades stored data. A schema or
  settings change that doesn't fit an existing database means deleting it.
- After changing `src/db/schema.ts`, run `bun run db:generate` and commit
  the new `drizzle/` with it, then delete the dev database.
- Declare a text primary key with `primaryKey()` next to the indexes, not
  `.primaryKey()` on the column; `src/db/schema.ts` says why.
- Update drizzle-orm and drizzle-kit together.

## Docs

- The code is the documentation. Keep the doc comments in `src/config.ts`
  current, and update `config.example.json` when the config file changes.
- Command and option descriptions show in `!help` and on the web, so write
  them for members.
- A new permission goes in `PERMISSIONS` in `src/permissions/rules.ts` and
  in the `permissions` comment in `src/config.ts`.
- No markdown files besides `README.md` and this one. Update the README when
  running the bot changes.

## Commits, branches and PRs

- [Conventional Commits](https://www.conventionalcommits.org/), like
  `feat(sticker): accept tags with spaces`. Types: `feat`, `fix`,
  `refactor`, `perf`, `docs`, `build`, `chore`. Imperative, lowercase
  subject under 72 characters; body wrapped at 72.
- Unknown config keys stop the bot, so renaming or removing one is breaking:
  mark it with `!` and a `BREAKING CHANGE:` footer saying what to change.
- Branch from `main`, named with three lowercase words like
  `sticker-tag-limits`, no type prefix.
- One change per PR, opened with `gh pr create`. The title follows the
  commit format. The body says what changed and why, calls out config key
  changes, new migrations and `outputHash` bumps, and says how you checked
  it (`bun run typecheck`, `nix build`, running against an instance).
