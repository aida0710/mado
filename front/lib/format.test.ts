import { describe, expect, it } from 'vitest'
import { prettyPrintJson } from './format'

describe('prettyPrintJson', () => {
  it('.json は minify されていても整形する', () => {
    expect(prettyPrintJson('a.json', '{"a":1,"b":2}')).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })

  it('.jsonl / .ndjson は 1 行 1 JSON 値なので整形しない', () => {
    expect(prettyPrintJson('a.jsonl', '{"a":1}\n{"b":2}')).toBe('{"a":1}\n{"b":2}')
    expect(prettyPrintJson('a.ndjson', '{"a":1}\n{"b":2}')).toBe('{"a":1}\n{"b":2}')
  })

  it('不正な JSON はそのまま返す', () => {
    expect(prettyPrintJson('bad.json', '{oops not json')).toBe('{oops not json')
  })

  it('json 以外の拡張子はそのまま返す', () => {
    expect(prettyPrintJson('a.txt', '{"a":1}')).toBe('{"a":1}')
    expect(prettyPrintJson('README', 'hello')).toBe('hello')
  })

  it('拡張子の大小文字を問わない', () => {
    expect(prettyPrintJson('A.JSON', '{"a":1}')).toBe('{\n  "a": 1\n}')
  })
})
