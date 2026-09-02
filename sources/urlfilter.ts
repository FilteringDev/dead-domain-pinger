import { SimpleSecureReq } from '@typescriptprime/securereq'
import * as Punycode from 'node:punycode'
import * as Zod from 'zod'

export const UrlFilterCheckDomainsUrl = 'https://urlfilter.adtidy.org/v2/checkDomains'

const DefaultRequestTimeoutMs = 30000
const MaximumAttempts = 2

const DomainCheckSchema = Zod.object({
  info: Zod.object({
    registered_domain_used_last_24_hours: Zod.boolean().optional()
  }).optional()
}).loose()

const CheckDomainsResponseSchema = Zod.record(Zod.string(), DomainCheckSchema)

export type UrlFilterResponse = {
  StatusCode: number
  Headers?: Record<string, string | string[] | undefined>
  Body: unknown
}

export type UrlFilterRequest = (Url: URL, Options: {
  HttpMethod: 'POST'
  HttpHeaders: Record<string, string>
  Payload: string
  ExpectedAs: 'JSON'
  FollowRedirects: true
  MaxRedirects: number
  TimeoutMs: number
}) => Promise<UrlFilterResponse>

export type CheckDomainsOptions = {
  Domains: string[]
  Request?: UrlFilterRequest
}

function NormalizeDomainForUrlFilter(Domain: string): string {
  const AsciiDomain = Punycode.toASCII(Domain)
  return AsciiDomain.endsWith('.') ? AsciiDomain.slice(0, -1) : AsciiDomain
}

export function BuildCheckDomainsPayload(Domains: string[]): string {
  const Parameters = new URLSearchParams()
  Parameters.append('filter', 'none')

  for (const Domain of Domains) {
    Parameters.append('domain', NormalizeDomainForUrlFilter(Domain))
  }

  return Parameters.toString()
}

export function ParseRetryAfter(RetryAfter: string | undefined, Now = Date.now()): number | null {
  if (!RetryAfter) {
    return null
  }

  if (/^\d+$/.test(RetryAfter)) {
    return Number(RetryAfter) * 1000
  }

  const RetryAt = new Date(RetryAfter).getTime()
  return Number.isNaN(RetryAt) ? null : Math.max(0, RetryAt - Now)
}

function GetHeader(Response: UrlFilterResponse, Name: string): string | undefined {
  const Header = Object.entries(Response.Headers ?? {}).find(([Key]) => Key.toLowerCase() === Name.toLowerCase())?.[1]
  return Array.isArray(Header) ? Header[0] : Header
}

function Delay(DurationMs: number): Promise<void> {
  return new Promise(Resolve => setTimeout(Resolve, DurationMs))
}

async function DefaultRequest(Url: URL, Options: Parameters<UrlFilterRequest>[1]): Promise<UrlFilterResponse> {
  return await SimpleSecureReq.Request(Url, Options)
}

/** Returns only domains whose registered domain had no observed use in the last 24 hours. */
export async function FindUnusedDomains(Options: CheckDomainsOptions): Promise<string[]> {
  if (Options.Domains.length === 0) {
    return []
  }

  const Request = Options.Request ?? DefaultRequest
  const Payload = BuildCheckDomainsPayload(Options.Domains)

  for (let Attempt = 1; Attempt <= MaximumAttempts; Attempt += 1) {
    const Response = await Request(new URL(UrlFilterCheckDomainsUrl), {
      HttpMethod: 'POST',
      HttpHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      Payload,
      ExpectedAs: 'JSON',
      FollowRedirects: true,
      MaxRedirects: 3,
      TimeoutMs: DefaultRequestTimeoutMs
    })

    if (Response.StatusCode >= 200 && Response.StatusCode < 300) {
      const Checks = CheckDomainsResponseSchema.parse(Response.Body)
      return Options.Domains.filter(Domain => {
        const Check = Checks[NormalizeDomainForUrlFilter(Domain)]
        return Check?.info?.registered_domain_used_last_24_hours === false
      })
    }

    const RetryAfter = ParseRetryAfter(GetHeader(Response, 'retry-after'))
    if ((Response.StatusCode !== 429 && Response.StatusCode !== 503) || RetryAfter === null || Attempt === MaximumAttempts) {
      throw new Error(`URL Filter check failed with HTTP ${Response.StatusCode}`)
    }

    await Delay(RetryAfter)
  }

  throw new Error('URL Filter check exhausted its retry attempts')
}