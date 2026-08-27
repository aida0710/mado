// api/internal.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadEnv } from './env.js'
import { createPools, closePools } from './db.js'
import { createCrypto } from './crypto.js'
import { createStorageFactory } from './storage.js'
import { requireSafeOrigin } from './lib/originCheck.js'
import { requireCapability } from './lib/capabilityGuard.js'
import type { Capability } from './storage.js'
import { explainStorageError } from './lib/storageError.js'
import { mountStorageListRoutes } from './routes/storage-list.js'
import { createResponseCache } from './lib/storage-cache.js'
import { createJobStore } from './lib/jobs.js'
import { mountJobRoutes } from './routes/jobs.js'
import { mountStorageScanRoutes } from './routes/storage-scan.js'
import { mountStorageEstimateRoutes } from './routes/storage-estimate.js'
import { mountPricingRoutes } from './routes/pricing.js'
import { createPricingStore } from './lib/pricing-store.js'
import { mountStorageReadmeRoutes } from './routes/storage-readme.js'
import { mountStoragePreviewRoutes } from './routes/storage-preview.js'
import { mountStorageMediaRoutes } from './routes/storage-media.js'
import { mountStorageFavoritesRoutes } from './routes/storage-favorites.js'
import { mountConnectionsRoutes } from './routes/connections.js'
import { mountNotesRoutes } from './routes/notes.js'
import { mountStorageTagsRoutes } from './routes/storage-tags.js'
import { mountSettingsRoutes } from './routes/settings.js'
import { createAuthStore } from './lib/auth-store.js'
import { createAuditWriter } from './lib/audit.js'
import { auditActivity } from './lib/audit-activity.js'
import { createServiceAccountStore } from './lib/auth-api-keys.js'
import { createOidcProvider } from './lib/auth-oidc.js'
import { requirePasswordChangeComplete, requireSession } from './lib/auth-middleware.js'
import { requirePermission } from './lib/rbac.js'
import { mountAuthRoutes } from './routes/auth.js'
import { mountAdminUsersRoutes } from './routes/admin-users.js'
import { mountServiceAccountRoutes } from './routes/service-accounts.js'
import { mountAuditRoutes } from './routes/audit.js'
import { createRegistryClient } from './lib/registry-client.js'
import { createMarquezClient } from './lib/marquez-client.js'
import { createLineageService, type StorageBindingResolver } from './lib/lineage-service.js'
import { mountLineageRoutes } from './routes/lineage.js'
import { mountLineageCurationRoutes } from './routes/lineage-curation.js'

// LAN ダッシュボード: 1 つのストリーム teardown 起因の未捕捉例外で全ユーザーの
// リクエストを巻き添えにしない。root cause は都度直す前提の最後の砦 (ログは大声で)。
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION (kept alive)', err))
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION (kept alive)', err))

const env = loadEnv()
const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })
const crypto = createCrypto(env.ENCRYPTION_KEY)
const storageFactory = createStorageFactory({ pools, crypto })
const authEnabled = env.AUTH_MODE !== 'disabled'
const authStore = createAuthStore(pools.rw)
const audit = createAuditWriter(pools.rw)
const serviceAccounts = createServiceAccountStore(pools.rw)
const authCleanupTimer = authEnabled ? setInterval(() => {
  void Promise.all([
    authStore.deleteExpiredSessions(),
    pools.rw.query(
      `DELETE FROM auth_oidc_attempts
        WHERE expires_at < now() - interval '1 hour'
           OR used_at < now() - interval '1 hour'`,
    ),
  ]).catch(error => console.error('failed to clean expired auth records', error))
}, 60 * 60 * 1000) : null
authCleanupTimer?.unref()

// 応答キャッシュは書き込みを伴うので rw プールを使う。書き込み先は
// storage_response_cache の 1 テーブルのみ (spec の「ロールについての判断」)。
const responseCache = createResponseCache(pools.rw)
const jobStore = createJobStore(pools)
// 料金カタログ (同梱 → DB キャッシュ → プロセス内メモリの 3 層)。
// 取得そのものは worker の pricing.refresh ジョブが行う。
const pricingStore = createPricingStore(pools)

const app = new Hono()
app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

// Login/callbackはbrowser session確立前に到達するpublic route。write系には既存の
// Origin検証を適用し、認証を有効化したときだけ公開する。
if (authEnabled) {
  const authApi = new Hono()
  const safeOrigin = requireSafeOrigin(env.ALLOWED_ORIGINS)
  authApi.use('*', async (c, next) => {
    // AuthentikからのBack-channel logoutはbrowser Originを持たない代わりに、
    // ProviderのJWKSで署名されたlogout_tokenをhandler内で検証する。
    if (c.req.path.endsWith('/oidc/backchannel-logout')) return next()
    return safeOrigin(c, next)
  })
  const oidcEnabled = env.AUTH_MODE === 'oidc' || env.AUTH_MODE === 'hybrid'
  if (oidcEnabled && (!env.OIDC_ISSUER_URL || !env.OIDC_CLIENT_ID
      || !env.OIDC_CLIENT_SECRET || !env.OIDC_REDIRECT_URI)) {
    throw new Error('AUTH_MODE enables OIDC but OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI is incomplete')
  }
  const oidc = oidcEnabled ? createOidcProvider(pools.rw, crypto, {
    id: 'primary',
    label: env.OIDC_LABEL,
    issuerUrl: env.OIDC_ISSUER_URL!,
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET!,
    redirectUri: env.OIDC_REDIRECT_URI!,
    scopes: env.OIDC_SCOPES,
    postLogoutRedirectUri: env.OIDC_POST_LOGOUT_REDIRECT_URI,
  }) : undefined
  mountAuthRoutes(authApi, {
    store: authStore,
    audit,
    config: {
      localEnabled: env.AUTH_MODE === 'local' || env.AUTH_MODE === 'hybrid',
      session: {
        idleSeconds: env.AUTH_SESSION_IDLE_SECONDS,
        absoluteSeconds: env.AUTH_SESSION_ABSOLUTE_SECONDS,
        secure: env.AUTH_COOKIE_SECURE,
        cookieName: env.AUTH_COOKIE_SECURE ? '__Host-mado_session' : 'mado_session',
      },
      oidc,
      oidcProvisioning: {
        autoLinkVerifiedEmail: env.OIDC_AUTO_LINK_VERIFIED_EMAIL,
        allowedGroups: env.OIDC_ALLOWED_GROUPS,
        roleMapping: env.OIDC_ROLE_MAPPING_JSON,
        defaultRole: env.OIDC_DEFAULT_ROLE,
      },
    },
  })
  app.route('/api/auth', authApi)
}

const api = new Hono()
api.use('*', requireSafeOrigin(env.ALLOWED_ORIGINS))
if (authEnabled) {
  api.use('*', requireSession(authStore, {
    idleSeconds: env.AUTH_SESSION_IDLE_SECONDS,
    cookieName: env.AUTH_COOKIE_SECURE ? '__Host-mado_session' : 'mado_session',
  }))
  // 認証済みrequestの拒否・失敗も残せるよう、権限checkより先に監査する。
  api.use('*', auditActivity(audit))
  api.use('*', requirePasswordChangeComplete())
  // すべてのbuilt-in roleが持つbaseline。Roleなしuserへの意図しない公開を防ぐ。
  api.use('*', requirePermission('storage:read'))

  // 既存routeのmethod単位RBAC。connection capabilityとは別の「誰が操作できるか」。
  api.on('POST', '/connections', requirePermission('connections:manage'))
  api.on(['PUT', 'DELETE'], '/connections/:id', requirePermission('connections:manage'))
  api.on('PUT', '/connections/:id/default', requirePermission('connections:manage'))
  api.on('PUT', '/notes/:slug', requirePermission('content:write'))
  api.on('PUT', '/storage/:connId/readme', requirePermission('content:write'))
  api.on('POST', '/tags', requirePermission('content:write'))
  api.on(['PUT', 'DELETE'], '/tags/:id', requirePermission('content:write'))
  api.on(['PUT', 'DELETE'], '/storage/:connId/favorites/:bucket', requirePermission('content:write'))
  api.on(['PUT', 'DELETE'], '/storage/:connId/tags', requirePermission('content:write'))
  api.on('PUT', '/settings/:key', requirePermission('settings:manage'))
  api.on('POST', '/storage/:connId/scan', requirePermission('jobs:operate'))
  api.on('POST', '/pricing/refresh', requirePermission('jobs:operate'))
  api.on('POST', '/jobs/:id/cancel', requirePermission('jobs:operate'))
  api.use('/lineage/*', requirePermission('lineage:read'))
}

// 接続ごとの権限ガード。「どのエンドポイントがどの権限に属するか」をここ 1 箇所に
// 集約する (ルートハンドラ側には権限の知識を持たせない)。
// Hono は登録順に実行するので、必ずルートの mount より前に登録すること。
const cap = (k: Capability) => requireCapability(k, storageFactory.getConnectionConfig)
api.use('/storage/:connId/buckets',           cap('list'))
api.use('/storage/:connId/list',              cap('list'))
api.use('/storage/:connId/preview/text',      cap('preview'))
api.use('/storage/:connId/preview/image',     cap('preview'))
api.use('/storage/:connId/preview/audio',     cap('preview'))
api.use('/storage/:connId/preview/raw',       cap('download'))
api.use('/storage/:connId/preview/tar',       cap('archive'))
api.use('/storage/:connId/preview/tar-entry', cap('archive'))
api.use('/storage/:connId/media/analyze',     cap('audioInfo'))
api.use('/storage/:connId/media/spectrogram', cap('audioSpectrogram'))
// README は同じパスで GET = 読み込み / PUT = 編集。メソッドごとに権限が違う。
api.on('GET', '/storage/:connId/readme',      cap('readmeRead'))
api.on('PUT', '/storage/:connId/readme',      cap('readmeWrite'))
api.use('/storage/:connId/readme/history',    cap('readmeRead'))
api.use('/storage/:connId/readme/history/:id', cap('readmeRead'))
api.use('/storage/:connId/readmes/search',    cap('readmeRead'))

mountConnectionsRoutes(api, {
  pools,
  crypto,
  invalidate: (id: string) => {
    storageFactory.invalidate(id)
    // endpoint や list_objects_version が変われば応答が変わるので、
    // この接続の一覧キャッシュは全部捨てる。await しないのは既存の
    // invalidate が同期シグネチャのため (失敗は内部でログ済み)。
    void responseCache.invalidateConnection(id)
  },
})
mountStorageListRoutes(api, {
  getStorage: storageFactory.getStorage,
  getConnectionConfig: storageFactory.getConnectionConfig,
  cache: responseCache,
})
mountStorageReadmeRoutes(api, { getStorage: storageFactory.getStorage, pools, cache: responseCache })
mountStoragePreviewRoutes(api, { getStorage: storageFactory.getStorage, env })
mountStorageMediaRoutes(api, {
  getStorage: storageFactory.getStorage,
  pools,
  env,
})
mountJobRoutes(api, { store: jobStore })
mountStorageScanRoutes(api, { store: jobStore, getConnectionConfig: storageFactory.getConnectionConfig })
// 見積もりは S3 を叩かないので cap() のガードには載せない (上のコメント参照)。
mountStorageEstimateRoutes(api, { pools, store: jobStore, pricing: pricingStore })
mountPricingRoutes(api, { pools, store: jobStore, pricing: pricingStore })
mountStorageFavoritesRoutes(api, { pools })
mountSettingsRoutes(api, { pools })
mountNotesRoutes(api, { pools })
mountStorageTagsRoutes(api, { pools })

if (env.DATASET_REGISTRY_URL && env.DATASET_REGISTRY_TOKEN && env.MARQUEZ_URL) {
  const registry = createRegistryClient({
    baseUrl: env.DATASET_REGISTRY_URL,
    token: env.DATASET_REGISTRY_TOKEN,
  })
  const marquez = createMarquezClient({ baseUrl: env.MARQUEZ_URL })
  const bindings: StorageBindingResolver = {
    async resolve(keys) {
      if (keys.length === 0) return new Map()
      const result = await pools.ro.query<{
        registry_storage_system_key: string
        connection_id: string
      }>(
        `SELECT registry_storage_system_key, connection_id
           FROM lineage_storage_bindings
          WHERE registry_storage_system_key = ANY($1::text[])`,
        [[...keys]],
      )
      return new Map(result.rows.map(row => [row.registry_storage_system_key, row.connection_id]))
    },
    async keyForConnection(connectionId) {
      const result = await pools.ro.query<{ registry_storage_system_key: string }>(
        `SELECT registry_storage_system_key
           FROM lineage_storage_bindings
          WHERE connection_id = $1`,
        [connectionId],
      )
      return result.rows[0]?.registry_storage_system_key ?? null
    },
  }
  mountLineageRoutes(api, { service: createLineageService({ registry, marquez, bindings }) })
  if (authEnabled) {
    mountLineageCurationRoutes(api, { registry, pool: pools.ro, audit })
  }
} else {
  api.all('/lineage/*', c => c.json({ error: 'lineage integration is not configured' }, 503))
}

if (authEnabled) {
  mountAdminUsersRoutes(api, { store: authStore, audit })
  mountServiceAccountRoutes(api, { store: serviceAccounts, audit })
  mountAuditRoutes(api, { pool: pools.ro })
}

app.route('/api/internal', api)

// 未 catch のエラーをユーザフレンドリーに翻訳する。S3 系は 502 + 短い説明、
// それ以外は内部 error をログに出して 500 + "internal error" だけ返す
// (raw error.message を漏らさない)。
app.onError((err, c) => {
  const explained = explainStorageError(err)
  if (explained) {
    return c.json({ error: explained.message }, explained.status)
  }
  console.error('unhandled error', err)
  return c.json({ error: 'internal error' }, 500)
})

const server = serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(
    `internal listening on http://localhost:${info.port}; ` +
    `allowed origins: ${env.ALLOWED_ORIGINS.join(', ')}`,
  )
})

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  if (authCleanupTimer) clearInterval(authCleanupTimer)
  setTimeout(() => process.exit(1), 10_000).unref()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await storageFactory.close()
  await closePools(pools)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export { app, pools, storageFactory }
