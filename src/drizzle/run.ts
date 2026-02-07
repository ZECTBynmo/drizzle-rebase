import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { promisify } from "node:util"

const exec = promisify(execFile)

export interface DrizzleGenerateResult {
  success: boolean
  output: string
  newDirs: string[]
}

export async function drizzleGenerate(opts: {
  cwd: string
  migrationsDir: string
  existingDirs: Set<string>
}): Promise<DrizzleGenerateResult> {
  try {
    const { stdout, stderr } = await exec("bunx", ["drizzle-kit", "generate"], {
      cwd: opts.cwd,
      timeout: 30_000,
    })
    const output = stdout + stderr

    const afterEntries = await readdir(opts.migrationsDir)
    const newDirs = afterEntries
      .filter((e) => /^\d{14}_/.test(e))
      .filter((e) => !opts.existingDirs.has(e))

    return { success: true, output, newDirs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: msg, newDirs: [] }
  }
}

export interface DrizzlePushResult {
  success: boolean
  output: string
}

export async function drizzlePush(opts: { cwd: string }): Promise<DrizzlePushResult> {
  try {
    const { stdout, stderr } = await exec("bunx", ["drizzle-kit", "push", "--force"], {
      cwd: opts.cwd,
      timeout: 60_000,
    })
    return { success: true, output: stdout + stderr }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: msg }
  }
}
