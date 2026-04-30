import { z } from 'zod'

// `exit_code` exists on the DB row but is intentionally excluded from this
// public contract: the spec's response example (and the front-end's card
// rendering) only consume the four fields below. Surface it when there is
// a UI need.
export const HpcMetricSchema = z.object({
  host: z.string(),
  command: z.string(),
  output: z.string(),
  collected_at: z.string().datetime(),
})
export type HpcMetric = z.infer<typeof HpcMetricSchema>

export const HpcResponseSchema = z.array(HpcMetricSchema)
export type HpcResponse = z.infer<typeof HpcResponseSchema>
