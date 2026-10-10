import { Search, X } from 'lucide-react'

interface Props {
  q: string
  recursive: boolean
  isSearching: boolean
  onChangeQ: (next: string) => void
  onToggleRecursive: (next: boolean) => void
  onClear: () => void
}

// 一覧の上の帯 (.storage-toolbar) に置く、検索欄 + 再帰チェック + クリア。
// 帯そのものは StorageBrowser が持ち、タグの絞り込みも同じ帯に並べる。
// debounce は親 (StorageBrowser) の onChangeQ ハンドラ内で setTimeout / useRef<timer> 管理。
export function SearchBar({ q, recursive, isSearching, onChangeQ, onToggleRecursive, onClear }: Props) {
  return (
    <>
      <div className="storage-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          placeholder={recursive
            ? 'このディレクトリ配下を検索 (前方一致・再帰)'
            : 'このディレクトリ内を検索 (前方一致)'}
          value={q}
          onChange={e => onChangeQ(e.target.value)}
          aria-label="ディレクトリ内検索"
        />
        {isSearching && (
          <button
            type="button"
            className="icon-button"
            onClick={onClear}
            aria-label="検索をクリア"
            title="検索をクリア"
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      <label className="storage-toolbar-item storage-toolbar-check">
        <input
          type="checkbox"
          checked={recursive}
          onChange={e => onToggleRecursive(e.target.checked)}
        />
        再帰検索
      </label>
    </>
  )
}
