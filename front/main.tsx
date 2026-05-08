import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

// ── Editorial type stack (self-hosted via @fontsource) ──────────────
// LAN/VPN 内ツールなので CDN には依存させず、Vite のバンドルに同梱する。
// ・Display serif: Newsreader (upright のみ)。筆記体は使わない。
// ・Body sans:    Public Sans (upright のみ)。
// ・Mono:         IBM Plex Mono。
// ・日本語:        Noto Sans JP のみ。明朝 (Noto Serif JP) は使わない。
import '@fontsource-variable/newsreader/opsz.css'         // serif display, optical sizing
import '@fontsource-variable/public-sans/wght.css'        // sans body
import '@fontsource/ibm-plex-mono/400.css'                // monospace (paths, code)
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/noto-sans-jp/japanese-400.css'        // 日本語 body
import '@fontsource/noto-sans-jp/japanese-500.css'
import '@fontsource/noto-sans-jp/japanese-700.css'

// MarkdownPreview の CSS は HomePage / ReadmeView の初回描画 (MDEditor.Markdown)
// で使うので eager。フルエディタの CSS は MarkdownEditor 自体に同梱して
// React.lazy のチャンクで初めてロードされるようにする (= 編集に進まない
// ユーザはダウンロードしない)。
import '@uiw/react-markdown-preview/markdown.css'
import App from './App.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
