import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'
import { resolveStorageOrFail, type GetStorage } from './_connId.js'

// GET/PUT はどちらも意図的に認証なし。`editor` は自己申告制 (オナーシステム)。
// 防御は LAN 境界に委ねる (このハンドラではない)。
// 脅威モデルを確認せずに Bearer ミドルウェアを追加しないこと。

export interface StorageReadmeDeps {
  getStorage: GetStorage
  pools: Pools
}

const PutBody = z.object({
  bucket: z.string().min(1),
  prefix: z.string(),       // '' (ルート) または '/' で終わる
  body: z.string(),
  editor: z.string().min(1),
})

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

export function mountStorageReadmeRoutes(app: Hono, deps: StorageReadmeDeps): void {
  app.get('/storage/:connId/readme', async c => {
    const r = await resolveStorageOrFail(c, deps.getStorage)
    if (r instanceof Response) return r
    const storage = r
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''
    const Key = prefix + 'README.md'

    // S3 GetObject と meta SELECT を並列に実行する (元は S3 → 成功時のみ DB の
    // sequential)。README が存在する prefix で 1 ラウンドトリップ分のレイテンシを
    // 削れるのと、ストレージが MinIO 等でローカル DB と同程度の RTT のときに効く。
    type MetaRow = {
      last_editor: string; last_edited_at: Date; size_bytes: number | null
    }
    const metaQuery = deps.pools.ro.query<MetaRow>(
      `SELECT last_editor, last_edited_at, size_bytes
         FROM storage_readme_meta
         WHERE connection_id=$1 AND bucket=$2 AND prefix=$3`,
      [connId, bucket, prefix]
    )
    const s3Promise = storage
      .send(new GetObjectCommand({ Bucket: bucket, Key }))
      .then(out => streamToString(out.Body as unknown as NodeJS.ReadableStream))
      .then(body => ({ kind: 'ok' as const, body }))
      .catch((e: unknown) => {
        if (e instanceof NoSuchKey) return { kind: 'absent' as const }
        throw e
      })
    const [s3Result, metaResult] = await Promise.all([s3Promise, metaQuery])
    if (s3Result.kind === 'absent') return c.json({ exists: false })
    const body = s3Result.body
    const m = metaResult.rows[0]
    return c.json({
      exists: true,
      body,
      last_editor: m?.last_editor ?? null,
      last_edited_at: m?.last_edited_at?.toISOString() ?? null,
      size_bytes: m?.size_bytes ?? Buffer.byteLength(body, 'utf-8'),
    })
  })

  app.put('/storage/:connId/readme', async c => {
    const r = await resolveStorageOrFail(c, deps.getStorage)
    if (r instanceof Response) return r
    const storage = r
    const connId = c.req.param('connId')
    const parsed = PutBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400)
    }
    const { bucket, prefix, body, editor } = parsed.data
    const Key = prefix + 'README.md'
    const buf = Buffer.from(body, 'utf-8')

    try {
      await storage.send(new PutObjectCommand({
        Bucket: bucket, Key, Body: buf, ContentType: 'text/markdown',
      }))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }

    // Storage PUT 成功。続けて history (append) と meta (upsert) を 1 トランザクションで
    // 同期させる。両方落ちたときも同じ状態 (rollback) になり、片方だけが残る
    // 中間状態を避ける。DB 失敗時でも README 本体は既に S3 にあるので 200 を返し、
    // meta_stale: true でフロントが警告を出せるようにする。
    const client = await deps.pools.rw.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO storage_readme_history(connection_id, bucket, prefix, body, size_bytes, editor)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [connId, bucket, prefix, body, buf.byteLength, editor]
      )
      await client.query(
        `INSERT INTO storage_readme_meta(connection_id, bucket, prefix, last_editor, last_edited_at, size_bytes)
         VALUES($1,$2,$3,$4, now(), $5)
         ON CONFLICT (connection_id, bucket, prefix) DO UPDATE
           SET last_editor    = EXCLUDED.last_editor,
               last_edited_at = EXCLUDED.last_edited_at,
               size_bytes     = EXCLUDED.size_bytes`,
        [connId, bucket, prefix, editor, buf.byteLength]
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      console.error(JSON.stringify({
        ev: 'storage.readme.meta_failed',
        connId, bucket, prefix, editor,
        error: (e as Error).message,
      }))
      client.release()
      return c.json({ ok: true, meta_stale: true, size_bytes: buf.byteLength })
    }
    client.release()

    return c.json({ ok: true, size_bytes: buf.byteLength })
  })

  // 編集履歴 (path 単位)。
  // GET /storage/:connId/readme/history?bucket=&prefix=&limit=
  // ?prefix は GET /storage/:connId/readme と同じセマンティクスで '' (= バケット直下) も許容。
  app.get('/storage/:connId/readme/history', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''
    const limitRaw = parseInt(c.req.query('limit') ?? '50', 10)
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 200))
    const r = await deps.pools.ro.query<{
      id: string; editor: string; edited_at: Date; size_bytes: number
    }>(
      `SELECT id, editor, edited_at, size_bytes
         FROM storage_readme_history
         WHERE connection_id=$1 AND bucket=$2 AND prefix=$3
         ORDER BY edited_at DESC, id DESC
         LIMIT $4`,
      [connId, bucket, prefix, limit]
    )
    return c.json({
      versions: r.rows.map(row => ({
        id: Number(row.id),
        editor: row.editor,
        edited_at: row.edited_at.toISOString(),
        size_bytes: row.size_bytes,
      })),
    })
  })

  // 特定版の本文を返す。
  // GET /storage/:connId/readme/history/:id
  app.get('/storage/:connId/readme/history/:id', async c => {
    const connId = c.req.param('connId')
    const id = c.req.param('id')
    if (!/^\d+$/.test(id)) return c.json({ error: 'id must be integer' }, 400)
    const r = await deps.pools.ro.query<{
      bucket: string; prefix: string; body: string;
      editor: string; edited_at: Date; size_bytes: number
    }>(
      `SELECT bucket, prefix, body, editor, edited_at, size_bytes
         FROM storage_readme_history
         WHERE id=$1 AND connection_id=$2`,
      [id, connId]
    )
    if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
    const row = r.rows[0]
    return c.json({
      id: Number(id),
      bucket: row.bucket,
      prefix: row.prefix,
      body: row.body,
      editor: row.editor,
      edited_at: row.edited_at.toISOString(),
      size_bytes: row.size_bytes,
    })
  })

  // 接続内の README 全本文に対するカジュアル全文検索 (現在版のみ対象)。
  // GET /storage/:connId/readmes/search?q=...&limit=50
  // pg_trgm の gin_trgm_ops index で LIKE '%q%' が高速。日本語も bigram で
  // 動く (完璧ではないが lab 規模では実用的)。
  app.get('/storage/:connId/readmes/search', async c => {
    const connId = c.req.param('connId')
    const q = (c.req.query('q') ?? '').trim()
    if (q.length < 2) return c.json({ error: 'q must be at least 2 chars' }, 400)
    const limitRaw = parseInt(c.req.query('limit') ?? '50', 10)
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 200))

    // 「現在版だけを検索対象に」: 古い版に文字列が含まれていても、最新版に
    // 無ければヒットさせない。DISTINCT ON で先に最新版を全部取り、外側で
    // ILIKE をかける (WHERE を先に効かせると古い版が拾われる)。
    // id DESC を tiebreaker に置く: 同一 transaction で複数 INSERT して
    // edited_at が同値になっても、より大きい id (= 後の INSERT) が最新扱い。
    const r = await deps.pools.ro.query<{
      bucket: string; prefix: string; editor: string;
      edited_at: Date; size_bytes: number
    }>(
      `SELECT bucket, prefix, editor, edited_at, size_bytes FROM (
         SELECT DISTINCT ON (bucket, prefix)
                bucket, prefix, body, editor, edited_at, size_bytes
           FROM storage_readme_history
           WHERE connection_id = $1
           ORDER BY bucket, prefix, edited_at DESC, id DESC
       ) latest
       WHERE body ILIKE '%' || $2 || '%'
       ORDER BY edited_at DESC
       LIMIT $3`,
      [connId, q, limit]
    )
    return c.json({
      hits: r.rows.map(row => ({
        bucket: row.bucket,
        prefix: row.prefix,
        editor: row.editor,
        edited_at: row.edited_at.toISOString(),
        size_bytes: row.size_bytes,
      })),
    })
  })
}
