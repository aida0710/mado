// 外部プロセスの長い診断や入力本文をAPIへそのまま渡さない。
const MAX_STDERR_SUMMARY_CHARS = 2000

export class MediaAnalyzeError extends Error {
  readonly stderrSummary: string
  constructor(message: string, stderr: string) {
    super(message)
    this.name = 'MediaAnalyzeError'
    this.stderrSummary = stderr.slice(-MAX_STDERR_SUMMARY_CHARS)
  }
}
