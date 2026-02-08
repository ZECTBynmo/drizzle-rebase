import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

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
