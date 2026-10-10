import { useMemo, useState } from 'react'
import { CODE_LANGUAGES, detectLanguage, isCodeLanguage, type CodeLanguage } from '@mado/design-tokens/code'

/** 'auto' は推測した形式に従う。それ以外は利用者が選んだ形式。 */
export type CodeLanguageChoice = CodeLanguage | 'auto'

// 利用者が拡張子ごとに選んだ形式。同じ種類のファイルを次に開いたときも同じ形式で見せる。
const STORAGE_KEY = 'mado.codeLanguage'
// .txt には何でも入るので、ある .txt で選んだ形式は次の .txt の手掛かりにならない。
const UNREMEMBERED_EXTENSIONS = new Set(['txt', 'text'])

/**
 * 選んだ形式を覚えるときの鍵。拡張子のほか、.env は '.env'、Dockerfile は 'dockerfile'。
 * 拡張子の無いほかの名前と .txt は '' で、覚えない。
 */
export function codeLanguageKey(fileName: string): string {
  const name = fileName.split('/').pop()?.toLowerCase() ?? ''
  if (name === '.env' || name.startsWith('.env.')) return '.env'
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  return UNREMEMBERED_EXTENSIONS.has(extension) ? '' : extension
}

/** 選択欄に出す形式の名前。テキストとログだけ日本語にする。 */
export function codeLanguageName(language: CodeLanguage): string {
  if (language === 'plaintext') return 'テキスト'
  if (language === 'log') return 'ログ'
  return CODE_LANGUAGES.find(item => item.id === language)?.name ?? language
}

function readChoices(): Record<string, CodeLanguage> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!stored || typeof stored !== 'object') return {}
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => isCodeLanguage(value)))
  } catch {
    return {}
  }
}

function storedChoice(key: string): CodeLanguageChoice {
  if (!key) return 'auto'
  const choices = readChoices()
  return Object.hasOwn(choices, key) ? choices[key]! : 'auto'
}

function writeChoice(key: string, choice: CodeLanguageChoice): void {
  const choices = readChoices()
  if (choice === 'auto') delete choices[key]
  else choices[key] = choice
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices))
  } catch {
    /* 保存できなくても、開いているプレビューには選んだ形式が効く。 */
  }
}

export interface CodeLanguageState {
  /** ファイル名と中身から推測した形式。 */
  detected: CodeLanguage
  choice: CodeLanguageChoice
  /** 色付けに使う形式。 */
  language: CodeLanguage
  setChoice: (choice: CodeLanguageChoice) => void
}

/**
 * 表示するテキストの形式。ファイル名、なければ中身から推測し (@mado/design-tokens/code)、
 * 利用者がこの拡張子で選んだ形式があればそちらを使う。
 */
export function useCodeLanguage(fileName: string, text: string): CodeLanguageState {
  const detected = useMemo(() => detectLanguage({ fileName, text }), [fileName, text])
  const key = codeLanguageKey(fileName)
  // このプレビューで選んだ形式。別のファイル (別の鍵) は保存から自分の形式を読む。
  const [picked, setPicked] = useState<{ key: string; choice: CodeLanguageChoice } | null>(null)
  const choice = picked?.key === key ? picked.choice : storedChoice(key)
  return {
    detected,
    choice,
    language: choice === 'auto' ? detected : choice,
    setChoice: next => {
      setPicked({ key, choice: next })
      if (key) writeChoice(key, next)
    },
  }
}
