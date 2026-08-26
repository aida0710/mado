import { describe, expect, it } from 'vitest'
import {
  datasetVersionIdentity,
  forbiddenWritableNamespaces,
  validateOpenLineageProfile,
} from './openlineage-schema.js'

function event() {
  return {
    eventTime: '2026-08-26T00:00:00Z',
    eventType: 'COMPLETE',
    run: { runId: '5ee8b5a8-d32d-47f0-b119-5449286a6401', facets: {} },
    job: { namespace: 'speech', name: 'curate', facets: {} },
    inputs: [{
      namespace: 'shared', name: 'raw',
      facets: { version: { datasetVersion: 'raw-v1' } },
    }],
    outputs: [{
      namespace: 'speech', name: 'clean',
      facets: { version: { datasetVersion: 'clean-v1' } },
    }],
    producer: 'https://example.test/producer',
    schemaURL: 'https://openlineage.io/spec/2-0-2/OpenLineage.json',
  }
}

describe('OpenLineage Registry profile', () => {
  it('standard version facetをversion identityとして使う', () => {
    const parsed = validateOpenLineageProfile(event())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(datasetVersionIdentity(parsed.event.outputs[0])).toBe('clean-v1')
  })

  it('custom facetのRegistry UUIDも受け付ける', () => {
    const value = event()
    value.outputs[0].facets = {
      datasetRegistry: { datasetVersionId: '32c6440d-57e6-435d-bda4-bf2eb6a666eb' },
    }
    expect(validateOpenLineageProfile(value).ok).toBe(true)
  })

  it('version identityのない通常Datasetを拒否する', () => {
    const value = event()
    value.inputs[0].facets = {}
    const parsed = validateOpenLineageProfile(value)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues[0].path).toBe('inputs.0')
  })

  it('external-sourceはversionなしでよい', () => {
    const value = event()
    value.inputs[0] = { namespace: 'external-source', name: 'vendor', facets: {} }
    expect(validateOpenLineageProfile(value).ok).toBe(true)
  })

  it('jobとoutputだけを事前write認可し、inputはRegistryで既存判定する', () => {
    const parsed = validateOpenLineageProfile(event())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(forbiddenWritableNamespaces(parsed.event, ['speech'])).toEqual([])
    expect(forbiddenWritableNamespaces(parsed.event, ['other'])).toEqual(['speech'])
  })
})
