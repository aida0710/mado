import { describe, expect, it, vi } from 'vitest'
import { createRegistryClient } from './registry-client.js'
import type { OpenLineageEvent } from './openlineage-schema.js'

const event = {
  eventTime: '2026-08-26T00:00:00Z',
  eventType: 'START',
  run: { runId: '5ee8b5a8-d32d-47f0-b119-5449286a6401', facets: {} },
  job: { namespace: 'speech', name: 'curate', facets: {} },
  inputs: [], outputs: [],
  producer: 'https://example.test', schemaURL: 'https://example.test/schema',
} satisfies OpenLineageEvent

describe('Registry client', () => {
  it('OpenLineageはRegistryだけへinternal credential付きで送る', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      accepted: true, duplicate: false, eventId: 'evt-1',
      runId: event.run.runId, projection: 'pending', warnings: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = createRegistryClient({
      baseUrl: 'http://registry.internal:8080', token: 'internal-secret', fetch,
    })

    await client.ingestOpenLineage(event, {
      serviceAccountId: 'sa-1', keyId: 'key-1', allowedNamespaces: ['speech'],
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('http://registry.internal:8080/v1/ingest/openlineage')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer internal-secret')
    const body = JSON.parse(String(init?.body))
    expect(body.principal.allowedNamespaces).toEqual(['speech'])
    expect(body.event.run.runId).toBe(event.run.runId)
  })

  it('dataset resolveは空ならHTTPを呼ばない', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createRegistryClient({ baseUrl: 'http://registry', token: 'secret', fetch })
    expect(await client.resolveDatasets([])).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('検索queryをURL encodeする', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      results: [], totalCount: 0,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = createRegistryClient({ baseUrl: 'http://registry', token: 'secret', fetch })
    await client.searchDatasets({ q: 'raw audio', namespace: 'speech/jp', limit: 10, offset: 20 })
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(url.pathname).toBe('/v1/search/datasets')
    expect(url.searchParams.get('q')).toBe('raw audio')
    expect(url.searchParams.get('namespace')).toBe('speech/jp')
    expect(url.searchParams.get('offset')).toBe('20')
  })

  it('StorageSystemとURIをDataset Versionへ解決する', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      uri: 's3://dataset/podcast/a.tar',
      totalCount: 1,
      matches: [{
        dataset_id: 'd1', dataset_key: 'podcast', namespace: 'speech', name: 'podcast/raw',
        display_name: 'Podcast 原本', aliases: ['podcast'], version_count: 1,
        version_id: 'v1', version: '1', version_created_at: '2026-08-26T00:00:00Z',
        location_id: 'l1', location_uri: 's3://dataset/podcast/', status: 'available',
        is_primary: true, observed_at: '2026-08-26T00:00:00Z', match_type: 'prefix',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = createRegistryClient({ baseUrl: 'http://registry', token: 'secret', fetch })

    const resolved = await client.resolveStorageLocation(
      'mdx-s3', 's3://dataset/podcast/a.tar', 10,
    )

    expect(resolved.matches[0].displayName).toBe('Podcast 原本')
    expect(resolved.matches[0].versionId).toBe('v1')
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(url.searchParams.get('storage_system_key')).toBe('mdx-s3')
    expect(url.searchParams.get('uri')).toBe('s3://dataset/podcast/a.tar')
  })

  it('既存Registryのsnake_caseをbrowser向けDTOへ正規化する', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: '32c6440d-57e6-435d-bda4-bf2eb6a666eb', dataset_key: 'raw',
      namespace: 'speech', name: 'raw', media_type: 'audio', created_at: '2026-08-26T00:00:00Z',
      versions: [{
        id: '5ee8b5a8-d32d-47f0-b119-5449286a6401',
        dataset_id: '32c6440d-57e6-435d-bda4-bf2eb6a666eb', version: 'v1',
        manifest_uri: 's3://raw/manifest.jsonl', created_at: '2026-08-26T00:00:00Z',
        locations: [{
          id: 'e210ea74-523a-45a0-9dc3-bc622a525d9b', uri: 's3://raw/',
          storage_kind: 's3', status: 'available', is_primary: true,
          observed_at: '2026-08-26T00:00:00Z', metadata: {},
        }], metadata: {},
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = createRegistryClient({ baseUrl: 'http://registry', token: 'secret', fetch })
    const detail = await client.getDataset('32c6440d-57e6-435d-bda4-bf2eb6a666eb')
    expect(detail.datasetKey).toBe('raw')
    expect(detail.mediaType).toBe('audio')
    expect(detail.versions[0].manifestUri).toBe('s3://raw/manifest.jsonl')
    expect(detail.versions[0].locations[0].isPrimary).toBe(true)
  })
})
