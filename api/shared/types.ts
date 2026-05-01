import { z } from 'zod'

// `exit_code` exists on the DB row but is intentionally excluded from this
// public contract: the spec's response example (and the front-end's card
// rendering) only consume the four fields below. Surface it when there is
// a UI need.
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
