import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

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

import App from './App.tsx'
import './index.css'

// React Router v7 の data router を使う (createBrowserRouter + RouterProvider)。
// 単純な BrowserRouter だと useBlocker (編集ページの離脱警告) が動かないため。
// 既存ルート定義は <App /> 内の <Routes> がそのまま握るので、ここは catch-all 1 本でよい。
const router = createBrowserRouter([
  { path: '*', element: <App /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
