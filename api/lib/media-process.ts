import { spawn } from 'node:child_process'
import { MediaAnalyzeError } from './media-analyze-error.js'

// 正常なPNGは数MiB。診断・stdoutを無制限にメモリへ集めない。
const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_CHARS = 64 * 1024

export interface MediaProcessOutput { stdout: Buffer; stderr: string; code: number | null }

export function runMediaProcess({ command, args, input, timeoutMs, signal, onStdout }: {
  command: string; args: string[]; input: NodeJS.ReadableStream | Buffer
  timeoutMs: number; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void
}): Promise<MediaProcessOutput> {
  if (signal?.aborted) return Promise.reject(new MediaAnalyzeError('aborted', ''))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => fail(new MediaAnalyzeError(`${command} timed out`, stderr)), timeoutMs)
    const abort = (): void => fail(new MediaAnalyzeError('aborted', ''))
    signal?.addEventListener('abort', abort, { once: true })

    function cleanup(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      child.kill('SIGKILL')
      if (!Buffer.isBuffer(input)) {
        input.unpipe(child.stdin)
        ;(input as NodeJS.ReadableStream & { destroy?(): void }).destroy?.()
      }
    }
    function fail(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    child.on('error', error => fail(new MediaAnalyzeError(error.message, '')))
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARS) })
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      try {
        if (onStdout) { onStdout(chunk); return }
        stdoutBytes += chunk.length
        if (stdoutBytes > MAX_STDOUT_BYTES) { fail(new MediaAnalyzeError(`${command} output exceeds size limit`, stderr)); return }
        stdoutChunks.push(chunk)
      } catch (error) { fail(error as Error) }
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ stdout: Buffer.concat(stdoutChunks, stdoutBytes), stderr, code })
    })

    // probeがヘッダーを読み終えてstdinを閉じた場合のEPIPEは正常終了で判定する。
    child.stdin.on('error', () => {})
    if (Buffer.isBuffer(input)) child.stdin.end(input)
    else {
      input.on('error', error => fail(new MediaAnalyzeError(`${command} input stream error`, error.message)))
      input.pipe(child.stdin)
    }
  })
}
