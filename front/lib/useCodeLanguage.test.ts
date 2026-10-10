import { describe, expect, it } from 'vitest'
import { codeLanguageKey, codeLanguageName } from './useCodeLanguage'

describe('codeLanguageKey', () => {
  it('拡張子で覚え、.env と Dockerfile は名前で覚え、拡張子の無いほかの名前と .txt は覚えない', () => {
    expect(codeLanguageKey('runs/r1/config.YAML')).toBe('yaml')
    expect(codeLanguageKey('logs/stdout.out')).toBe('out')
    expect(codeLanguageKey('logs/train.txt')).toBe('')
    expect(codeLanguageKey('.env')).toBe('.env')
    expect(codeLanguageKey('deploy/.env.production')).toBe('.env')
    expect(codeLanguageKey('Dockerfile')).toBe('dockerfile')
    expect(codeLanguageKey('docker/Dockerfile.dev')).toBe('dockerfile')
    expect(codeLanguageKey('README')).toBe('')
    expect(codeLanguageKey('.bashrc')).toBe('')
  })
})

describe('codeLanguageName', () => {
  it('テキストとログは日本語、ほかは形式の名前', () => {
    expect(codeLanguageName('plaintext')).toBe('テキスト')
    expect(codeLanguageName('log')).toBe('ログ')
    expect(codeLanguageName('yaml')).toBe('YAML')
    expect(codeLanguageName('properties')).toBe('.env / properties')
  })
})
