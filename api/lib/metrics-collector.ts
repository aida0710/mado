// /api/mado/metrics/<領域> へ載せる値の型。collectorを1つ足せば新しい領域のmetricsを公開できる。

export interface MetricSample {
  labels: Record<string, string>
  /** PostgreSQLのBIGINTは精度を落とさないよう10進文字列のまま渡す。 */
  value: number | string
}

export interface MetricFamily {
  name: string
  help: string
  type: 'gauge' | 'counter'
  samples: MetricSample[]
}

export interface MetricsCollector {
  /** `/api/mado/metrics/<name>` のpathになる。画面やコードで既に使っている領域名を使う (例: capacity)。 */
  name: string
  collect(): Promise<MetricFamily[]>
}
