import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

interface Props {
  onClose: () => void
}

export function MetricsHelpModal({ onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const snippet = buildSnippet(window.location.origin)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('clipboard write failed', err)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--editor"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="metrics-help-title"
      >
        <header className="flex items-center gap-3 pb-3">
          <h3 id="metrics-help-title" className="m-0 flex-1">
            メトリクスの送り方
          </h3>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="ヘルプを閉じる"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-6">
          <Section title="送り方">
            <div className="relative">
              <pre className="m-0 max-h-72 overflow-auto whitespace-pre rounded-2 border border-ink-2 bg-ink-0 p-3 text-xs leading-snug">
                {snippet}
              </pre>
              <button
                type="button"
                className="ghost absolute right-2 top-2 text-xs"
                onClick={onCopy}
              >
                {copied ? 'copied' : 'copy'}
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-7">
              <code>{'<あなたの WRITE_TOKEN>'}</code> は <code>.env</code> の <code>WRITE_TOKEN</code> を、管理者から受け取って差し替えてください。
            </p>
            <p className="mt-1 text-xs text-ink-7">
              Python で動かしたい人は <code>metrics/</code> ディレクトリを参照。
            </p>
          </Section>

          <Section title={<><code>category</code> ってなに</>}>
            <p className="m-0 text-sm">
              自由文字列。同じ <code>category</code> のメトリクスがダッシュボード上で 1 つのセクションにまとめて表示される。例: <code>load</code>, <code>disk</code>, <code>ジョブ一覧</code>。
            </p>
          </Section>

          <Section title="古いデータは消えます">
            <p className="m-0 text-sm">
              直近 <strong>1 時間</strong>に push したものだけが画面に出る（DB には残る）。
            </p>
          </Section>

          <Section title="もっと知りたい人へ">
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
              <li><code>metrics/README.md</code> — Python 収集スクリプトの追加方法</li>
              <li><code>api/cron-samples/README.md</code> — bash 版 (<code>push.sh</code>) の使い方</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      {children}
    </section>
  )
}

function buildSnippet(origin: string): string {
  return [
    'uptime | curl -sS -X POST \\',
    '  -H "Authorization: Bearer <あなたの WRITE_TOKEN>" \\',
    '  -H "Content-Type: text/plain" \\',
    '  --data-binary @- \\',
    `  "${origin}/api/external/metrics/push?host=myhost&command=uptime&category=load"`,
  ].join('\n')
}
