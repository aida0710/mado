import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let cleaned = false

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

// 再生成できる解析入力・索引だけを置く。停止した自分のプロセスの生成物を回収する。
function cleanAbandonedDirectories(): void {
  for (const name of readdirSync(tmpdir())) {
    const match = /^mado-(?:tar-index|media-input)-(\d+)-[A-Za-z0-9]{6}$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (pid !== process.pid && isProcessRunning(pid)) continue
    const directory = join(tmpdir(), name)
    try {
      const attributes = lstatSync(directory)
      if (!attributes.isDirectory() || attributes.uid !== process.getuid?.()) continue
      rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export function createPrivateMediaDirectory(kind: 'tar-index' | 'media-input'): string {
  if (!cleaned) { cleanAbandonedDirectories(); cleaned = true }
  const directory = mkdtempSync(join(tmpdir(), `mado-${kind}-${process.pid}-`))
  chmodSync(directory, 0o700)
  return directory
}
