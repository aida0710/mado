import { describe, expect, it } from 'vitest'
import { explainStorageError } from './storageError.js'

describe('explainStorageError', () => {
  it('NoSuchKey → 404', () => {
    const r = explainStorageError({ name: 'NoSuchKey' })
    expect(r?.status).toBe(404)
    expect(r?.message).toContain('NoSuchKey')
  })

  it('$metadata.httpStatusCode 404 → 404', () => {
    expect(explainStorageError({ $metadata: { httpStatusCode: 404 } })?.status).toBe(404)
  })

  it('S3 5xx upstream → 502。HTTP status を含める', () => {
    const r = explainStorageError({ $metadata: { httpStatusCode: 503 } })
    expect(r?.status).toBe(502)
    expect(r?.message).toContain('HTTP 503')
  })

  // 原因を決めつけない。以前は一律「一時的なプロキシエラー」と書いていたが、
  // R2 の権限不足など恒久的な設定ミスでも同じ経路に来る。
  it('XML deserialize 失敗 → 502。生メッセージと確認先を出す', () => {
    const r = explainStorageError({
      message: "Expected closing tag 'hr' instead of closing tag 'body'.:6:1",
    })
    expect(r?.status).toBe(502)
    expect(r?.message).toContain("Expected closing tag 'hr'")
    expect(r?.message).toContain('エンドポイント')
    expect(r?.message).not.toContain('一時的')
  })

  it('コード不明で $response だけ付いている → 解釈できなかった扱い', () => {
    const r = explainStorageError({ $response: { body: '...' } })
    expect(r?.status).toBe(502)
    expect(r?.message).toContain('解釈できません')
  })

  // ストレージが正しく返したエラーを「解釈できませんでした」と言わない。
  // R2 は資格情報の不備をこの形で返してくる。
  it('$response 付きでもエラーコードがあれば、ストレージが返したエラーとして扱う', () => {
    const r = explainStorageError({
      name: 'InvalidArgument',
      message: 'Credential access key has length 21, should be 32',
      $response: { body: '...' },
    })
    expect(r?.message).toContain('InvalidArgument')
    expect(r?.message).toContain('should be 32')
    expect(r?.message).not.toContain('解釈できません')
  })

  // 403 は「キーが違う」のか「権限が足りない」のかで対処が変わる。
  // S3 のコードをそのまま出さないと切り分けられない。
  it('403 → S3 のエラーコードと生メッセージを含める', () => {
    const r = explainStorageError({
      name: 'AccessDenied',
      message: 'Access Denied',
      $metadata: { httpStatusCode: 403 },
    })
    expect(r?.status).toBe(502)
    expect(r?.message).toContain('AccessDenied')
    expect(r?.message).toContain('Access Denied')
    expect(r?.message).toContain('ListBucket')
  })

  it('403 でもコードが違えばそのコードが出る', () => {
    const r = explainStorageError({
      name: 'InvalidAccessKeyId',
      message: 'The AWS Access Key Id you provided does not exist in our records.',
      $metadata: { httpStatusCode: 403 },
    })
    expect(r?.message).toContain('InvalidAccessKeyId')
  })

  // requestId はストレージ側に問い合わせるときの手がかりになる。
  it('requestId があれば添える', () => {
    const r = explainStorageError({
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403, requestId: 'abc123' },
    })
    expect(r?.message).toContain('requestId=abc123')
  })

  it('明らかに S3 関連でないエラー → null (呼び出し元に判断委譲)', () => {
    expect(explainStorageError({ message: 'some random non-storage error' })).toBeNull()
    expect(explainStorageError(new Error('totally unrelated'))).toBeNull()
  })

  // SignatureDoesNotMatch は canonical request 全文を抱えることがある。
  it('生メッセージが長すぎるときは切り詰める', () => {
    const r = explainStorageError({
      $metadata: { httpStatusCode: 400 },
      message: 'x'.repeat(2000),
    })
    expect(r?.status).toBe(500)
    expect(r?.message.length).toBeLessThan(600)
    expect(r?.message).toContain('…')
  })
})
