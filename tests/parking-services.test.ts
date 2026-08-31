import { expect, test } from 'vitest'
import { GetParkingBodyProviders, IsParkingServiceHost } from '../sources/parking-services.ts'

test('GoDaddy for-sale redirects are recognized as parking', () => {
  expect(IsParkingServiceHost('forsale.godaddy.com')).toBe(true)
  expect(IsParkingServiceHost(' FORSALE.GODADDY.COM. ')).toBe(true)
})

test('Parking host matching is exact', () => {
  expect(IsParkingServiceHost('sub.forsale.godaddy.com')).toBe(false)
  expect(IsParkingServiceHost('forsale.godaddy.com.example.org')).toBe(false)
})

test('provider body fingerprints are conservative and case insensitive', () => {
  expect(GetParkingBodyProviders('<a href="https://forsale.godaddy.com/x">Buy</a>')).toContain('godaddy')
  expect(GetParkingBodyProviders('<script src="https://sedoparking.com/app.js"></script>')).toContain('sedo')
  expect(GetParkingBodyProviders('Bodis.com says this DOMAIN IS FOR SALE')).toContain('bodis')
  expect(GetParkingBodyProviders('https://HugeDomains.com/domain_profile.cfm?id=1')).toContain('hugeDomains')
  expect(GetParkingBodyProviders('Welcome to the NAMECHEAP PARKING PAGE')).toContain('namecheap')
})

test('provider names alone do not trigger lifecycle-dependent fingerprints', () => {
  expect(GetParkingBodyProviders('This ordinary page mentions bodis.com')).not.toContain('bodis')
  expect(GetParkingBodyProviders('This ordinary page mentions hugedomains.com')).not.toContain('hugeDomains')
})
