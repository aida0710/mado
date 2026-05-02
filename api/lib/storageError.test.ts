import { describe, expect, it } from 'vitest'
import { explainStorageError } from './storageError.js'

describe('explainStorageError', () => {
  it('NoSuchKey → 404', () => {
    expect(explainStorageError({ name: 'NoSuchKey' })).toEqual({
      status: 404,
      message: 'not found',
    })
  })

  it('$metadata.httpStatusCode 404 → 404', () => {
    expect(explainStorageError({ $metadata: { httpStatusCode: 404 } })).toEqual({
      status: 404,
      message: 'not found',
    })
  })

  it('S3 5xx upstream → 502 with status hint', () => {
    expect(explainStorageError({ $metadata: { httpStatusCode: 502 } })).toEqual({
      status: 502,
      message: 'S3 upstream error (HTTP 502)',
    })
    expect(explainStorageError({ $metadata: { httpStatusCode: 503 } })).toEqual({
      status: 502,
      message: 'S3 upstream error (HTTP 503)',
    })
  })

  it('SDK XML deserialize 失敗 (HTML エラーページが来た) → 502', () => {
    const result = explainStorageError({
      message: "Expected closing tag 'hr' (opened in line 5, col 1) instead of closing tag 'body'.:6:1\n  Deserialization error: ...",
    })
    expect(result?.status).toBe(502)
    expect(result?.message).toMatch(/non-XML/)
  })

  it('$response が付いてる SDK エラー → 502', () => {
    const result = explainStorageError({ $response: { body: '...' } })
    expect(result?.status).toBe(502)
  })

  it('S3 403 → 502 with auth hint', () => {
    expect(explainStorageError({ $metadata: { httpStatusCode: 403 } })).toEqual({
      status: 502,
      message: 'S3 access denied (check credentials and bucket permissions)',
    })
  })

  it('明らかに S3 関連でないエラー → null (呼び出し元に判断委譲)', () => {
    expect(explainStorageError({ message: 'some random non-storage error' })).toBeNull()
    expect(explainStorageError(new Error('totally unrelated'))).toBeNull()
  })

  it('S3 関連だがメッセージ長すぎ → 200 文字で切る', () => {
    const long = 'x'.repeat(500)
    const result = explainStorageError({
      $metadata: { httpStatusCode: 400 },
      message: long,
    })
    expect(result?.status).toBe(500)
    expect(result?.message.length).toBeLessThanOrEqual(200)
  })
})
