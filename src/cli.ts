#!/usr/bin/env node

import { resolve } from "node:path"
import { detect, formatDetectResult } from "./cli/detect"
import { formatRebasePlan, planRebase } from "./cli/rebase"

const HELP = `
drizzle-rebase — Detect and resolve Drizzle migration conflicts across git branches

Usage:
  drizzle-rebase detect [--dir <path>]
    Classify all migrations as generated, manual, or mixed.

  drizzle-rebase plan [--dir <path>] [--base <branch>]
    Show what would happen during a rebase (dry run).

  drizzle-rebase run [--dir <path>] [--base <branch>]
    Delete generated-only migrations from your branch and
    prompt to run drizzle-kit generate + push.

Options:
  --dir <path>      Path to migrations directory (default: ./drizzle)
  --base <branch>   Base branch to compare against (default: main)
  --help            Show this help message
`.trim()

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === "--help" || arg === "-h") {
      args.help = true
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return { args, positional }
}

async function main() {
  const { args, positional } = parseArgs(process.argv.slice(2))

  if (args.help || positional.length === 0) {
    console.log(HELP)
    process.exit(0)
  }

  const command = positional[0]
  const migrationsDir = resolve(typeof args.dir === "string" ? args.dir : "./drizzle")
  const baseBranch = typeof args.base === "string" ? args.base : "main"
  const cwd = process.cwd()

  switch (command) {
    case "detect": {
      const result = await detect({ migrationsDir })
      console.log(formatDetectResult(result))
      break
    }

    case "plan": {
      const plan = await planRebase({ migrationsDir, baseBranch, cwd })
      console.log(formatRebasePlan(plan))
      break
    }

    case "run": {
      const { rm } = await import("node:fs/promises")
      const plan = await planRebase({ migrationsDir, baseBranch, cwd })
      console.log(formatRebasePlan(plan))

      if (plan.needsAttention.length > 0) {
        console.log("\nSome migrations contain manual SQL and cannot be auto-deleted.")
        console.log("Please handle them manually before continuing.")
        process.exit(1)
      }

      if (plan.safeToDelete.length === 0) {
        console.log("\nNothing to do.")
        process.exit(0)
      }

      console.log(`\nDeleting ${plan.safeToDelete.length} generated migration(s)...`)

      for (const m of plan.safeToDelete) {
        await rm(m.dirPath, { recursive: true })
        console.log(`  Deleted ${m.dirName}`)
      }

      console.log("\nDone. Next steps:")
      console.log("  1. Run: drizzle-kit generate")
      console.log("  2. Run: drizzle-kit push     (to sync local DB)")
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.log(HELP)
      process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
