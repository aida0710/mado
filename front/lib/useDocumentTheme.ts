import { useEffect, useState } from 'react'
import type { Theme } from './useTheme'

function readDocumentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/**
 * useTheme が <html> に書いたテーマ。CSS の変数を使えない描画 (canvas、Monaco のテーマ) 用。
 * 属性を見張るので、上部バーで切り替えると描き直す。
 */
export function useDocumentTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readDocumentTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readDocumentTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
