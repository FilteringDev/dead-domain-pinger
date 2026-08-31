import * as ChildProcess from 'node:child_process'
import * as Process from 'node:process'

export function RunGit(
  WorkingDirectory: string,
  GitArguments: string[],
  Environment: NodeJS.ProcessEnv = {}
): Promise<string> {
  return new Promise((Resolve, Reject) => {
    ChildProcess.execFile('git', GitArguments, {
      cwd: WorkingDirectory,
      encoding: 'utf-8',
      env: { ...Process.env, ...Environment }
    }, (ErrorValue, Stdout) => {
      if (ErrorValue) {
        Reject(new Error(ErrorValue.message, { cause: ErrorValue }))
      } else {
        Resolve(Stdout)
      }
    })
  })
}
