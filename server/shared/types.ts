import { z } from 'zod'

export const HpcMetricSchema = z.object({
  host: z.string(),
  command: z.string(),
  output: z.string(),
  collected_at: z.string(), // ISO 8601
})
export type HpcMetric = z.infer<typeof HpcMetricSchema>

export const HpcResponseSchema = z.array(HpcMetricSchema)
export type HpcResponse = z.infer<typeof HpcResponseSchema>
