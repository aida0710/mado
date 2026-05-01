import { z } from 'zod'

// `exit_code` は DB 行に存在するが、パブリック契約からは意図的に除外している:
// spec のレスポンス例 (およびフロントエンドのカード描画) は以下の4フィールドのみを
// 使用する。UI で必要になったときに公開する。
export const MetricSchema = z.object({
  host: z.string(),
  command: z.string(),
  category: z.string(),
  output: z.string(),
  collected_at: z.string().datetime(),
})
export type Metric = z.infer<typeof MetricSchema>

export const MetricsResponseSchema = z.array(MetricSchema)
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>
