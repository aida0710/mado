// データセットスキャンの統計集計 (純ロジック)。worker のスキャンループから
// インクリメンタルに呼ばれる。語彙は空白区切りの素朴なトークン化なので、
// 分かち書きされていない日本語では語彙統計は参考値 (文字統計は有効)。

// front/lib/api/mime.ts の classify() の audio 集合と対応させること。
export const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus',
  'm4a', 'm4b', 'aac', 'weba', 'aiff', 'aif', 'wma',
])

const TEXT_SIDECAR_EXTS = new Set(['txt', 'json'])

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

function baseOf(name: string): string {
  const e = extOf(name)
  return e ? name.slice(0, -(e.length + 1)) : name
}

export function isAudioName(name: string): boolean {
  return AUDIO_EXTS.has(extOf(name))
}

// WebDataset 規約: 同じ basename の音声 + テキストサイドカーのペア。
// 入力順を保った音声リストに対し、.txt を優先、無ければ .json を対応付ける。
export function pairWebdataset(
  names: string[],
): Array<{ audio: string; text: string | null }> {
  const textByBase = new Map<string, string>()
  for (const n of names) {
    const e = extOf(n)
    if (!TEXT_SIDECAR_EXTS.has(e)) continue
    const base = baseOf(n)
    const prev = textByBase.get(base)
    // .txt 優先
    if (!prev || (extOf(prev) === 'json' && e === 'txt')) textByBase.set(base, n)
  }
  const out: Array<{ audio: string; text: string | null }> = []
  for (const n of names) {
    if (!isAudioName(n)) continue
    out.push({ audio: n, text: textByBase.get(baseOf(n)) ?? null })
  }
  return out
}

// duration ヒストグラムのバケット上限 (秒)。最後のバケットは le=null (それ超)。
export const DURATION_BUCKET_EDGES = [1, 2, 4, 8, 15, 30, 60] as const

export interface DatasetStatsResult {
  fileCount: number
  totalDurationSec: number
  durationHistogram: Array<{ le: number | null; count: number }>
  sampleRates: Record<string, number>
  textFileCount: number
  vocabSize: number
  vocabTruncated: boolean
  charSet: number
  topWords: Array<[string, number]>
  truncated: boolean
}

export class DatasetStatsAccumulator {
  private readonly vocabLimit: number
  private fileCount = 0
  private totalDurationSec = 0
  private histogram: number[] = new Array(DURATION_BUCKET_EDGES.length + 1).fill(0)
  private sampleRates = new Map<number, number>()
  private textFileCount = 0
  private vocab = new Map<string, number>()
  private vocabTruncated = false
  private chars = new Set<string>()
  private truncated = false

  constructor(opts: { vocabLimit?: number } = {}) {
    this.vocabLimit = opts.vocabLimit ?? 100_000
  }

  addAudio(durationSec: number | null, sampleRate: number | null): void {
    this.fileCount++
    if (durationSec != null) {
      this.totalDurationSec += durationSec
      let idx = DURATION_BUCKET_EDGES.findIndex(le => durationSec <= le)
      if (idx === -1) idx = DURATION_BUCKET_EDGES.length
      this.histogram[idx]++
    }
    if (sampleRate != null) {
      this.sampleRates.set(sampleRate, (this.sampleRates.get(sampleRate) ?? 0) + 1)
    }
  }

  addText(text: string): void {
    this.textFileCount++
    for (const tok of text.split(/\s+/)) {
      if (!tok) continue
      const cur = this.vocab.get(tok)
      if (cur != null) {
        this.vocab.set(tok, cur + 1)
      } else if (this.vocab.size < this.vocabLimit) {
        this.vocab.set(tok, 1)
      } else {
        this.vocabTruncated = true
      }
    }
    for (const ch of text) {
      if (!/\s/.test(ch)) this.chars.add(ch)
    }
  }

  markTruncated(): void {
    this.truncated = true
  }

  result(): DatasetStatsResult {
    const topWords = [...this.vocab.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 50)
    return {
      fileCount: this.fileCount,
      totalDurationSec: this.totalDurationSec,
      durationHistogram: [
        ...DURATION_BUCKET_EDGES.map((le, i) => ({ le: le as number | null, count: this.histogram[i] })),
        { le: null, count: this.histogram[DURATION_BUCKET_EDGES.length] },
      ],
      sampleRates: Object.fromEntries(
        [...this.sampleRates.entries()].map(([k, v]) => [String(k), v]),
      ),
      textFileCount: this.textFileCount,
      vocabSize: this.vocab.size,
      vocabTruncated: this.vocabTruncated,
      charSet: this.chars.size,
      topWords,
      truncated: this.truncated,
    }
  }
}
