import { describe, expect, it } from 'vitest'
import { absoluteUrl, encPath, fileLinkToDirRedirect, parseS3Path, tarEntryWebUrl } from './route'

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

describe('tarEntryWebUrl', () => {
  it('親 prefix のリスト + preview(tar) + entry(エントリ名)', () => {
    expect(tarEntryWebUrl('c1', 'b1', 'rec/session.tar', 'audio/mic_01.wav'))
      .toBe('/storage/c1/b1/rec/?preview=rec%2Fsession.tar&entry=audio%2Fmic_01.wav')
  })

  it('bucket 直下の tar — 空 prefix', () => {
    expect(tarEntryWebUrl('c1', 'b1', 'shard.tar', 'u1.wav'))
      .toBe('/storage/c1/b1/?preview=shard.tar&entry=u1.wav')
  })

  it('エントリ名のスラッシュは %2F になる (クエリ値なのでセグメント扱いしない)', () => {
    expect(tarEntryWebUrl('c1', 'b1', 'a.tar', 'a/b/c.wav'))
      .toContain('&entry=a%2Fb%2Fc.wav')
  })

  it('connId / bucket / パスセグメント / エントリの特殊文字を encode する', () => {
    expect(tarEntryWebUrl('c 1', 'b/1', 'foo bar/x.tar', 'e?#%.wav'))
      .toBe('/storage/c%201/b%2F1/foo%20bar/?preview=foo%20bar%2Fx.tar&entry=e%3F%23%25.wav')
  })

  it('VoxPopuli の実例 — .tar.xz の中の音声を指す', () => {
    expect(
      tarEntryWebUrl(
        'mW5dNSSMcQ',
        'dataset',
        'voxpopuli-unlabeled-v2-asr-sidon/voxpopuli-unlabeled-bg_2009_2-sidon-0002.tar.xz',
        'bg_2009_2/20090316-0900-PLENARY-14_bg_1.wav',
      ),
    ).toBe(
      '/storage/mW5dNSSMcQ/dataset/voxpopuli-unlabeled-v2-asr-sidon/' +
      '?preview=voxpopuli-unlabeled-v2-asr-sidon%2Fvoxpopuli-unlabeled-bg_2009_2-sidon-0002.tar.xz' +
      '&entry=bg_2009_2%2F20090316-0900-PLENARY-14_bg_1.wav',
    )
  })
})

describe('absoluteUrl', () => {
  it('サイト内の絶対パスに origin を付ける', () => {
    expect(absoluteUrl('/storage/c/b/')).toBe(`${window.location.origin}/storage/c/b/`)
  })

  it('API のパスにも使える (生データ URL のコピー用)', () => {
    expect(absoluteUrl('/api/internal/storage/c/preview/tar-entry?bucket=b'))
      .toBe(`${window.location.origin}/api/internal/storage/c/preview/tar-entry?bucket=b`)
  })

  it('返す値は必ずホスト付きでパースできる', () => {
    const u = new URL(absoluteUrl('/a/b?x=1'))
    expect(u.host).toBe(new URL(window.location.origin).host)
    expect(u.pathname).toBe('/a/b')
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
