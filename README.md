# drizzle-rebase

Detect and resolve [Drizzle ORM](https://orm.drizzle.team/) migration conflicts across git branches.

> **Note:** This tool specifically targets the **Drizzle 1.0 beta** migration format. The snapshot structure and migration directory layout changed significantly in the 1.0 beta — this tool is built for that format and is not compatible with older Drizzle migration formats.

## The Problem

When multiple developers (or branches) create Drizzle migrations independently, you end up with timestamp collisions and broken snapshot chains after merging. Manually resolving these conflicts is tedious and error-prone.

`drizzle-rebase` solves this by rebasing your branch's migrations on top of the base branch's latest migration — similar to how `git rebase` replays commits. Your SQL is preserved exactly as-is; only the timestamps and snapshot metadata are updated.

## How It Works

1. Finds the git merge-base between your branch and the base branch
2. Identifies which migrations were added on your branch (vs. already on the base)
3. Computes incremental snapshot diffs for each of your migrations
4. Replays those diffs on top of the base branch's final snapshot
5. Assigns new timestamps after the last base-branch migration
6. Detects conflicts (e.g., both branches modified the same column) and aborts safely if found
7. Creates a backup before any destructive operations and restores on failure

**Your SQL is never modified.** Only snapshot metadata (the `snapshot.json` files) and directory timestamps are changed.

## Install

```bash
npm install -g drizzle-rebase
```

Or run directly with npx:

```bash
npx drizzle-rebase plan
```

## Usage

```
drizzle-rebase <command> [options]
```

### Commands

#### `plan`

Dry-run that shows what would happen during a rebase. Use this to preview before committing to changes.

```bash
drizzle-rebase plan
```

Outputs which migrations were found on the base branch, which were added on your branch, and how they would be renumbered.

#### `run`

Executes the rebase. Rebases snapshots, assigns new timestamps, and preserves all SQL as-is.

```bash
drizzle-rebase run
```

On success, your migration directories are renamed with new timestamps and their `snapshot.json` files are updated to form a valid chain on top of the base branch's migrations.

On failure (e.g., snapshot conflicts detected), all changes are rolled back from backup automatically.

### Options

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Path to the migrations directory | `./drizzle` |
| `--base <branch>` | Base branch to compare against | `main` |
| `--push` | Run `drizzle-kit push --force` after a successful rebase (only applies to `run`) | `false` |
| `--help`, `-h` | Show help message | |

### Examples

```bash
# Preview what a rebase would do
drizzle-rebase plan

# Preview against a different base branch
drizzle-rebase plan --base develop

# Custom migrations directory
drizzle-rebase plan --dir ./src/db/migrations

# Execute the rebase
drizzle-rebase run

# Execute and push to the database afterward
drizzle-rebase run --push

# Full example with all options
drizzle-rebase run --dir ./drizzle --base main --push
```

## Conflict Detection

When both branches modify the same database entities, `drizzle-rebase` detects the conflict and aborts before making any changes. Conflict types:

- **add-exists** — Your migration adds an entity that already exists on the base branch (with a different definition)
- **remove-modified** — Your migration removes an entity that was modified on the base branch
- **modify-diverged** — Both branches modified the same entity differently

When conflicts are detected the tool restores your original migrations from backup and exits with a non-zero status code. You'll need to resolve the conflicts manually.

## Migration Format

This tool expects the Drizzle 1.0 beta migration directory structure:

```
drizzle/
├── 20250101000000_initial/
│   ├── migration.sql
│   └── snapshot.json
├── 20250102000000_add_posts/
│   ├── migration.sql
│   └── snapshot.json
└── 20250103000000_add_comments/
    ├── migration.sql
    └── snapshot.json
```

Each directory is named `<YYYYMMDDHHMMSS>_<name>` and contains a `migration.sql` with the raw SQL and a `snapshot.json` with the full schema state at that point in the migration chain.

## Development

Requires [Bun](https://bun.sh/).

```bash
# Install dependencies
bun install

# Run in development
bun run dev

# Run tests
bun test

# Build for distribution
bun run build

# Lint and typecheck
bun run check
```

## License

MIT
