import * as Path from 'node:path'
import * as Process from 'node:process'
import { ApplyLocalEnvironment, ParseLocalOptions } from './sources/local-options.ts'
import { DiffFileName } from './sources/preview.ts'
import { ReportFileName } from './sources/report.ts'

const HelpText = String.raw`Usage:
  GLOBALPING_API_TOKEN=... pnpm run local -- --workspace PATH --output PATH [options]

Options:
  --workspace PATH         Target filter-list checkout (required)
  --output PATH            Preview directory outside the target checkout (required)
  --filter-root PATH       Filter directory relative to the checkout (default: .)
  --file-extension EXT     Filter-list extension (default: .txt)
  --max-candidates COUNT   Maximum probe jobs (default: 50)
  --worker-count COUNT     Probe worker-thread count (default: os.cpus().length)
  --ordering-worker-count COUNT
                           Git-ordering worker count (default: min(2, available CPUs))
  --state-path PATH        Optional read-only SQLite state snapshot
  --always-refresh         Ignore all prior state, including queued follow-ups
  -h, --help               Show this help
`

const Options = ParseLocalOptions(Process.argv.slice(2), Process.cwd())

if (Options.Help) {
  Process.stdout.write(HelpText)
} else {
  ApplyLocalEnvironment(Options)
  await import('./index.ts')

  Process.stdout.write([
    '',
    'Preview artifacts:',
    `  ${Path.join(Options.OutputDirectory, DiffFileName)}`,
    `  ${Path.join(Options.OutputDirectory, ReportFileName)}`,
    ''
  ].join('\n'))
}
