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

describe('classify - テキストは拡張子で判定しない', () => {
  // テキストかどうかは描画時に中身 (先頭 64KB の NUL) で決める。ここで
  // 'text' を返してしまうと、拡張子リストの保守が永遠に終わらない。
  it.each([
    'a.md', 'a.jsonl', 'a.txt', 'a.csv',
    'README', 'Dockerfile', 'run.sh', 'conf.toml', 'utt.lab',
  ])('%s は unknown (= 中身を見る)', key => {
    expect(classify(key)).toBe('unknown')
  })
})
