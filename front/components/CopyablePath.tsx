import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { copyToClipboard } from '../lib/clipboard'

interface Props {
  // 画面に出す短い名前 (basename)。幅が足りないので末尾を省略する。
  text: string
  // ホバーで見せ、クリックでクリップボードに載せる省略しないフルパス。
  fullPath: string
  className?: string
}

// ファイル名の見出し。デッキのトラック行とピンカードのヘッダで共有する。
//
// 表示は basename だけ (フルパスは長すぎてどちらの枠にも収まらない) だが、
// それだけだと tar 内エントリがどのアーカイブの何なのか辿れない。title で
// フルパスを見せ、クリックで丸ごとコピーできるようにして補う。
//
// 枠は付けない — 密なドックの中でファイル名がボタンの箱に見えてしまう。
// hover の下線だけを手掛かりにする (見た目は preview.css の .copyable-path)。
export function CopyablePath({ text, fullPath, className }: Props) {
  const [copied, setCopied] = useState<boolean | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 1.5 秒後に戻す timeout は、その前にカードが外されると unmount 後の
  // setState になる (ピンはボタン一発で消える)。unmount で必ず止める。
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const onCopy = async (): Promise<void> => {
    setCopied(await copyToClipboard(fullPath))
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 1500)
  }

  return (
    <button
      type="button"
      className={className ? `copyable-path ${className}` : 'copyable-path'}
      title={fullPath}
      aria-label={`パスをコピー: ${fullPath}`}
      onClick={() => void onCopy()}
    >
      {copied && <Check size={14} aria-hidden="true" />}
      <span className="copyable-path-text">
        {copied == null ? text : copied ? 'コピーしました' : 'コピー失敗'}
      </span>
    </button>
  )
}
