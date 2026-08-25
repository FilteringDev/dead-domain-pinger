import test from 'node:test'
import assert from 'node:assert/strict'
import { AreDomainsRelated, EvaluateMeasurement } from '../sources/verdict.ts'
import type { GlobalpingMeasurement, GlobalpingProbeResult } from '../sources/globalping.ts'

function Measurement(...Results: Partial<GlobalpingProbeResult>[]): GlobalpingMeasurement {
  return {
    status: 'finished',
    results: Results.map(Result => ({ result: { status: 'finished', ...Result } as GlobalpingProbeResult }))
  }
}

test('AreDomainsRelated compares registrable domains', () => {
  assert.ok(AreDomainsRelated('sub.example.com', 'example.com'))
  assert.ok(AreDomainsRelated('www.example.co.kr', 'shop.example.co.kr'))
  assert.equal(AreDomainsRelated('example.com', 'example.org'), false)
  assert.equal(AreDomainsRelated('example.co.kr', 'other.co.kr'), false)
})

test('A redirect to a different registrable domain is dead', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 301,
    resolvedAddress: '1.2.3.4',
    headers: { location: 'https://example.org/' }
  }))

  assert.equal(Result.Verdict, 'Dead')
  assert.deepEqual(Result.SameDomainRedirects, [])
  assert.ok(Result.Warnings.some(Warning => Warning.includes('example.org')))
})

test('A redirect inside the same registrable domain is detected and kept', () => {
  const Result = EvaluateMeasurement('sub.example.com', Measurement({
    statusCode: 301,
    resolvedAddress: '1.2.3.4',
    headers: { location: 'https://example.com/' }
  }))

  assert.notEqual(Result.Verdict, 'Dead')
  assert.deepEqual(Result.SameDomainRedirects, ['example.com'])
  assert.deepEqual(Result.Warnings, [])
})

test('A relative redirect is not treated as a redirect', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 302,
    resolvedAddress: '1.2.3.4',
    headers: { location: '/new-path' }
  }))

  assert.notEqual(Result.Verdict, 'Dead')
  assert.deepEqual(Result.SameDomainRedirects, [])
  assert.deepEqual(Result.Warnings, [])
})

test('A failed TLS certificate validation is dead and warns', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    tls: { authorized: false, error: 'certificate has expired' }
  }))

  assert.equal(Result.Verdict, 'Dead')
  assert.ok(Result.Reason.includes('TLS'))
  assert.ok(Result.Warnings.some(Warning => Warning.includes('plain HTTP')))
})

test('A TLS error reported only in the raw output is dead', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    rawOutput: 'Error: CERT_HAS_EXPIRED'
  }))

  assert.equal(Result.Verdict, 'Dead')
})

test('A valid certificate does not trigger the TLS rule', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 200,
    resolvedAddress: '1.2.3.4',
    tls: { authorized: true }
  }))

  assert.equal(Result.Verdict, 'Alive')
  assert.deepEqual(Result.Warnings, [])
})

test('DNS resolution failures stay dead', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: null,
    rawOutput: 'queryA ENOTFOUND example.com'
  }))

  assert.equal(Result.Verdict, 'Dead')
})

test('A 2xx response stays alive', () => {
  assert.equal(EvaluateMeasurement('example.com', Measurement({ statusCode: 200, resolvedAddress: '1.2.3.4' })).Verdict, 'Alive')
})

test('A timeout stays alive', () => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    rawOutput: 'Error: ETIMEDOUT'
  }))

  assert.equal(Result.Verdict, 'Alive')
})

test('An empty measurement is unknown', () => {
  assert.equal(EvaluateMeasurement('example.com', Measurement()).Verdict, 'Unknown')
})
