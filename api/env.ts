import { z } from 'zod'

// `ENCRYPTION_KEY` は 64 桁の16進数 (32 バイトのエントロピー) が必須。
// `openssl rand -hex 32` で生成できる。
const hex32 = (name: string) =>
  z.string().regex(/^[0-9a-fA-F]{64}$/, `${name} must be 64 hex chars (32 bytes)`)

const booleanString = z.enum(['true', 'false', '1', '0'])
const roleId = z.enum(['viewer', 'curator', 'operator', 'admin'])
const oidcRoleMapping = z.string().default('{}').transform((value, ctx): Record<string, z.infer<typeof roleId>> => {
  try {
    const parsed = z.record(z.string().min(1), roleId).parse(JSON.parse(value))
    return parsed
  } catch {
    ctx.addIssue({ code: 'custom', message: 'OIDC_ROLE_MAPPING_JSON must be a JSON object mapping group names to Mado roles' })
    return z.NEVER
  }
})

const schema = z.object({
  MADO_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL_RW: z.string().min(1),
  DATABASE_URL_RO: z.string().min(1),
  DATABASE_URL_RW_TEST: z.string().optional(),
  ENCRYPTION_KEY: hex32('ENCRYPTION_KEY'),
  // CSRF 防御: /api/internal/* の write 系で許容する Origin (カンマ区切り)。
  // 例: dev = "http://localhost:5173"、prod = "http://lab-server"。
  // 設定漏れを早期検知するため必須化 (default なし)。
  // refine で「,, , 」のように空要素しか含まない値も拒否する (transform 後に長さチェック)。
  ALLOWED_ORIGINS: z.string().min(1).transform(s =>
    s.split(',').map(o => o.trim()).filter(Boolean)
  ).refine(arr => arr.length > 0, {
    message: 'ALLOWED_ORIGINS must contain at least one non-empty origin',
  }),
  PREVIEW_TEXT_LIMIT: z.coerce.number().default(65536),
  PREVIEW_TAR_ENTRY_LIMIT: z.coerce.number().default(200),
  PREVIEW_TARXZ_BYTE_LIMIT: z.coerce.number().default(268435456),
  // tar エントリ 1 つをメモリに載せる上限 (100 MB)。api/lib/media-service.ts の
  // TAR_ENTRY_MAX_BYTES と同値。片方を変えたら他方も変えること。
  PREVIEW_TAR_ENTRY_MAX_BYTES: z.coerce.number().default(104857600),
  // media-worker (波形/スペクトログラム解析) 関連。全て default 付きで
  // 既存デプロイの .env を変更せずに済む。
  MEDIA_CONCURRENCY: z.coerce.number().default(3),
  MEDIA_ANALYZE_TIMEOUT_SEC: z.coerce.number().default(300),
  MEDIA_CACHE_MAX_AGE_DAYS: z.coerce.number().default(30),
  MEDIA_SPECTROGRAM_MAX_WIDTH: z.coerce.number().default(4096),
  MEDIA_WORKER_PORT: z.coerce.number().default(3100),
  MEDIA_WORKER_URL: z.string().default('http://media-worker:3100'),

  // Browser auth。disabledは既存LAN運用から段階移行するための明示モード。
  // Internetへ公開するときはlocal/oidc/hybridのいずれかとHTTPSを必須にする。
  AUTH_MODE: z.enum(['disabled', 'local', 'oidc', 'hybrid']).default('disabled'),
  AUTH_COOKIE_SECURE: booleanString.default('false').transform(value =>
    value === 'true' || value === '1'
  ),
  AUTH_SESSION_IDLE_SECONDS: z.coerce.number().int().min(300).default(28_800),
  AUTH_SESSION_ABSOLUTE_SECONDS: z.coerce.number().int().min(3600).default(604_800),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_LABEL: z.string().min(1).default('SSO'),
  OIDC_SCOPES: z.string().min(1).default('openid email profile'),
  OIDC_POST_LOGOUT_REDIRECT_URI: z.string().url().optional(),
  OIDC_AUTO_LINK_VERIFIED_EMAIL: booleanString.default('false').transform(value =>
    value === 'true' || value === '1'
  ),
  OIDC_ALLOWED_GROUPS: z.string().default('').transform(value =>
    [...new Set(value.split(',').map(group => group.trim()).filter(Boolean))]
  ),
  OIDC_ROLE_MAPPING_JSON: oidcRoleMapping,
  OIDC_DEFAULT_ROLE: roleId.default('viewer'),

  // Dataset Registryがmetadataの正本、Marquezはread-only projection。
  // 3値が揃った場合だけinternal UIにlineage routeをmountする。
  DATASET_REGISTRY_URL: z.string().url().optional(),
  DATASET_REGISTRY_TOKEN: z.string().min(16).optional(),
  MARQUEZ_URL: z.string().url().optional(),
  LINEAGE_API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  OPENLINEAGE_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(2 * 1024 * 1024),
}).superRefine((env, ctx) => {
  if (env.MADO_ENV === 'production' && env.AUTH_MODE === 'disabled') {
    ctx.addIssue({
      code: 'custom', path: ['AUTH_MODE'],
      message: 'AUTH_MODE=disabled is forbidden when MADO_ENV=production',
    })
  }
  if ((env.AUTH_MODE === 'oidc' || env.AUTH_MODE === 'hybrid') && env.OIDC_ALLOWED_GROUPS.length === 0) {
    ctx.addIssue({
      code: 'custom', path: ['OIDC_ALLOWED_GROUPS'],
      message: 'OIDC_ALLOWED_GROUPS is required when OIDC is enabled',
    })
  }
})

export type Env = z.infer<typeof schema>

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment:\n${msg}`)
  }
  return parsed.data
}
