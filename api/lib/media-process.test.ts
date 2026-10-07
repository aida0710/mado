import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runMediaProcess } from './media-process.js'

describe('解析プロセスの出力制限', () => {
  it('過大なstdoutはプロセスを止め、入力ストリームも閉じる', async () => {
    const input = new Readable({ read() {} })
    await expect(runMediaProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.alloc(17 * 1024 * 1024)); setInterval(() => {}, 1000)'],
      input, timeoutMs: 5000,
    })).rejects.toThrow('output exceeds size limit')
    expect(input.destroyed).toBe(true)
  })

  it('長いstderrは末尾だけを保持し、正常終了の判定を妨げない', async () => {
    const output = await runMediaProcess({
      command: process.execPath, args: ['-e', "process.stderr.write('x'.repeat(1024 * 1024) + 'END')"],
      input: Buffer.alloc(0), timeoutMs: 5000,
    })
    expect(output.code).toBe(0)
    expect(output.stderr.length).toBeLessThanOrEqual(64 * 1024)
    expect(output.stderr.endsWith('END')).toBe(true)
  })
})
