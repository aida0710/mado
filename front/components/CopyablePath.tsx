import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { copyToClipboard } from '../lib/clipboard'

interface Props {
  // 画面に出す短い名前 (basename)。幅が足りないので truncate される。
  text: string
  // ホバーで見せ、クリックでクリップボードに載せる省略しないフルパス。
  fullPath: string
  className?: string
  style?: CSSProperties
}

// ファイル名の見出し。デッキのトラック行とピンカードのヘッダで共有する。
//
// 表示は basename だけ (フルパスは長すぎてどちらの枠にも収まらない) だが、
// それだけだと tar 内エントリがどのアーカイブの何なのか辿れない。title で
// フルパスを見せ、クリックで丸ごとコピーできるようにして補う。
//
// .ghost は使わない — 罫線と padding が付き、密なドックの中でファイル名が
// ボタンの箱に見えてしまう。素の button に留めて hover の下線だけを手掛かりにする。
export function CopyablePath({ text, fullPath, className, style }: Props) {
  const [feedback, setFeedback] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 1.5 秒後に戻す timeout は、その前にカードが外されると unmount 後の
  // setState になる (ピンは ✕ 一発で消える)。unmount で必ず止める。
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const onCopy = async (): Promise<void> => {
    const ok = await copyToClipboard(fullPath)
    setFeedback(ok ? 'コピーしました ✓' : 'コピー失敗')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setFeedback(null), 1500)
  }

  return (
    <button
      type="button"
      className={
        'cursor-pointer truncate border-0 bg-transparent p-0 text-left hover:underline' +
        (className ? ` ${className}` : '')
      }
      style={style}
      title={fullPath}
      aria-label={`パスをコピー: ${fullPath}`}
      onClick={() => void onCopy()}
    >
      {feedback ?? text}
    </button>
  )
}
