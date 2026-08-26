// 同梱カタログ (api/pricing/catalog.ts) の書き出し
// (spec: docs/superpowers/specs/2026-08-22-transfer-estimate-design.md)
//
//   cd api && npm run pricing:fetch
//
// 通常の更新は Mado の画面から (pricing.refresh ジョブ → DB キャッシュ)。
// このスクリプトが要るのは **外に出られない環境に配る同梱カタログ**を
// 新しくするときで、結果はリポジトリにコミットする。
//
// 取得ロジックそのものはジョブと共有している (lib/pricing-fetch.ts)。

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fetchCatalog } from '../lib/pricing-fetch.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'pricing', 'catalog.ts')

const HEADER = `// 料金カタログ — 生成物。手で編集しない。
//
//   cd api && npm run pricing:fetch
//
// spec: docs/superpowers/specs/2026-08-22-transfer-estimate-design.md
//
// これは **同梱の初期値でありフォールバック**であって、唯一の出所ではない。
// 通常は pricing.refresh ジョブが取得した値が pricing_cache (DB) に入り、
// そちらが使われる。ここが使われるのは、まだ一度も取得していないか、
// 外向きの通信が塞がれている環境。
//
// DEEP_ARCHIVE の storageTiers は代理値である (storageIsProxy: true)。
// AWS の料金 API に Deep Archive のストレージ単価が存在しないため、
// Intelligent-Tiering の Deep Archive Access 層の単価を使っている。

import type { PricingCatalog } from '../lib/pricing-types.js'

export const CATALOG: PricingCatalog = `

async function main(): Promise<void> {
  const catalog = await fetchCatalog({
    onProgress: msg => console.error(`${msg}…`),
  })

  await writeFile(OUT, `${HEADER}${JSON.stringify(catalog, null, 2)}\n`)

  console.error(`\n書き出した: ${OUT}`)
  console.error(`  asOf: ${catalog.asOf} / AWS 公表日: ${catalog.awsPublishedAt}`)
  for (const [code, r] of Object.entries(catalog.aws.regions)) {
    const std = r.storageClasses.STANDARD.storageTiers[0].usd
    const egress = r.egressTiers.find(t => t.usd > 0)?.usd
    console.error(`  ${code}: Standard $${std}/GB-Mo, egress $${egress}/GB (無料枠 ${r.egressFreeGb}GB)`)
  }
}

main().catch((e: Error) => {
  console.error(`\n失敗: ${e.message}`)
  process.exit(1)
})
