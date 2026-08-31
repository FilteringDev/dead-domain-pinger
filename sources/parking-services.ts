const ParkingServiceHosts = new Set([
  'forsale.godaddy.com'
])

function NormalizeParkingServiceHost(Host: string): string {
  return Host.trim().toLowerCase().replace(/\.$/, '')
}

/** Whether a hostname is a known parking-service redirect target. */
export function IsParkingServiceHost(Host: string): boolean {
  return ParkingServiceHosts.has(NormalizeParkingServiceHost(Host))
}
