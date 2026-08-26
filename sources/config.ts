import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Zod from 'zod'

export const GlobalpingConfigFileName = 'dead-domain-pinger-config.json'

const LocationSchema = Zod.object({}).catchall(Zod.unknown())

const ConfigSchema = Zod.object({
  locations: Zod.array(LocationSchema).min(1).optional(),
  limit: Zod.number().int().positive().max(500).optional()
}).strict()

export type GlobalpingLocation = Zod.infer<typeof LocationSchema>

export type GlobalpingConfig = {
  Locations: GlobalpingLocation[]
  Limit: number
}

const EyeballNetworkTag = 'eyeball-network'

export const DefaultGlobalpingLocations: GlobalpingLocation[] = [
  { country: 'US', tags: [EyeballNetworkTag] },
  { continent: 'EU', tags: [EyeballNetworkTag] },
  { country: 'KR', tags: [EyeballNetworkTag] },
  { country: 'JP', tags: [EyeballNetworkTag] },
  { country: 'IN', tags: [EyeballNetworkTag] }
]

export const DefaultGlobalpingLimit = 5

export function ParseGlobalpingConfig(Content: string): GlobalpingConfig {
  const Config = ConfigSchema.parse(JSON.parse(Content))

  return {
    Locations: Config.locations ?? DefaultGlobalpingLocations,
    Limit: Config.limit ?? DefaultGlobalpingLimit
  }
}

export function LoadGlobalpingConfig(WorkingDirectory: string): GlobalpingConfig {
  const ConfigPath = Path.resolve(WorkingDirectory, GlobalpingConfigFileName)

  if (!Fs.existsSync(ConfigPath)) {
    return { Locations: DefaultGlobalpingLocations, Limit: DefaultGlobalpingLimit }
  }

  try {
    return ParseGlobalpingConfig(Fs.readFileSync(ConfigPath, 'utf-8'))
  } catch (ErrorValue) {
    const Detail = ErrorValue instanceof Error ? ErrorValue.message : String(ErrorValue)
    throw new Error(`Invalid ${GlobalpingConfigFileName}: ${Detail}`)
  }
}