import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'

// preview drawer の幅。既定はコンテナ幅追従 (clamp)。ユーザがハンドルで広げると
// リストは既定幅のまま保持し、drawer がその上に重なる (overlay)。
export const DRAWER_MIN_W = 320          // drawer の下限幅
export const DRAWER_MAX_DEFAULT_W = 720  // 既定 (未操作時) 幅の上限
export const DRAWER_FRACTION = 0.28      // 既定幅 = コンテナ幅のこの割合
export const DRAWER_MIN_LIST_VISIBLE = 220 // overlay 時に必ず残すリストの可視幅
export const DRAWER_KEYBOARD_STEP = 24    // 矢印キー 1 回の増減幅

const STORAGE_KEY = 'mado.ui.drawerWidth'

export interface DrawerVars {
  /** 既定幅 (画面追従)。これがリスト幅とグリッド列を決める基準。 */
  base: number
  /** ドラッグで広げられる上限 (= コンテナ幅 - リスト可視下限)。 */
  maxW: number
  /** drawer 要素の実幅。 */
  width: number
  /** グリッド第 2 列 (予約) 幅。width が base を超えたら base に固定し overlay。 */
  track: number
  /** track - width。width > base のとき負になり drawer が左へ重なる。 */
  marginLeft: number
}

// コンテナ幅と「ユーザ指定幅 (未指定なら null)」から CSS 変数値を算出する純関数。
// 縮める方向 (width < base) は track も縮めてリストを広げる (圧縮しない)。
// 広げる方向 (width > base) は track を base に保ち drawer を重ねる (圧縮しない)。
export function computeDrawerVars(containerW: number, effW: number | null): DrawerVars {
  const base = Math.round(
    Math.min(DRAWER_MAX_DEFAULT_W, Math.max(DRAWER_MIN_W, containerW * DRAWER_FRACTION)),
  )
  const maxW = Math.max(base, Math.round(containerW - DRAWER_MIN_LIST_VISIBLE))
  const width =
    effW == null ? base : Math.round(Math.min(maxW, Math.max(DRAWER_MIN_W, effW)))
  const track = Math.min(width, base)
  return { base, maxW, width, track, marginLeft: track - width }
}

function readStored(): number | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw == null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function writeStored(w: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(w)))
  } catch {
    /* localStorage 不可 — silent */
  }
}

function clearStored(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* localStorage 不可 — silent */
  }
}

interface DrawerResize {
  containerRef: RefObject<HTMLDivElement | null>
  onResizeStart: (e: ReactPointerEvent) => void
  onResizeKeyDown: (e: ReactKeyboardEvent) => void
  /** 既定 (画面追従) 幅に戻す。保存値も消す。 */
  resetWidth: () => void
  /** ユーザが幅を変更済みか (= 保存値あり)。リセットボタンの表示判定に使う。 */
  widthCustomized: boolean
}

// `.storage-list` に containerRef を付け、左端ハンドルに onResizeStart /
// onResizeKeyDown を渡す。幅は CSS 変数 (--drawer-track / --drawer-w / --drawer-ml)
// を直接書き込んで反映する (ドラッグ中は再レンダせず滑らかに動かすため)。
// enabled=false (preview 未選択) の間は何もしない。
export function useDrawerResize(enabled: boolean): DrawerResize {
  const containerRef = useRef<HTMLDivElement>(null)
  // ユーザ指定幅 (px)。null = 未操作 (= 画面追従の既定)。
  const widthRef = useRef<number | null>(readStored())
  // 保存値の有無 = リセットボタンの表示判定。ドラッグ確定/キー操作/リセットで更新。
  const [widthCustomized, setWidthCustomized] = useState<boolean>(() => readStored() != null)

  const apply = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const cw = el.clientWidth
    if (!cw) return
    const { width, track, marginLeft } = computeDrawerVars(cw, widthRef.current)
    el.style.setProperty('--drawer-track', `${track}px`)
    el.style.setProperty('--drawer-w', `${width}px`)
    el.style.setProperty('--drawer-ml', `${marginLeft}px`)
  }, [])

  // 初期反映 + コンテナ幅の変化に追従 (画面リサイズで既定/上限を再計算)。
  // paint 前に確定させてチラつきを防ぐため useLayoutEffect。
  useLayoutEffect(() => {
    if (!enabled) return
    apply()
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [enabled, apply])

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    const el = containerRef.current
    if (!el) return
    e.preventDefault()
    const cw = el.clientWidth
    const { base } = computeDrawerVars(cw, widthRef.current)
    const startX = e.clientX
    const startW = widthRef.current ?? base
    // ドラッグ中の文字選択を抑止。
    const prevUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      const cwNow = el.clientWidth || cw
      // 左へドラッグ (clientX 減) で拡大。
      const { width } = computeDrawerVars(cwNow, startW + (startX - ev.clientX))
      widthRef.current = width
      apply()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = prevUserSelect
      if (widthRef.current != null) {
        writeStored(widthRef.current)
        setWidthCustomized(true)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [apply])

  const onResizeKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const el = containerRef.current
    if (!el) return
    const left = e.key === 'ArrowLeft'
    const right = e.key === 'ArrowRight'
    if (!left && !right) return
    e.preventDefault()
    const cw = el.clientWidth
    const { base } = computeDrawerVars(cw, widthRef.current)
    const cur = widthRef.current ?? base
    // ArrowLeft = 広げる (drawer は左へ伸びる)、ArrowRight = 狭める。
    const { width } = computeDrawerVars(cw, cur + (left ? DRAWER_KEYBOARD_STEP : -DRAWER_KEYBOARD_STEP))
    widthRef.current = width
    apply()
    writeStored(width)
    setWidthCustomized(true)
  }, [apply])

  const resetWidth = useCallback(() => {
    widthRef.current = null
    clearStored()
    setWidthCustomized(false)
    apply() // 画面追従の既定値を再適用
  }, [apply])

  return { containerRef, onResizeStart, onResizeKeyDown, resetWidth, widthCustomized }
}
