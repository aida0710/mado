import { useId, useMemo } from 'react'
import { CODE_LANGUAGES, highlightCode, type CodeLanguage } from '@mado/design-tokens/code'
import { codeLanguageName, type CodeLanguageState } from '../lib/useCodeLanguage'

/**
 * 形式に合わせて色を付けたテキスト (@mado/design-tokens の code.css)。どちらのテーマでも
 * 暗い面に置く。className でプレビューごとの高さを足す。
 */
export function CodeView({ text, language, className }: { text: string; language: CodeLanguage; className?: string }) {
  const html = useMemo(() => highlightCode(text, language), [text, language])
  return (
    <pre className={className ? `code-view ${className}` : 'code-view'}>
      {/* highlightCode は文字を逃がしてあり、足すのは色のための span だけ。 */}
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

/** プレビューの帯に置く「表示形式」の選択欄。自動のときは推測した形式を括弧に出す。 */
export function CodeFormatSelect({ code }: { code: CodeLanguageState }) {
  const id = useId()
  return (
    <label className="code-format" htmlFor={id}>
      表示形式
      <select id={id} value={code.choice} onChange={event => code.setChoice(event.target.value as CodeLanguageState['choice'])}>
        <option value="auto">{`自動（${codeLanguageName(code.detected)}）`}</option>
        {CODE_LANGUAGES.map(language => (
          <option key={language.id} value={language.id}>
            {codeLanguageName(language.id)}
          </option>
        ))}
      </select>
    </label>
  )
}
