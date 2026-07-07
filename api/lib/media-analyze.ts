// ffmpeg / ffprobe を子プロセスで叩いて音声を解析する。入力は常に stdin パイプ
// (S3 ストリーム or Buffer) — ファイルには書かない。
//
// パス構成 (stdout が 1 本しかないため 2 パス。openStream はパスごとに呼ばれる):
//   1. ffprobe (probeHead のみ) : sample_rate
//   2. ffmpeg -f f32le          : ピーク集計 + 総サンプル数 → duration
//   3. ffmpeg showspectrumpic   : スペクトログラム PNG (duration から幅を決める)

import { spawn } from 'node:child_process'
import { LoudnessAccumulator, PeakAccumulator } from './media-peaks.js'

export class MediaAnalyzeError extends Error {
  constructor(message: string, public stderrSummary: string) {
    super(message)
  }
}

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
export function resolveBitRate(
  streamBitRate: number | null,
  formatBitRate: number | null,
  sizeBytes: number | null,
  durationSec: number,
): number | null {
  if (streamBitRate != null) return streamBitRate
  if (formatBitRate != null) return formatBitRate
  if (sizeBytes != null && durationSec > 0) return Math.round((sizeBytes * 8) / durationSec)
  return null
}

const PEAK_SAMPLE_RATE = 16000
const SPECTROGRAM_HEIGHT = 256
const SPECTROGRAM_PX_PER_SEC = 50
const SPECTROGRAM_MIN_WIDTH = 640

interface RunResult {
  stdout: Buffer
  stderr: string
  code: number | null
}

// 子プロセスを起動し、input を stdin に流し、stdout を集める。
// onStdout を渡すと stdout はバッファせずチャンクごとに渡す (ピークパス用)。
function run(
  cmd: string,
  args: string[],
  input: NodeJS.ReadableStream | Buffer,
  opts: { timeoutMs: number; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void },
): Promise<RunResult> {
  // 既に abort 済みの signal には addEventListener が反応しないため、spawn 前に確認する。
  if (opts.signal?.aborted) {
    return Promise.reject(new MediaAnalyzeError('aborted', ''))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      fail(new MediaAnalyzeError(`${cmd} timed out`, stderr.slice(-2000)))
    }, opts.timeoutMs)

    const onAbort = (): void => {
      fail(new MediaAnalyzeError('aborted', ''))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    function cleanup(): void {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      child.kill('SIGKILL')
    }
    function fail(err: Error): void {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    child.on('error', e => fail(new MediaAnalyzeError(e.message, '')))
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.stdout.on('data', (c: Buffer) => {
      if (opts.onStdout) opts.onStdout(c)
      else stdoutChunks.push(c)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code })
    })

    // stdin へ流し込む。ffmpeg はヘッダを読んだ時点で stdin を閉じることがある
    // (EPIPE) — 正常系なので無視する。
    child.stdin.on('error', () => { /* EPIPE — ffmpeg 側が先に閉じた */ })
    if (Buffer.isBuffer(input)) {
      child.stdin.end(input)
    } else {
      input.pipe(child.stdin)
      // 入力側 (S3 ストリーム等) のエラーは黙殺しない — 途中で切れた入力を
      // ffmpeg が exit 0 で終えると「成功だが不完全」な結果になってしまう。
      input.on('error', e => {
        fail(new MediaAnalyzeError(
          `${cmd} input stream error`,
          e instanceof Error ? e.message : String(e),
        ))
      })
    }
  })
}

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
  let r: RunResult
  try {
    r = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries',
      'stream=codec_name,channels,sample_rate,bits_per_raw_sample,bits_per_sample,bit_rate',
      '-show_entries', 'format=format_name,bit_rate',
      '-of', 'json',
      'pipe:0',
    ], head, { timeoutMs: opts.timeoutMs, signal: opts.signal })
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
    // bits_per_raw_sample (flac 等の可逆コーデック) を優先し、無ければ bits_per_sample。
    // どちらも無ければ null (mp3 等)。
    const bits = s?.bits_per_raw_sample ?? s?.bits_per_sample
    return {
      sampleRate: s?.sample_rate ? Number(s.sample_rate) : null,
      codec: s?.codec_name ?? null,
      container: f?.format_name ?? null,
      channels: s?.channels ?? null,
      bitsPerSample: bits != null ? Number(bits) : null,
      streamBitRate: s?.bit_rate ? Number(s.bit_rate) : null,
      formatBitRate: f?.bit_rate ? Number(f.bit_rate) : null,
    }
  } catch {
    return EMPTY_PROBE
  }
}

export async function analyzeAudio(opts: AnalyzeOpts): Promise<AnalyzeResult> {
  // パス 1: ffprobe (先頭バイトのみ)
  const probe = await probeMetadata(await opts.probeHead(), opts)

  // パス 2: ピーク + 音量 + duration
  const acc = new PeakAccumulator()
  const loudness = new LoudnessAccumulator()
  let carry: Buffer = Buffer.alloc(0)
  const peakRun = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE),
    '-f', 'f32le', 'pipe:1',
  ], await opts.openStream(), {
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
      peakRun.stderr.slice(-2000),
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
    const specRun = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-lavfi', `showspectrumpic=s=${width}x${SPECTROGRAM_HEIGHT}:legend=0`,
      '-frames:v', '1',
      '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ], await opts.openStream(), { timeoutMs: opts.timeoutMs, signal: opts.signal })
    if (specRun.code === 0 && specRun.stdout.length > 0) {
      spectrogramPng = specRun.stdout
    }
  } catch (e) {
    // スペクトログラム失敗は致命ではない (ピークだけでも返す)。abort だけは伝播させる。
    if (opts.signal?.aborted) throw e
  }

  const sizeBytes = opts.getSizeBytes ? opts.getSizeBytes() : null
  const bitRate = resolveBitRate(probe.streamBitRate, probe.formatBitRate, sizeBytes, durationSec)

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
