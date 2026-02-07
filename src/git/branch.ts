import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
}

export async function getMergeBase(cwd: string, branch: string): Promise<string> {
  return git(["merge-base", "HEAD", branch], cwd)
}

export async function getAddedFiles(cwd: string, since: string, path: string): Promise<string[]> {
  const output = await git(["diff", "--name-only", "--diff-filter=A", since, "--", path], cwd)
  if (!output) return []
  return output.split("\n").filter(Boolean)
}

export async function getFilesOnBranch(
  cwd: string,
  branch: string,
  path: string,
): Promise<string[]> {
  try {
    const output = await git(["ls-tree", "-r", "--name-only", branch, "--", path], cwd)
    if (!output) return []
    return output.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

export async function getRepoRoot(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd)
}
