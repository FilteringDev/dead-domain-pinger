import * as Core from '@actions/core'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { GetHeadRevision } from './sources/domain-history.ts'
import { BuildMatrixEntries } from './sources/stage-artifacts.ts'

const Env = Zod.object({
  SCAN_DIRECTORIES: Zod.string().default('')
}).parse(Process.env)

const WorkingDirectory = Process.env.CI_WORKSPACE_PATH ?? Process.cwd()
const Entries = BuildMatrixEntries(WorkingDirectory, Env.SCAN_DIRECTORIES)
const CommitSha = await GetHeadRevision(WorkingDirectory)
if (!CommitSha) {
  throw new Error('Could not resolve the checked-out commit; matrix-build must run on a Git checkout')
}

Core.setOutput('matrix', JSON.stringify({ include: Entries }))
Core.setOutput('worker_count', String(Entries.length))
Core.setOutput('commit_sha', CommitSha)
Core.info(`[dead-domain-pinger] Created ${Entries.length} non-overlapping scan scopes at ${CommitSha}`)