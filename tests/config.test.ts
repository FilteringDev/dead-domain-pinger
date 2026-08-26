import test from 'node:test'
import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { DefaultGlobalpingLimit, DefaultGlobalpingLocations, GlobalpingConfigFileName, LoadGlobalpingConfig, ParseGlobalpingConfig } from '../sources/config.ts'

test('missing config uses five regional eyeball probes and limit five', () => {
  const Directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-config-'))
  const Config = LoadGlobalpingConfig(Directory)

  assert.equal(Config.Limit, DefaultGlobalpingLimit)
  assert.deepEqual(Config.Locations, DefaultGlobalpingLocations)
})

test('config values override their matching defaults independently', () => {
  const Config = ParseGlobalpingConfig(JSON.stringify({ locations: [{ country: 'DE' }] }))

  assert.deepEqual(Config.Locations, [{ country: 'DE' }])
  assert.equal(Config.Limit, DefaultGlobalpingLimit)
})

test('invalid config fails instead of silently using defaults', () => {
  assert.throws(() => ParseGlobalpingConfig('{"limit": 0}'))
  assert.throws(() => ParseGlobalpingConfig('{"limits": 5}'))
})

test('config file is read from the workspace root', () => {
  const Directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-config-'))
  Fs.writeFileSync(Path.join(Directory, GlobalpingConfigFileName), JSON.stringify({ limit: 2, locations: [{ country: 'KR' }] }))

  assert.deepEqual(LoadGlobalpingConfig(Directory), { Limit: 2, Locations: [{ country: 'KR' }] })
})