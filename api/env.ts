import { z } from 'zod'

// Both secrets are required to be 64 hex chars (32 bytes of entropy).
// Generate either with `openssl rand -hex 32`.
const hex32 = (name: string) =>
  z.string().regex(/^[0-9a-fA-F]{64}$/, `${name} must be 64 hex chars (32 bytes)`)

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL_RW: z.string().min(1),
  DATABASE_URL_RO: z.string().min(1),
  DATABASE_URL_RW_TEST: z.string().optional(),
  WRITE_TOKEN: hex32('WRITE_TOKEN'),
  ENCRYPTION_KEY: hex32('ENCRYPTION_KEY'),
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
