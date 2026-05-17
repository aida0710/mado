import { describe, expect, it } from 'vitest'
import { encPath, fileLinkToDirRedirect, parseS3Path } from './route'

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

describe('parseS3Path', () => {
  it('s3:// スキーム付きのディレクトリパスを分解する', () => {
    expect(parseS3Path('s3://dataset/debug/x/'))
      .toEqual({ bucket: 'dataset', prefix: 'debug/x/' })
  })

  it('末尾スラッシュなしの不完全 prefix も保持する (前方一致用)', () => {
    expect(parseS3Path('s3://dataset/debug/dialogue-sidon-parakeet-v1/partition-test-1gp'))
      .toEqual({ bucket: 'dataset', prefix: 'debug/dialogue-sidon-parakeet-v1/partition-test-1gp' })
  })

  it('bucket だけ (prefix なし)', () => {
    expect(parseS3Path('s3://dataset')).toEqual({ bucket: 'dataset', prefix: '' })
  })

  it('bucket + 末尾スラッシュのみ', () => {
    expect(parseS3Path('s3://dataset/')).toEqual({ bucket: 'dataset', prefix: '' })
  })

  it('s3:// スキームは省略可能', () => {
    expect(parseS3Path('dataset/debug')).toEqual({ bucket: 'dataset', prefix: 'debug' })
  })

  it('スキームは大小文字を問わず剥がす (bucket 名はそのまま)', () => {
    expect(parseS3Path('S3://Dataset/X')).toEqual({ bucket: 'Dataset', prefix: 'X' })
  })

  it('前後の空白を trim する', () => {
    expect(parseS3Path('  s3://dataset/x  ')).toEqual({ bucket: 'dataset', prefix: 'x' })
  })

  it('先頭の余分なスラッシュを除去する', () => {
    expect(parseS3Path('/dataset/x')).toEqual({ bucket: 'dataset', prefix: 'x' })
  })

  it('空文字 / スキームのみは null', () => {
    expect(parseS3Path('')).toBeNull()
    expect(parseS3Path('   ')).toBeNull()
    expect(parseS3Path('s3://')).toBeNull()
  })
})
