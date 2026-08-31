import { expect, test } from 'vitest'
import { IsParkingServiceHost } from '../sources/parking-services.ts'

test('GoDaddy for-sale redirects are recognized as parking', () => {
  expect(IsParkingServiceHost('forsale.godaddy.com')).toBe(true)
  expect(IsParkingServiceHost(' FORSALE.GODADDY.COM. ')).toBe(true)
})

test('Parking host matching is exact', () => {
  expect(IsParkingServiceHost('sub.forsale.godaddy.com')).toBe(false)
  expect(IsParkingServiceHost('forsale.godaddy.com.example.org')).toBe(false)
})
