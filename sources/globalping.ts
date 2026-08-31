import { SimpleSecureReq } from '@typescriptprime/securereq'
import * as Zod from 'zod'
import type { GlobalpingLocation } from './config.ts'
import type { ProbeProtocol } from './types.ts'

export const GlobalpingApiBaseUrl = 'https://api.globalping.io/v1'

export const DefaultMaxCandidates = 50

const MeasurementPollIntervalMs = 1500
const MeasurementTimeoutMs = 60000
const RequestTimeoutMs = 30000

const CreatedMeasurementSchema = Zod.object({
  id: Zod.string().nonempty()
}).loose()

const MeasurementSchema = Zod.object({
  status: Zod.string(),
  results: Zod.array(Zod.object({
    result: Zod.object({
      status: Zod.string().optional(),
      statusCode: Zod.number().nullish(),
      resolvedAddress: Zod.string().nullish(),
      rawOutput: Zod.string().nullish(),
      rawHeaders: Zod.string().nullish(),
      rawBody: Zod.string().nullish(),
      truncated: Zod.boolean().nullish(),
      failureSource: Zod.enum(['target', 'resolver', 'internal']).nullish(),
      headers: Zod.record(Zod.string(), Zod.union([Zod.string(), Zod.array(Zod.string())])).nullish(),
      tls: Zod.object({
        authorized: Zod.boolean().nullish(),
        error: Zod.string().nullish(),
        authorizationError: Zod.string().nullish()
      }).loose().nullish()
    }).loose()
  }).loose()).default([])
}).loose()

export type GlobalpingMeasurement = Zod.infer<typeof MeasurementSchema>
export type GlobalpingProbeResult = GlobalpingMeasurement['results'][number]['result']

export type GlobalpingProbeOptions = {
  Target: string
  Protocol: ProbeProtocol
  Locations: GlobalpingLocation[]
  Limit: number
  ApiToken: string
}

export class GlobalpingRateLimitError extends Error {
  constructor(Message: string) {
    super(Message)
    this.name = 'GlobalpingRateLimitError'
  }
}

function Delay(DurationMs: number): Promise<void> {
  return new Promise(Resolve => setTimeout(Resolve, DurationMs))
}

export function BuildMeasurementPayload(Options: GlobalpingProbeOptions): string {
  return JSON.stringify({
    type: 'http',
    target: Options.Target,
    locations: Options.Locations,
    limit: Options.Limit,
    inProgressUpdates: false,
    measurementOptions: {
      protocol: Options.Protocol,
      request: { method: 'GET', path: '/' }
    }
  })
}

async function CreateMeasurement(Options: GlobalpingProbeOptions): Promise<string> {
  const Payload = BuildMeasurementPayload(Options)

  const Response = await SimpleSecureReq.Request(new URL(`${GlobalpingApiBaseUrl}/measurements`), {
    HttpMethod: 'POST',
    HttpHeaders: {
      'content-type': 'application/json',
      authorization: `Bearer ${Options.ApiToken}`
    },
    Payload,
    ExpectedAs: 'JSON',
    FollowRedirects: true,
    MaxRedirects: 3,
    TimeoutMs: RequestTimeoutMs
  })

  if (Response.StatusCode === 429) {
    throw new GlobalpingRateLimitError('Globalping rate limit reached while creating a measurement')
  }

  if (Response.StatusCode < 200 || Response.StatusCode >= 300) {
    throw new Error(`Globalping measurement creation failed with HTTP ${Response.StatusCode}`)
  }

  return CreatedMeasurementSchema.parse(Response.Body).id
}

async function FetchMeasurement(MeasurementId: string, ApiToken: string): Promise<GlobalpingMeasurement> {
  const Response = await SimpleSecureReq.Request(new URL(`${GlobalpingApiBaseUrl}/measurements/${MeasurementId}`), {
    HttpMethod: 'GET',
    HttpHeaders: { authorization: `Bearer ${ApiToken}` },
    ExpectedAs: 'JSON',
    FollowRedirects: true,
    MaxRedirects: 3,
    TimeoutMs: RequestTimeoutMs
  })

  if (Response.StatusCode === 429) {
    throw new GlobalpingRateLimitError('Globalping rate limit reached while polling a measurement')
  }

  if (Response.StatusCode < 200 || Response.StatusCode >= 300) {
    throw new Error(`Globalping measurement lookup failed with HTTP ${Response.StatusCode}`)
  }

  return MeasurementSchema.parse(Response.Body)
}

/** Creates an authenticated HTTP measurement and waits for it to settle. */
export async function ProbeDomain(Options: GlobalpingProbeOptions): Promise<GlobalpingMeasurement> {
  const MeasurementId = await CreateMeasurement(Options)
  const Deadline = Date.now() + MeasurementTimeoutMs

  for (;;) {
    await Delay(MeasurementPollIntervalMs)

    const Measurement = await FetchMeasurement(MeasurementId, Options.ApiToken)
    if (Measurement.status !== 'in-progress') {
      return Measurement
    }

    if (Date.now() > Deadline) {
      throw new Error(`Globalping measurement ${MeasurementId} for ${Options.Target} did not finish in time`)
    }
  }
}
