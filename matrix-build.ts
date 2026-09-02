import * as Core from '@actions/core'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { BuildMatrixEntries } from './sources/stage-artifacts.ts'

const Env = Zod.object({
  SCAN_DIRECTORIES: Zod.string().default('')
}).parse(Process.env)

const WorkingDirectory = Process.env.CI_WORKSPACE_PATH ?? Process.cwd()
const Entries = BuildMatrixEntries(WorkingDirectory, Env.SCAN_DIRECTORIES)

Core.setOutput('matrix', JSON.stringify({ include: Entries }))
Core.setOutput('worker_count', String(Entries.length))
Core.info(`[dead-domain-pinger] Created ${Entries.length} non-overlapping scan scopes`)