import { expect, test } from 'vitest'
import { BuildMeasurementPayload } from '../sources/globalping.ts'

test('measurement payload preserves configured locations, limit, target, and protocol', () => {
  const Payload: unknown = JSON.parse(BuildMeasurementPayload({
    Target: 'www.example.com',
    Protocol: 'HTTP',
    Locations: [{ country: 'KR', tags: ['eyeball-network'] }],
    Limit: 5,
    ApiToken: 'not-used-when-building-payload'
  }))

  expect(Payload).toEqual({
    type: 'http',
    target: 'www.example.com',
    locations: [{ country: 'KR', tags: ['eyeball-network'] }],
    limit: 5,
    inProgressUpdates: false,
    measurementOptions: {
      protocol: 'HTTP',
      request: { method: 'GET', path: '/' }
    }
  })
})