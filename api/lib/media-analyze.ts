// 一度取得したファイルからprobe・波形・スペクトログラムを作る。
// ストリーム入力も、小さなメディアの解析・テスト向けに受け付ける。

import { MediaAnalyzeError } from './media-analyze-error.js'
export { MediaAnalyzeError } from './media-analyze-error.js'
import { runMediaProcess, type MediaProcessOutput } from './media-process.js'
import { LoudnessAccumulator, PeakAccumulator } from './media-peaks.js'

// media_cache.meta にそのまま保存され、analyze レスポンスにも乗る。
// 取れない項目は null (mp3 の bit 深度等)。
export interface MediaMeta {
  codec: string | null
  container: string | null
  channels: number | null
  bitsPerSample: number | null
  bitRate: number | null
  sizeBytes: number | null
  peakDb: number | null
  rmsDb: number | null
}

export interface AnalyzeResult {
  peaks: Array<[number, number]>
  durationSec: number
  sampleRate: number | null
  spectrogramPng: Buffer | null
  meta: MediaMeta
}

export interface AnalyzeOpts {
  /** S3から一度取得した一時ファイル。mov等の末尾メタデータにもseekできる。 */
  inputPath?: string
  openStream: () => Promise<NodeJS.ReadableStream>
  probeHead: () => Promise<Buffer>
  timeoutMs: number
  maxSpectrogramWidth: number
  signal?: AbortSignal
  // 単体ファイル: GetObject の ContentLength を openStream 呼び出し時に捕捉して返す。
  // tar エントリ: 抽出済み buffer.length を返す。呼べない/無ければ null 扱い。
  getSizeBytes?: () => number | null
}

// bitRate の決定順: stream の bit_rate → format の bit_rate → 計算値
// (sizeBytes*8/durationSec)。どれも無ければ null。
export function resolveBitRate({ streamBitRate, formatBitRate, sizeBytes, durationSec }: {
  streamBitRate: number | null
  formatBitRate: number | null
  sizeBytes: number | null
  durationSec: number
}): number | null {
  if (streamBitRate != null) return streamBitRate
  if (formatBitRate != null) return formatBitRate
  if (sizeBytes != null && durationSec > 0) return Math.round((sizeBytes * 8) / durationSec)
  return null
}

const PEAK_SAMPLE_RATE = 16000
const SPECTROGRAM_HEIGHT = 256
const SPECTROGRAM_PX_PER_SEC = 50
const SPECTROGRAM_MIN_WIDTH = 640

// 入力がplaylist/concatだった場合に、別のURLやworker上のfileを読ませない。
const SAFE_INPUT_OPTIONS = [
  '-protocol_whitelist', 'file,pipe',
  '-format_whitelist', 'wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff,asf,avi,ape,amr,au,ac3,eac3,mpeg,mpegts,wv,tta,dsf,dff',
]

interface ProbeMetadata {
  sampleRate: number | null
  codec: string | null
  container: string | null
  channels: number | null
  bitsPerSample: number | null
  streamBitRate: number | null
  formatBitRate: number | null
}

const EMPTY_PROBE: ProbeMetadata = {
  sampleRate: null,
  codec: null,
  container: null,
  channels: null,
  bitsPerSample: null,
  streamBitRate: null,
  formatBitRate: null,
}

async function probeMetadata(head: Buffer, opts: AnalyzeOpts): Promise<ProbeMetadata> {
  let r: MediaProcessOutput
  try {
    r = await runMediaProcess({ command: 'ffprobe', args: [
      '-v', 'error',
      ...SAFE_INPUT_OPTIONS,
      '-select_streams', 'a:0',
      '-show_entries',
      'stream=codec_name,channels,sample_rate,bits_per_raw_sample,bits_per_sample,bit_rate',
      '-show_entries', 'format=format_name,bit_rate',
      '-of', 'json',
      opts.inputPath ?? 'pipe:0',
    ], input: head, timeoutMs: opts.timeoutMs, signal: opts.signal })
  } catch (e) {
    // probe 失敗は致命ではない (メタは全項目 null で続行)。abort だけは伝播させる。
    if (opts.signal?.aborted) throw e
    return EMPTY_PROBE
  }
  try {
    const parsed = JSON.parse(r.stdout.toString()) as {
      streams?: Array<{
        codec_name?: string
        channels?: number
        sample_rate?: string
        bits_per_raw_sample?: number | string
        bits_per_sample?: number | string
        bit_rate?: string
      }>
      format?: { format_name?: string; bit_rate?: string }
    }
    const s = parsed.streams?.[0]
    const f = parsed.format
    // bits_per_raw_sample (flac 等の可逆コーデック。string で来ることがある: "16")
    // を優先し、無ければ bits_per_sample。ffprobe は mp3/aac 等で bits_per_sample: 0
    // (数値 0、欠落ではない) を返すため、0 も「無し」= null として扱う。
    // Number(undefined) は NaN (falsy) なので欠落と 0 を同じ分岐で処理できる。
    const bits = Number(s?.bits_per_raw_sample) || Number(s?.bits_per_sample) || null
    return {
      sampleRate: s?.sample_rate ? Number(s.sample_rate) : null,
      codec: s?.codec_name ?? null,
      container: f?.format_name ?? null,
      channels: s?.channels ?? null,
      bitsPerSample: bits,
      streamBitRate: s?.bit_rate ? Number(s.bit_rate) : null,
      formatBitRate: f?.bit_rate ? Number(f.bit_rate) : null,
    }
  } catch {
    return EMPTY_PROBE
  }
}

export async function analyzeAudio(opts: AnalyzeOpts): Promise<AnalyzeResult> {
  // パス 1: ffprobe (一時ファイルがなければ先頭バイト)
  const probe = await probeMetadata(await opts.probeHead(), opts)

  // パス 2: ピーク + 音量 + duration
  const acc = new PeakAccumulator()
  const loudness = new LoudnessAccumulator()
  let carry: Buffer = Buffer.alloc(0)
  const peakRun = await runMediaProcess({ command: 'ffmpeg', args: [
    '-hide_banner', '-loglevel', 'error',
    ...SAFE_INPUT_OPTIONS,
    '-i', opts.inputPath ?? 'pipe:0',
    '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE),
    '-f', 'f32le', 'pipe:1',
  ], input: opts.inputPath ? Buffer.alloc(0) : await opts.openStream(),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onStdout: chunk => {
      // f32le: 4 byte 境界にそろえて Float32Array 化。端数は次チャンクへ持ち越す。
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 4)
      carry = buf.subarray(usable)
      if (usable === 0) return
      const aligned = new Uint8Array(usable)
      aligned.set(buf.subarray(0, usable))
      const floats = new Float32Array(aligned.buffer, 0, usable / 4)
      acc.push(floats)
      loudness.push(floats)
    },
  })
  const { peaks, totalSamples } = acc.finish()
  if (peakRun.code !== 0 || totalSamples === 0) {
    throw new MediaAnalyzeError(
      'ffmpeg failed to decode audio',
      peakRun.stderr,
    )
  }
  const durationSec = totalSamples / PEAK_SAMPLE_RATE
  const { peakDb, rmsDb } = loudness.finish()

  // パス 3: スペクトログラム PNG
  const width = Math.min(
    opts.maxSpectrogramWidth,
    Math.max(SPECTROGRAM_MIN_WIDTH, Math.round(durationSec * SPECTROGRAM_PX_PER_SEC)),
  )
  let spectrogramPng: Buffer | null = null
  try {
    const specRun = await runMediaProcess({ command: 'ffmpeg', args: [
      '-hide_banner', '-loglevel', 'error',
      ...SAFE_INPUT_OPTIONS,
      '-i', opts.inputPath ?? 'pipe:0',
      '-lavfi', `showspectrumpic=s=${width}x${SPECTROGRAM_HEIGHT}:legend=0`,
      '-frames:v', '1',
      '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ], input: opts.inputPath ? Buffer.alloc(0) : await opts.openStream(), timeoutMs: opts.timeoutMs, signal: opts.signal })
    if (specRun.code === 0 && specRun.stdout.length > 0) {
      spectrogramPng = specRun.stdout
    }
  } catch (e) {
    // スペクトログラム失敗は致命ではない (ピークだけでも返す)。abort だけは伝播させる。
    if (opts.signal?.aborted) throw e
  }

  const sizeBytes = opts.getSizeBytes ? opts.getSizeBytes() : null
  const bitRate = resolveBitRate({ streamBitRate: probe.streamBitRate, formatBitRate: probe.formatBitRate, sizeBytes, durationSec })

  return {
    peaks,
    durationSec,
    sampleRate: probe.sampleRate,
    spectrogramPng,
    meta: {
      codec: probe.codec,
      container: probe.container,
      channels: probe.channels,
      bitsPerSample: probe.bitsPerSample,
      bitRate,
      sizeBytes,
      peakDb,
      rmsDb,
    },
  }
}
