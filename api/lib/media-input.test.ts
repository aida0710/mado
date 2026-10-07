import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { spoolMediaInput } from './media-input.js'

const inputDirectories = async () => (await readdir(tmpdir())).filter(name => name.startsWith('mado-media-input-')).sort()

describe('解析用の一時ファイル', () => {
  it('privateなファイルを解析パス間で再利用し、完了後は削除する', async () => {
    const input = await spoolMediaInput({ source: Readable.from(Buffer.from('audio')) })
    try {
      expect((await stat(input.inputPath)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(input.inputPath))).mode & 0o777).toBe(0o700)
      expect(input.getSizeBytes()).toBe(5)
      expect((await input.probeHead()).toString()).toBe('audio')
      const stream = await input.openStream()
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).toBe('audio')
    } finally { await input.cleanup() }
    await expect(readFile(input.inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('サイズ上限を超えたら入力を止め、途中のファイルを残さない', async () => {
    const before = await inputDirectories()
    const source = Readable.from([Buffer.from('1234'), Buffer.from('5678')])
    await expect(spoolMediaInput({ source, maxBytes: 4 })).rejects.toThrow('analysis limit')
    expect(source.destroyed).toBe(true)
    expect(await inputDirectories()).toEqual(before)
  })

  it('転送中の中断はS3本文も止め、途中のファイルを残さない', async () => {
    const before = await inputDirectories()
    const source = new Readable({ read() { /* 中断まで待つ。 */ } })
    const controller = new AbortController()
    const spooling = spoolMediaInput({ source, signal: controller.signal })
    controller.abort()
    await expect(spooling).rejects.toMatchObject({ name: 'AbortError' })
    expect(source.destroyed).toBe(true)
    expect(await inputDirectories()).toEqual(before)
  })
})
