import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

export async function getMergeBase(cwd: string, branch: string): Promise<string> {
  return git(["merge-base", "HEAD", branch], cwd)
}

export async function getAddedFiles(cwd: string, since: string, path: string): Promise<string[]> {
  const output = await git(["diff", "--name-only", "--diff-filter=A", since, "--", path], cwd)
  if (!output) return []
  return output.split("\n").filter(Boolean)
}
