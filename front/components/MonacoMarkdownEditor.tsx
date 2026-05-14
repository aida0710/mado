// VSCode と同じ Monaco エディタを Markdown 編集用に薄くラップしたコンポーネント。
//
// LAN ツール用なので CDN から monaco をフェッチさせず、bundle 同梱の monaco-editor を
// 強制利用する (loader.config({ monaco })) 。Vite の ?worker import で editor.worker
// も自動的に同梱される (markdown は専用 language worker を持たない)。
//
// 親 (ReadmeEditPage / NoteEditPage) は ref から insertAtCursor を呼んでファイル名や
// パスを Monaco の現在カーソル位置へ挿入する。

import { forwardRef, useImperativeHandle, useRef } from 'react'
import Editor, { type Monaco, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { editor as monacoEditor } from 'monaco-editor'

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

    const handleMount = (ed: monacoEditor.IStandaloneCodeEditor, m: Monaco) => {
      editorRef.current = ed
      // editorial: paper bg + ink-12 (ほぼ黒) のカーソル。base 'vs' (light) を継承して
      // 必要色だけ paper 系に置き換える。Monaco は canvas で描画するので CSS 変数は
      // 解決されない — 色を直値で指定する。
      m.editor.defineTheme('mado-paper', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
          'editor.background':              '#faf9f5', // --color-paper
          'editor.foreground':              '#16140f', // --color-ink-11
          'editorLineNumber.foreground':    '#7a7565',
          'editorLineNumber.activeForeground': '#16140f',
          'editor.lineHighlightBackground': '#f3f0e6',
          'editor.lineHighlightBorder':     '#00000000',
          'editorCursor.foreground':        '#0a0904',
          'editor.selectionBackground':     '#dad4c2',
          'editor.inactiveSelectionBackground': '#e8e3d2',
          'editorIndentGuide.background':   '#ebe5d2',
          'editorIndentGuide.activeBackground': '#cfc8b6',
          'editorWhitespace.foreground':    '#cdc6b3',
        },
      })
      m.editor.setTheme('mado-paper')
    }

    return (
      <Editor
        value={value}
        onChange={v => onChange(v ?? '')}
        language="markdown"
        height={height}
        onMount={handleMount}
        aria-label={ariaLabel}
        options={{
          wordWrap: 'on',
          minimap: { enabled: false },
          // Monaco は canvas 描画なので CSS 変数を解決しない。フォント名を直で指定。
          fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
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
        }}
        loading={
          <p className="text-[12px] text-ink-7" style={{ padding: 'var(--space-3)' }}>
            エディタを読み込み中…
          </p>
        }
      />
    )
  },
)
