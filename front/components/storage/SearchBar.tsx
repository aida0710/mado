interface Props {
  q: string
  recursive: boolean
  isSearching: boolean
  onChangeQ: (next: string) => void
  onToggleRecursive: (next: boolean) => void
  onClear: () => void
}

// 検索 input + 再帰チェック + clear ボタン。debounce は親 (StorageBrowser) の
// onChangeQ ハンドラ内で setTimeout / useRef<timer> 管理。
export function SearchBar({ q, recursive, isSearching, onChangeQ, onToggleRecursive, onClear }: Props) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <input
        type="search"
        className={
          'flex-1 max-w-[480px] rounded-1 bg-paper px-3 py-1.5 text-[13px] ' +
          'transition-[border-color,box-shadow] focus:outline-none'
        }
        style={{
          border: '1px solid var(--color-rule-strong)',
          fontFamily: 'var(--font-sans)',
        }}
        placeholder={recursive
          ? 'このディレクトリ配下を検索 (前方一致・再帰)'
          : 'このディレクトリ内を検索 (前方一致)'}
        value={q}
        onChange={e => onChangeQ(e.target.value)}
        aria-label="ディレクトリ内検索"
      />
      <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-9">
        <input
          type="checkbox"
          checked={recursive}
          onChange={e => onToggleRecursive(e.target.checked)}
        />
        <span className="select-none">再帰検索</span>
      </label>
      {isSearching && (
        <button
          type="button"
          onClick={onClear}
          className={
            'cursor-pointer rounded-1 bg-paper px-2 py-1 text-[11px] ' +
            'font-semibold uppercase tracking-[0.16em] text-ink-7 ' +
            'transition-colors hover:bg-ink-1 hover:text-ink-11'
          }
          style={{ border: '1px solid var(--color-rule-strong)' }}
          aria-label="検索をクリア"
        >
          clear
        </button>
      )}
    </div>
  )
}
