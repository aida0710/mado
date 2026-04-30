import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL_RW: z.string().min(1),
  DATABASE_URL_RO: z.string().min(1),
  DATABASE_URL_RW_TEST: z.string().optional(),
  WRITE_TOKEN: z.string().min(8),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
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
