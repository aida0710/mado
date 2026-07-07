// ffmpeg / ffprobe を子プロセスで叩いて音声を解析する。入力は常に stdin パイプ
// (S3 ストリーム or Buffer) — ファイルには書かない。
//
// パス構成 (stdout が 1 本しかないため 2 パス。openStream はパスごとに呼ばれる):
//   1. ffprobe (probeHead のみ) : sample_rate
//   2. ffmpeg -f f32le          : ピーク集計 + 総サンプル数 → duration
//   3. ffmpeg showspectrumpic   : スペクトログラム PNG (duration から幅を決める)

import { spawn } from 'node:child_process'
import { PeakAccumulator } from './media-peaks.js'

export class MediaAnalyzeError extends Error {
  constructor(message: string, public stderrSummary: string) {
    super(message)
  }
}

export interface AnalyzeResult {
  peaks: Array<[number, number]>
  durationSec: number
  sampleRate: number | null
  spectrogramPng: Buffer | null
}

export interface AnalyzeOpts {
  openStream: () => Promise<NodeJS.ReadableStream>
  probeHead: () => Promise<Buffer>
  timeoutMs: number
  maxSpectrogramWidth: number
  signal?: AbortSignal
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
      input.on('error', () => child.stdin.end())
    }
  })
}

async function probeSampleRate(head: Buffer, opts: AnalyzeOpts): Promise<number | null> {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate',
    '-of', 'json',
    'pipe:0',
  ], head, { timeoutMs: opts.timeoutMs, signal: opts.signal })
  try {
    const parsed = JSON.parse(r.stdout.toString()) as {
      streams?: Array<{ sample_rate?: string }>
    }
    const sr = parsed.streams?.[0]?.sample_rate
    return sr ? Number(sr) : null
  } catch {
    return null
  }
}

export async function analyzeAudio(opts: AnalyzeOpts): Promise<AnalyzeResult> {
  // パス 1: ffprobe (先頭バイトのみ)
  const sampleRate = await probeSampleRate(await opts.probeHead(), opts)

  // パス 2: ピーク + duration
  const acc = new PeakAccumulator()
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
      acc.push(new Float32Array(aligned.buffer, 0, usable / 4))
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

  // パス 3: スペクトログラム PNG
  const width = Math.min(
    opts.maxSpectrogramWidth,
    Math.max(SPECTROGRAM_MIN_WIDTH, Math.round(durationSec * SPECTROGRAM_PX_PER_SEC)),
  )
  const specRun = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-lavfi', `showspectrumpic=s=${width}x${SPECTROGRAM_HEIGHT}:legend=0`,
    '-frames:v', '1',
    '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], await opts.openStream(), { timeoutMs: opts.timeoutMs, signal: opts.signal })
  // スペクトログラム失敗は致命ではない (ピークだけでも返す)
  const spectrogramPng = specRun.code === 0 && specRun.stdout.length > 0
    ? specRun.stdout
    : null

  return { peaks, durationSec, sampleRate, spectrogramPng }
}
