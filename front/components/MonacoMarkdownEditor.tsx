// VSCode と同じ Monaco エディタを Markdown 編集用に薄くラップしたコンポーネント。
//
// LAN ツール用なので CDN から monaco をフェッチさせず、bundle 同梱の monaco-editor を
// 強制利用する (loader.config({ monaco })) 。Vite の ?worker import で editor.worker
// も自動的に同梱される (markdown は専用 language worker を持たない)。
//
// 親 (ReadmeEditPage / NoteEditPage) は ref から insertAtCursor を呼んでファイル名や
// パスを Monaco の現在カーソル位置へ挿入する。

import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import type { editor as monacoEditor } from 'monaco-editor'
import { useDocumentTheme } from '../lib/useDocumentTheme'
import type { Theme } from '../lib/useTheme'

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment
  }
}

// モジュール初回 import 時に 1 回だけ走る。冪等 (idempotent) なガード付き。
if (typeof self !== 'undefined' && !self.MonacoEnvironment) {
  self.MonacoEnvironment = { getWorker: () => new editorWorker() }
  loader.config({ monaco })
}

const THEME_NAMES: Record<Theme, string> = { light: 'mado-light', dark: 'mado-dark' }

/** tokens.css の色 (#rgb / #rrggbb) を #rrggbb で読む。読めなければ undefined (Monaco の既定のまま)。 */
function readColor(style: CSSStyleDeclaration, name: string): string | undefined {
  const value = style.getPropertyValue(name).trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map(c => c + c).join('')}`
  return undefined
}

/** #rrggbb に不透明度 (0〜1) を足して #rrggbbaa にする。 */
function withAlpha(color: string | undefined, alpha: number): string | undefined {
  return color && color + Math.round(alpha * 255).toString(16).padStart(2, '0')
}

/**
 * いまの <html data-theme> の token の値で Monaco のテーマを定義する。
 * Monaco は CSS の変数を解決できないので、getComputedStyle で値を読んで渡す。
 * ライトは vs、ダークは vs-dark を元にし、地・文字・行番号・選択範囲を mado の色にする。
 */
function defineMadoTheme(theme: Theme): void {
  const style = getComputedStyle(document.documentElement)
  const background = readColor(style, '--background')
  const text = readColor(style, '--text')
  const accent = readColor(style, '--accent')
  const entries: Array<[string, string | undefined]> = [
    ['editor.background', background],
    ['editor.foreground', text],
    ['editorGutter.background', background],
    ['editorLineNumber.foreground', readColor(style, '--muted')],
    ['editorLineNumber.activeForeground', text],
    ['editor.lineHighlightBackground', readColor(style, '--surface')],
    ['editorCursor.foreground', text],
    ['editor.selectionBackground', withAlpha(accent, 0.3)],
    ['editor.inactiveSelectionBackground', withAlpha(accent, 0.15)],
    ['editorIndentGuide.background1', readColor(style, '--border')],
    ['editorIndentGuide.activeBackground1', readColor(style, '--border-strong')],
    ['editorWhitespace.foreground', readColor(style, '--border-strong')],
    ['focusBorder', accent],
  ]
  const colors = Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[1] !== undefined))
  monaco.editor.defineTheme(THEME_NAMES[theme], {
    base: theme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors,
  })
}

export interface MonacoMarkdownEditorHandle {
  insertAtCursor(text: string): void
  focus(): void
}

interface Props {
  value: string
  onChange: (next: string) => void
  height?: string | number
  ariaLabel?: string
}

export const MonacoMarkdownEditor = forwardRef<MonacoMarkdownEditorHandle, Props>(
  function MonacoMarkdownEditor({ value, onChange, height = '100%', ariaLabel }, ref) {
    const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null)
    const theme = useDocumentTheme()

    // テーマが変わるたびに、その時点の token の値で定義し直す。layout effect は Editor の
    // (passive な) effect より先に走るので、Editor が setTheme する前に定義が済む。
    useLayoutEffect(() => {
      defineMadoTheme(theme)
    }, [theme])

    const options = useMemo<monacoEditor.IStandaloneEditorConstructionOptions>(() => ({
      ariaLabel,
      wordWrap: 'on',
      minimap: { enabled: false },
      // 書体も tokens.css (--mono) から読む。Monaco は CSS の変数を解決しない。
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
      fontSize: 13,
      lineHeight: 21,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'gutter',
      padding: { top: 12, bottom: 12 },
      fontLigatures: false,
      smoothScrolling: true,
      // markdown では IntelliSense が頻発しないので suggest UI は控えめ
      quickSuggestions: false,
      // ハイライトは markdown の見た目を阻害しないように
      occurrencesHighlight: 'off',
    }), [ariaLabel])

    useImperativeHandle(ref, () => ({
      insertAtCursor(text) {
        const ed = editorRef.current
        if (!ed) return
        const sel = ed.getSelection()
        if (sel) {
          ed.executeEdits('mado.insert', [{
            range: sel,
            text,
            forceMoveMarkers: true,
          }])
        } else {
          // フォーカス外 / 選択なし時は末尾に挿入。
          const model = ed.getModel()
          if (!model) return
          const lastLine = model.getLineCount()
          const lastCol = model.getLineMaxColumn(lastLine)
          ed.executeEdits('mado.insert', [{
            range: new monaco.Range(lastLine, lastCol, lastLine, lastCol),
            text,
            forceMoveMarkers: true,
          }])
        }
        ed.focus()
      },
      focus() { editorRef.current?.focus() },
    }), [])

    return (
      <Editor
        value={value}
        onChange={v => onChange(v ?? '')}
        language="markdown"
        height={height}
        theme={THEME_NAMES[theme]}
        onMount={ed => { editorRef.current = ed }}
        options={options}
        loading={<p className="muted">エディタを読み込み中…</p>}
      />
    )
  },
)
