// HTTPS / localhost 以外では navigator.clipboard が undefined になるため、
// execCommand('copy') にフォールバックする。
// LAN 内 HTTP 運用 (例: mado.lan.internal:80) のために必要。

export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. モダン API (secure context のみ)
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* legacy にフォールバック */
    }
  }

  // 2. レガシー: 一時 textarea + execCommand('copy')。HTTP でも動く。
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  // 画面外に置く (フォーカスで scroll が起きないように readonly + style)
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  try {
    ta.focus({ preventScroll: true })
    ta.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}
