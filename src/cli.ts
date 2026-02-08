#!/usr/bin/env node

import { resolve } from "node:path"
import { detect, formatDetectResult } from "./cli/detect"
import { formatRebasePlan, planRebase } from "./cli/rebase"
import { executeRebase, formatRebaseResult } from "./cli/run"

const HELP = `
drizzle-rebase — Detect and resolve Drizzle migration conflicts across git branches

Usage:
  drizzle-rebase detect [--dir <path>]
    Classify all migrations as generated, manual, or mixed.

  drizzle-rebase plan [--dir <path>] [--base <branch>]
    Show what would happen during a rebase (dry run).

  drizzle-rebase run [--dir <path>] [--base <branch>] [--push]
    Autonomous rebase: rebase snapshots and assign new timestamps,
    preserving all SQL as-is.

Options:
  --dir <path>      Path to migrations directory (default: ./drizzle)
  --base <branch>   Base branch to compare against (default: main)
  --push            Run drizzle-kit push after a successful rebase
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
      const plan = await planRebase({ migrationsDir, baseBranch, cwd })
      console.log(formatRebasePlan(plan))
      console.log("")

      const result = await executeRebase({ migrationsDir, cwd, plan, push: args.push === true })
      console.log(formatRebaseResult(result))

      if (!result.success) {
        process.exit(1)
      }
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
