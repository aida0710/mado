// 一度の要求で巨大なtarを最後まで走査せず、次の要求で続きを調べる。
const MAX_HEADERS_PER_OPERATION = 10_000
const MAX_REQUESTS_PER_OPERATION = 128
const MAX_BYTES_PER_OPERATION = 32 * 1024 * 1024
const MAX_OPERATION_MS = 10_000

export class TarScanPendingError extends Error {
  constructor() { super('tar index is still being prepared'); this.name = 'TarScanPendingError' }
}

export class TarScanBudget {
  readonly timeout = AbortSignal.timeout(MAX_OPERATION_MS)
  private headers = 0
  private requests = 0
  private bytes = 0

  header(): void {
    if (this.headers >= MAX_HEADERS_PER_OPERATION || this.timeout.aborted) throw new TarScanPendingError()
    this.headers++
  }

  request(length: number): void {
    if (this.requests >= MAX_REQUESTS_PER_OPERATION || this.bytes + length > MAX_BYTES_PER_OPERATION || this.timeout.aborted) {
      throw new TarScanPendingError()
    }
    this.requests++
    this.bytes += length
  }
}
