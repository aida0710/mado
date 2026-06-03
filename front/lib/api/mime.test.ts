import { describe, expect, it } from 'vitest'
import { classify, classifyEntry } from './mime'

describe('classify - audio', () => {
  it.each([
    'a.mp3', 'a.wav', 'a.flac', 'a.ogg', 'a.oga', 'a.opus',
    'a.m4a', 'a.m4b', 'a.aac', 'a.weba', 'a.aiff', 'a.aif', 'a.wma',
  ])('%s を audio と判定する', key => {
    expect(classify(key)).toBe('audio')
  })

  it('大文字拡張子・パス付きでも判定する', () => {
    expect(classify('raw-data/voice/SAMPLE.M4A')).toBe('audio')
  })
})

describe('classify - その他種別は影響を受けない', () => {
  it.each([
    ['a.png', 'image'],
    ['a.md', 'text'],
    ['a.jsonl', 'text'],
    ['a.tar.xz', 'archive'],
    ['a.bin', 'unknown'],
    ['a.m4v', 'unknown'], // 動画は audio に巻き込まない
  ] as const)('%s -> %s', (key, kind) => {
    expect(classify(key)).toBe(kind)
  })

  it('tar エントリでは archive を unknown に落とすが audio は残す', () => {
    expect(classifyEntry('inner.tar')).toBe('unknown')
    expect(classifyEntry('clip.m4a')).toBe('audio')
  })
})
