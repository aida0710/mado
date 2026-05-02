import { describe, expect, it } from 'vitest'
import { encPath, encSegment } from './route'

describe('encSegment', () => {
  it('特殊文字を encode する', () => {
    expect(encSegment('foo bar')).toBe('foo%20bar')
    expect(encSegment('a?b')).toBe('a%3Fb')
    expect(encSegment('a#b')).toBe('a%23b')
    expect(encSegment('a%b')).toBe('a%25b')
  })

  it('空文字は空文字のまま', () => {
    expect(encSegment('')).toBe('')
  })

  it('スラッシュも encode する (= 単一セグメント扱い)', () => {
    expect(encSegment('a/b')).toBe('a%2Fb')
  })
})

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
