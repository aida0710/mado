import type { MetricFamily } from './metrics-collector.js'

/** Prometheus text exposition format 0.0.4。 */
export const PROMETHEUS_TEXT_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

function formatLabels(labels: Record<string, string>): string {
  const pairs = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`
}

export function renderPrometheusText(families: MetricFamily[]): string {
  const lines: string[] = []
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`, `# TYPE ${family.name} ${family.type}`)
    for (const sample of family.samples) {
      lines.push(`${family.name}${formatLabels(sample.labels)} ${sample.value}`)
    }
  }
  // 最終行も改行で終える (exposition formatの要件)。
  lines.push('')
  return lines.join('\n')
}
