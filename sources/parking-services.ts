import type { ParkingProvider } from './judgement-policy.ts'

const ParkingServiceHosts = new Set([
  'forsale.godaddy.com'
])

function NormalizeParkingServiceHost(Host: string): string {
  return Host.trim().toLowerCase().replace(/\.$/, '')
}

/** Whether a hostname is a known parking-service redirect target. */
export function IsParkingServiceHost(Host: string): boolean {
  const NormalizedHost = NormalizeParkingServiceHost(Host)
  return [...ParkingServiceHosts].some(ParkingHost => {
    return NormalizedHost === ParkingHost || NormalizedHost.endsWith('.' + ParkingHost)
  })
}

/** Conservative provider-owned fingerprints found in Globalping's HTTP response body. */
export function GetParkingBodyProviders(Body: string): ParkingProvider[] {
  const Normalized = Body.toLowerCase()
  const Providers: ParkingProvider[] = []
  const HasLifecycleLanguage = [
    'domain is for sale',
    'buy this domain',
    'domain has expired',
    'domain is parked',
    'parked domain'
  ].some(Marker => Normalized.includes(Marker))

  if (Normalized.includes('forsale.godaddy.com')) {
    Providers.push('godaddy')
  }
  if (Normalized.includes('sedoparking.com')) {
    Providers.push('sedo')
  }
  if (
    (Normalized.includes('bodis.com') || Normalized.includes('bodisparking.com'))
    && HasLifecycleLanguage
  ) {
    Providers.push('bodis')
  }
  if (
    Normalized.includes('hugedomains.com/domain_profile.cfm')
    || (Normalized.includes('hugedomains.com') && HasLifecycleLanguage)
  ) {
    Providers.push('hugeDomains')
  }
  if (Normalized.includes('parkingpage.namecheap.com') || Normalized.includes('namecheap parking page')) {
    Providers.push('namecheap')
  }

  return Providers
}
