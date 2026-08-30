import { expect, test } from 'vitest'
import { AreDomainsRelated, EvaluateMeasurement, IsRegistrableDomainRoot } from '../sources/verdict.ts'
import type { GlobalpingMeasurement, GlobalpingProbeResult } from '../sources/globalping.ts'

function Measurement(...Results: Partial<GlobalpingProbeResult>[]): GlobalpingMeasurement {
  return {
    status: 'finished',
    results: Results.map(Result => ({ result: { status: 'finished', ...Result } as GlobalpingProbeResult }))
  }
}

test('AreDomainsRelated compares registrable domains', () => {
  expect(AreDomainsRelated('sub.example.com', 'example.com')).toBeTruthy()
  expect(AreDomainsRelated('www.example.co.kr', 'shop.example.co.kr')).toBeTruthy()
  expect(AreDomainsRelated('example.com', 'example.org')).toBe(false)
  expect(AreDomainsRelated('example.co.kr', 'other.co.kr')).toBe(false)
})

test('IsRegistrableDomainRoot excludes subdomains', () => {
  expect(IsRegistrableDomainRoot('example.com')).toBe(true)
  expect(IsRegistrableDomainRoot('www.example.com')).toBe(false)
})

test('A redirect to a different registrable domain is dead', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 301,
    resolvedAddress: '1.2.3.4',
    headers: { location: 'https://example.org/' }
  }))

  expect(Result.Verdict).toBe('Dead')
  expect(Result.SameDomainRedirects).toEqual([])
  expect(Result.Warnings.some(Warning => Warning.includes('example.org'))).toBeTruthy()
})

test('A redirect inside the same registrable domain is detected and kept', () => {
  const Result = EvaluateMeasurement('sub.example.com', Measurement({
    statusCode: 301,
    resolvedAddress: '1.2.3.4',
    headers: { location: 'https://example.com/' }
  }))

  expect(Result.Verdict).not.toBe('Dead')
  expect(Result.SameDomainRedirects).toEqual(['example.com'])
  expect(Result.Warnings).toEqual([])
})

test('A relative redirect is not treated as a redirect', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 302,
    resolvedAddress: '1.2.3.4',
    headers: { location: '/new-path' }
  }))

  expect(Result.Verdict).not.toBe('Dead')
  expect(Result.SameDomainRedirects).toEqual([])
  expect(Result.Warnings).toEqual([])
})

test('A failed TLS certificate validation is dead and warns', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    tls: { authorized: false, error: 'certificate has expired' }
  }))

  expect(Result.Verdict).toBe('Dead')
  expect(Result.Reason.includes('TLS')).toBeTruthy()
  expect(Result.Warnings.some(Warning => Warning.includes('plain HTTP'))).toBeTruthy()
})

test('A TLS error reported only in the raw output is dead', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    rawOutput: 'Error: CERT_HAS_EXPIRED'
  }))

  expect(Result.Verdict).toBe('Dead')
})

test('A TLS handshake error reported in raw output is dead', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    rawOutput: 'Error: TLS handshake failed with EPROTO'
  }))

  expect(Result.Verdict).toBe('Dead')
  expect(Result.FailureKind).toBe('Tls')
})

test('A valid certificate does not trigger the TLS rule', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 200,
    resolvedAddress: '1.2.3.4',
    tls: { authorized: true }
  }))

  expect(Result.Verdict).toBe('Alive')
  expect(Result.Warnings).toEqual([])
})

test('DNS resolution failures stay dead', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: null,
    rawOutput: 'queryA ENOTFOUND example.com'
  }))

  expect(Result.Verdict).toBe('Dead')
})

test('A 2xx response stays alive', () => {
  expect(EvaluateMeasurement('example.com', Measurement({ statusCode: 200, resolvedAddress: '1.2.3.4' })).Verdict).toBe('Alive')
})

test('A timeout stays alive', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    rawOutput: 'Error: ETIMEDOUT'
  }))

  expect(Result.Verdict).toBe('Alive')
})

test('An empty measurement is unknown', () => {
  expect(EvaluateMeasurement('example.com', Measurement()).Verdict).toBe('Unknown')
})
