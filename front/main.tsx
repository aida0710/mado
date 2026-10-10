import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

// ── 書体と色の変数 (Mado Model Tracking と共通) ─────────────────────
// LAN/VPN 内ツールなので CDN には依存させず、Vite のバンドルに同梱する。
// ・英字: IBM Plex Sans / IBM Plex Mono (@mado/design-tokens に同梱)。
// ・日本語: Noto Sans JP。
// 色・角丸・書体の変数も @mado/design-tokens から読み、App.css の @theme がそれを参照する。
import '@fontsource/noto-sans-jp/japanese-400.css'
import '@fontsource/noto-sans-jp/japanese-500.css'
import '@fontsource/noto-sans-jp/japanese-700.css'
import '@mado/design-tokens/fonts.css'
import '@mado/design-tokens/tokens.css'

import App from './App.tsx'
import { AuthGate } from './lib/auth.tsx'
import './index.css'

// React Router v7 の data router を使う (createBrowserRouter + RouterProvider)。
// 単純な BrowserRouter だと useBlocker (編集ページの離脱警告) が動かないため。
// 既存ルート定義は <App /> 内の <Routes> がそのまま握るので、ここは catch-all 1 本でよい。
const router = createBrowserRouter([
  { path: '*', element: <AuthGate><App /></AuthGate> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
