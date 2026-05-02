import { z } from 'zod'

// どちらのシークレットも 64 桁の16進数 (32 バイトのエントロピー) が必須。
// `openssl rand -hex 32` で生成できる。
const hex32 = (name: string) =>
  z.string().regex(/^[0-9a-fA-F]{64}$/, `${name} must be 64 hex chars (32 bytes)`)

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL_RW: z.string().min(1),
  DATABASE_URL_RO: z.string().min(1),
  DATABASE_URL_RW_TEST: z.string().optional(),
  WRITE_TOKEN: hex32('WRITE_TOKEN'),
  ENCRYPTION_KEY: hex32('ENCRYPTION_KEY'),
  // CSRF 防御: /api/internal/* の write 系で許容する Origin (カンマ区切り)。
  // 例: dev = "http://localhost:5173"、prod = "http://lab-server"。
  // 設定漏れを早期検知するため必須化 (default なし)。
  ALLOWED_ORIGINS: z.string().min(1).transform(s =>
    s.split(',').map(o => o.trim()).filter(Boolean)
  ),
  PREVIEW_TEXT_LIMIT: z.coerce.number().default(65536),
  PREVIEW_TAR_ENTRY_LIMIT: z.coerce.number().default(200),
  PREVIEW_TARXZ_BYTE_LIMIT: z.coerce.number().default(268435456),
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
