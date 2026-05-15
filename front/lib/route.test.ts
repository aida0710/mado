import { describe, expect, it } from 'vitest'
import { encPath, fileLinkToDirRedirect } from './route'

describe('encPath', () => {
  it('スラッシュ構造を保ったままセグメント単位で encode する', () => {
    expect(encPath('foo bar/baz qux')).toBe('foo%20bar/baz%20qux')
  })

  it('末尾スラッシュを保つ', () => {
    expect(encPath('foo/bar/')).toBe('foo/bar/')
  })

  it('空文字は空文字', () => {
    expect(encPath('')).toBe('')
  })

  it('? # % を全部 encode する', () => {
    expect(encPath('a/b?c#d/e%f')).toBe('a/b%3Fc%23d/e%25f')
  })

  it('連続スラッシュも壊さない', () => {
    expect(encPath('a//b')).toBe('a//b')
  })
})

describe('fileLinkToDirRedirect', () => {
  it('ネストされたディレクトリ内のファイル — 親 prefix のリスト + preview に飛ぶ', () => {
    expect(fileLinkToDirRedirect('c1', 'b1', 'foo/bar/baz.txt'))
      .toBe('/storage/c1/b1/foo/bar/?preview=foo%2Fbar%2Fbaz.txt')
  })

  it('bucket 直下のファイル — 空 prefix + preview', () => {
    expect(fileLinkToDirRedirect('c1', 'b1', 'baz.txt'))
      .toBe('/storage/c1/b1/?preview=baz.txt')
  })

  it('VoxPopuli の実例 — .tar.xz もそのまま preview に乗る', () => {
    expect(
      fileLinkToDirRedirect(
        'mW5dNSSMcQ',
        'dataset',
        'voxpopuli-unlabeled-v2-asr-sidon/voxpopuli-unlabeled-bg_2009_2-sidon-0002.tar.xz',
      ),
    ).toBe(
      '/storage/mW5dNSSMcQ/dataset/voxpopuli-unlabeled-v2-asr-sidon/' +
      '?preview=voxpopuli-unlabeled-v2-asr-sidon%2Fvoxpopuli-unlabeled-bg_2009_2-sidon-0002.tar.xz',
    )
  })

  it('connId / bucket / パスセグメントに特殊文字があっても encode する', () => {
    expect(fileLinkToDirRedirect('c 1', 'b/1', 'foo bar/file?.txt'))
      .toBe('/storage/c%201/b%2F1/foo%20bar/?preview=foo%20bar%2Ffile%3F.txt')
  })
})
