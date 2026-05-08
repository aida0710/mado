import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
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
