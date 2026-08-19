import { describe, expect, it } from 'vitest'
import { createScanAccumulator } from './scan.js'

const add = (acc: ReturnType<typeof createScanAccumulator>, key: string, size: number): void =>
  acc.add({ key, size })

describe('createScanAccumulator', () => {
  it('件数と合計サイズを数える', () => {
    const acc = createScanAccumulator('d/')
    add(acc, 'd/a.tar', 100)
    add(acc, 'd/b.tar', 250)
    const r = acc.result(false)
    expect(r.objectCount).toBe(2)
    expect(r.totalBytes).toBe(350)
  })

  // 深い階層のキーも、直下のディレクトリ名に合算する。
  it('直下のサブディレクトリ別に集計する', () => {
    const acc = createScanAccumulator('d/')
    add(acc, 'd/x/1.tar', 10)
    add(acc, 'd/x/deep/2.tar', 20)
    add(acc, 'd/y/3.tar', 5)
    add(acc, 'd/top.tar', 1)
    expect(acc.result(false).children).toEqual([
      { name: 'x/', objectCount: 2, totalBytes: 30 },
      { name: 'y/', objectCount: 1, totalBytes: 5 },
    ])
  })

  it('children はサイズ降順', () => {
    const acc = createScanAccumulator('')
    add(acc, 'small/a', 1)
    add(acc, 'big/a', 1000)
    expect(acc.result(false).children.map(c => c.name)).toEqual(['big/', 'small/'])
  })

  it('拡張子別に集計する', () => {
    const acc = createScanAccumulator('d/')
    add(acc, 'd/a.tar', 100)
    add(acc, 'd/b.tar', 100)
    add(acc, 'd/c.json', 5)
    expect(acc.result(false).extensions).toEqual([
      { ext: '.tar', objectCount: 2, totalBytes: 200 },
      { ext: '.json', objectCount: 1, totalBytes: 5 },
    ])
  })

  // .tar.gz は「最後のドット以降」だと .gz になってしまう。
  it('二重拡張子は既知の組み合わせをまとめて扱う', () => {
    const acc = createScanAccumulator('')
    add(acc, 'a.tar.gz', 10)
    add(acc, 'b.tar.xz', 20)
    expect(acc.result(false).extensions.map(e => e.ext)).toEqual(['.tar.xz', '.tar.gz'])
  })

  it('拡張子が無いファイルは (なし) にまとめる', () => {
    const acc = createScanAccumulator('')
    add(acc, 'README', 1)
    expect(acc.result(false).extensions[0].ext).toBe('(なし)')
  })

  it('prefix 自身を表す 0 バイトのキーは数えない', () => {
    const acc = createScanAccumulator('d/')
    add(acc, 'd/', 0)
    add(acc, 'd/a.tar', 10)
    expect(acc.result(false).objectCount).toBe(1)
  })

  it('count() は現在までの件数を返す (進捗表示用)', () => {
    const acc = createScanAccumulator('')
    add(acc, 'a', 1)
    add(acc, 'b', 1)
    expect(acc.count()).toBe(2)
  })

  it('partial をそのまま結果に載せる', () => {
    expect(createScanAccumulator('').result(true).partial).toBe(true)
  })
})
