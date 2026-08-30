import { expect, test } from 'vitest'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { DefaultGlobalpingLimit, DefaultGlobalpingLocations, GlobalpingConfigFileName, LoadGlobalpingConfig, ParseGlobalpingConfig } from '../sources/config.ts'

test('missing config uses five regional eyeball probes and limit five', () => {
  const Directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-config-'))
  const Config = LoadGlobalpingConfig(Directory)

  expect(Config.Limit).toBe(DefaultGlobalpingLimit)
  expect(Config.Locations).toEqual(DefaultGlobalpingLocations)
})

test('config values override their matching defaults independently', () => {
  const Config = ParseGlobalpingConfig(JSON.stringify({ locations: [{ country: 'DE' }] }))

  expect(Config.Locations).toEqual([{ country: 'DE' }])
  expect(Config.Limit).toBe(DefaultGlobalpingLimit)
})

test('invalid config fails instead of silently using defaults', () => {
  expect(() => ParseGlobalpingConfig('{"limit": 0}')).toThrow()
  expect(() => ParseGlobalpingConfig('{"limits": 5}')).toThrow()
})

test('config file is read from the workspace root', () => {
  const Directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-config-'))
  Fs.writeFileSync(Path.join(Directory, GlobalpingConfigFileName), JSON.stringify({ limit: 2, locations: [{ country: 'KR' }] }))

  expect(LoadGlobalpingConfig(Directory)).toEqual({ Limit: 2, Locations: [{ country: 'KR' }] })
})