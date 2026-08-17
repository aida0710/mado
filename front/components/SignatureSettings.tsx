import { useState } from 'react'
import { getEditorName, setEditorName } from '../lib/editorName'

const sectionTitleClass =
  'm-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

// 署名名の設定。この端末だけに保存する (localStorage)。
//
// mado は認証を持たないので「誰が書いたか」は自己申告。サーバーに持たせると
// 端末をまたいで 1 つになってしまい、共用 PC で他人の名前のまま記録される。
export function SignatureSettings() {
  const [name, setName] = useState(() => getEditorName())
  const [saved, setSaved] = useState(false)

  const commit = (next: string) => {
    setName(next)
    setEditorName(next)
    setSaved(true)
  }

  return (
    <section className="mt-7">
      <div
        className="mb-3 flex items-baseline justify-between gap-3 pb-2"
        style={{ borderBottom: '1px solid var(--rule)' }}
      >
        <h3 className={sectionTitleClass}>署名</h3>
      </div>

      <label className="flex flex-wrap items-center gap-2 px-1 py-2">
        <span className="text-[13px] text-ink-11">名前</span>
        <input
          value={name}
          onChange={e => { setName(e.target.value); setSaved(false) }}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value) }}
          placeholder="e.g. tanaka"
          autoComplete="nickname"
          aria-label="署名名"
        />
        {saved && <span className="text-[12px] text-ink-7">保存しました</span>}
      </label>
      <p className="px-1 text-[12px] text-ink-7">
        README・共有ノートの編集者として記録されます。
        <strong>この端末にだけ保存され</strong>、他の人には影響しません。
      </p>
    </section>
  )
}
