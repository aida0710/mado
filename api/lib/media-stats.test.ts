import { describe, expect, it } from 'vitest'
import {
  DatasetStatsAccumulator,
  isAudioName,
  pairWebdataset,
} from './media-stats.js'

describe('pairWebdataset', () => {
  it('同 basename の .txt / .json を音声に対応付ける', () => {
    const pairs = pairWebdataset([
      'utt_0001.wav', 'utt_0001.txt',
      'utt_0002.flac', 'utt_0002.json',
      'utt_0003.wav',
      'notes.md',
    ])
    expect(pairs).toEqual([
      { audio: 'utt_0001.wav', text: 'utt_0001.txt' },
      { audio: 'utt_0002.flac', text: 'utt_0002.json' },
      { audio: 'utt_0003.wav', text: null },
    ])
  })

  it('isAudioName は音声拡張子だけ true', () => {
    expect(isAudioName('a.wav')).toBe(true)
    expect(isAudioName('a.WAV')).toBe(true)
    expect(isAudioName('a.txt')).toBe(false)
    expect(isAudioName('a.tar')).toBe(false)
  })
})

describe('DatasetStatsAccumulator', () => {
  it('duration ヒストグラムと合計を集計する', () => {
    const acc = new DatasetStatsAccumulator()
    acc.addAudio(0.5, 16000)
    acc.addAudio(3.0, 16000)
    acc.addAudio(120, 44100)
    acc.addAudio(null, null) // duration 不明はカウントのみ
    const r = acc.result()
    expect(r.fileCount).toBe(4)
    expect(r.totalDurationSec).toBeCloseTo(123.5)
    const h = Object.fromEntries(r.durationHistogram.map(b => [String(b.le), b.count]))
    expect(h['1']).toBe(1)   // 0.5s
    expect(h['4']).toBe(1)   // 3.0s
    expect(h['null']).toBe(1) // 120s (60s 超)
    expect(r.sampleRates).toEqual({ '16000': 2, '44100': 1 })
  })

  it('テキスト統計: vocab / charSet / topWords', () => {
    const acc = new DatasetStatsAccumulator()
    acc.addText('hello world')
    acc.addText('hello again')
    const r = acc.result()
    expect(r.textFileCount).toBe(2)
    expect(r.vocabSize).toBe(3)
    expect(r.topWords[0]).toEqual(['hello', 2])
    // charSet: h,e,l,o,空白以外の文字…ユニーク文字数 (空白は除外)
    expect(r.charSet).toBe(new Set('helloworldagain').size)
  })

  it('.json サイドカーは text フィールドを読む (呼び出し側で抽出) — addText は素の文字列を受ける', () => {
    const acc = new DatasetStatsAccumulator()
    acc.addText('こんにちは')
    const r = acc.result()
    // 分かち書きなし日本語: 1 トークン扱い、文字は 5 種
    expect(r.vocabSize).toBe(1)
    expect(r.charSet).toBe(5)
  })

  it('vocab 上限で打ち切りフラグが立つ', () => {
    const acc = new DatasetStatsAccumulator({ vocabLimit: 3 })
    acc.addText('a b c d e')
    const r = acc.result()
    expect(r.vocabSize).toBe(3)
    expect(r.vocabTruncated).toBe(true)
  })
})
