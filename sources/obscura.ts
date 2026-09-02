import { spawn } from 'node:child_process'
import * as Zod from 'zod'
import { IsParkingServiceHost } from './parking-services.ts'
import type { DomainProbeResult, ProbeWorkItem } from './types.ts'

const ScrapeResponseSchema = Zod.object({
  results: Zod.array(Zod.object({
    url: Zod.string().optional(),
    eval: Zod.string().nullable().optional(),
    error: Zod.string().optional()
  }).loose())
}).loose()

export type ObscuraRunOptions = {
  BinaryPath: string
  Arguments: string[]
  Input: string
}

export type ObscuraRunResult = {
  Stdout: string
  Stderr: string
}

export type ObscuraRunner = (Options: ObscuraRunOptions) => Promise<ObscuraRunResult>

export type VerifyParkedDomainsOptions = {
  WorkItems: ProbeWorkItem[]
  BinaryPath: string
  Concurrency: number
  TimeoutSeconds: number
  Run?: ObscuraRunner
}

function GetUrl(Work: ProbeWorkItem, Protocol: 'http' | 'https'): string {
  return Protocol + '://' + Work.Target + '/'
}

function RunObscura(Options: ObscuraRunOptions): Promise<ObscuraRunResult> {
  return new Promise((Resolve, Reject) => {
    const Child = spawn(Options.BinaryPath, Options.Arguments, { stdio: ['pipe', 'pipe', 'pipe'] })
    let Stdout = ''
    let Stderr = ''

    Child.stdout.setEncoding('utf8')
    Child.stderr.setEncoding('utf8')
    Child.stdout.on('data', Chunk => { Stdout += Chunk })
    Child.stderr.on('data', Chunk => { Stderr += Chunk })
    Child.on('error', Reject)
    Child.on('close', Code => {
      if (Code === 0) {
        Resolve({ Stdout, Stderr })
      } else {
        Reject(new Error(`Obscura exited with code ${Code}: ${Stderr.trim()}`))
      }
    })
    Child.stdin.end(Options.Input)
  })
}

function BuildDirectParkingResult(Work: ProbeWorkItem, FinalHost: string): DomainProbeResult {
  const Reason = 'Obscura stealth verification redirected to a parking service (' + FinalHost + ')'
  const Judgements = Object.fromEntries(Work.Origins.map(Origin => [Origin, {
    Verdict: 'Dead' as const,
    Reason,
    Stage: 'Http' as const,
    RuleId: 'obscura-parking-redirect'
  }]))

  return {
    Domain: Work.SourceDomain,
    Target: Work.Target,
    Protocol: Work.Protocol,
    Verdict: 'Dead',
    Reason,
    Warnings: ['removed because Obscura stealth verification redirected to a known parking service (' + FinalHost + ')'],
    SameDomainRedirects: [],
    ModifiedAtOverride: null,
    NextProbe: null,
    Judgements,
    Provisional: false
  }
}

function ParseScrapeResults(Output: string, SourceUrls: string[]): Map<string, string | null> {
  const Response = ScrapeResponseSchema.parse(JSON.parse(Output))
  const Results = new Map<string, string | null>()

  for (const [Index, SourceUrl] of SourceUrls.entries()) {
    const Result = Response.results[Index]
    Results.set(SourceUrl, Result?.error ? null : Result?.eval ?? null)
  }

  return Results
}

async function Scrape(Urls: string[], Options: VerifyParkedDomainsOptions, Run: ObscuraRunner): Promise<Map<string, string | null>> {
  if (Urls.length === 0) {
    return new Map()
  }

  const Result = await Run({
    BinaryPath: Options.BinaryPath,
    Arguments: [
      '--stealth', 'scrape', '-', '--concurrency', String(Options.Concurrency), '--timeout', String(Options.TimeoutSeconds),
      '--quiet', '--format', 'json', '--eval', 'document.location.href'
    ],
    Input: Urls.join('\n') + '\n'
  })
  return ParseScrapeResults(Result.Stdout, Urls)
}

function ParkingHost(FinalUrl: string | null): string | null {
  if (!FinalUrl) {
    return null
  }

  try {
    const Host = new URL(FinalUrl).hostname
    return IsParkingServiceHost(Host) ? Host : null
  } catch {
    return null
  }
}

/** Finds final parking-service navigations; inconclusive checks deliberately return no verdict. */
export async function VerifyParkedDomains(Options: VerifyParkedDomainsOptions): Promise<DomainProbeResult[]> {
  const Run = Options.Run ?? RunObscura
  const HttpsUrls = Options.WorkItems.map(Work => GetUrl(Work, 'https'))
  let HttpsResults: Map<string, string | null>

  try {
    HttpsResults = await Scrape(HttpsUrls, Options, Run)
  } catch {
    return []
  }

  const Results: DomainProbeResult[] = []
  const FailedHttps = Options.WorkItems.filter(Work => HttpsResults.get(GetUrl(Work, 'https')) === null)
  for (const Work of Options.WorkItems) {
    const Host = ParkingHost(HttpsResults.get(GetUrl(Work, 'https')) ?? null)
    if (Host) {
      Results.push(BuildDirectParkingResult(Work, Host))
    }
  }

  if (FailedHttps.length === 0) {
    return Results
  }

  let HttpResults: Map<string, string | null>
  try {
    HttpResults = await Scrape(FailedHttps.map(Work => GetUrl(Work, 'http')), Options, Run)
  } catch {
    return Results
  }

  for (const Work of FailedHttps) {
    const Host = ParkingHost(HttpResults.get(GetUrl(Work, 'http')) ?? null)
    if (Host) {
      Results.push(BuildDirectParkingResult(Work, Host))
    }
  }

  return Results
}