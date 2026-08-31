export class MarquezClientError extends Error {
  constructor(
    message: string,
    readonly code: 'upstream' | 'timeout' | 'invalid_response' | 'not_found',
  ) {
    super(message)
    this.name = 'MarquezClientError'
  }
}

export interface MarquezEdge {
  origin: string
  destination: string
}

export interface MarquezGraphNode {
  id: string
  type: 'JOB' | 'DATASET'
  data: {
    id?: { namespace?: string; name?: string }
    namespace?: string
    name?: string
    updatedAt?: string | null
    latestRun?: {
      id?: string | null
      state?: string | null
      startedAt?: string | null
      endedAt?: string | null
    } | null
    [key: string]: unknown
  }
  inEdges: MarquezEdge[]
  outEdges: MarquezEdge[]
}

export interface MarquezGraphResponse {
  graph: MarquezGraphNode[]
}

export interface MarquezSearchResult {
  type: 'DATASET' | 'JOB'
  name: string
  namespace: string
  nodeId: string
  updatedAt: string | null
}

export interface MarquezSearchResponse {
  totalCount: number
  results: MarquezSearchResult[]
}

export interface MarquezClient {
  getGraph(
    root: { kind: 'dataset' | 'job'; namespace: string; name: string },
    depth: number,
  ): Promise<MarquezGraphResponse>
  search(query: { q: string; namespace?: string; limit: number }): Promise<MarquezSearchResponse>
  getJobRuns(namespace: string, name: string, limit: number): Promise<Record<string, unknown>>
}

export interface MarquezClientOptions {
  baseUrl: string
  timeoutMs?: number
  fetch?: typeof fetch
}

function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/api/v1') ? `${trimmed}/` : `${trimmed}/api/v1/`
}

export function marquezNodeId(
  kind: 'dataset' | 'job',
  namespace: string,
  name: string,
): string {
  return `${kind}:${namespace}:${name}`
}

export function createMarquezClient(options: MarquezClientOptions): MarquezClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const root = apiRoot(options.baseUrl)
  const timeoutMs = options.timeoutMs ?? 5_000

  const get = async <T>(url: URL): Promise<T> => {
    let response: Response
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const timeout = error instanceof Error && (
        error.name === 'TimeoutError' || error.name === 'AbortError'
      )
      throw new MarquezClientError(
        timeout ? 'Marquez request timed out' : 'Marquez is unavailable',
        timeout ? 'timeout' : 'upstream',
      )
    }
    if (!response.ok) {
      throw new MarquezClientError(
        `Marquez returned HTTP ${response.status}`,
        response.status === 404 ? 'not_found' : 'upstream',
      )
    }
    try {
      return await response.json() as T
    } catch {
      throw new MarquezClientError('Marquez returned invalid JSON', 'invalid_response')
    }
  }

  return {
    getGraph: (node, depth) => {
      const url = new URL('lineage', root)
      url.searchParams.set('nodeId', marquezNodeId(node.kind, node.namespace, node.name))
      url.searchParams.set('depth', String(depth))
      return get(url)
    },

    search: query => {
      const url = new URL('search', root)
      url.searchParams.set('q', query.q)
      url.searchParams.set('limit', String(query.limit))
      if (query.namespace) url.searchParams.set('namespace', query.namespace)
      return get(url)
    },

    getJobRuns: (namespace, name, limit) => {
      const url = new URL(
        `namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}/runs`,
        root,
      )
      url.searchParams.set('limit', String(limit))
      return get(url)
    },
  }
}
