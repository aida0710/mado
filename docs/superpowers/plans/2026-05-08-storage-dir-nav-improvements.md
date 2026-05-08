# Storage ディレクトリナビ UX 改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `StorageBrowser` のディレクトリ操作を、ブラウザ標準のリンク挙動 + コピー操作 + 読み込み可視化に揃える。

**Architecture:** 単一コンポーネント (`front/components/StorageBrowser.tsx`) の DOM 構造組み替え + CSS keyframes 追加。API・ルーティング・他ページは触らない。テストは vitest + React Testing Library で `api` を `vi.mock` してレンダリング検証する (本コンポーネント初のテストファイル新設)。

**Tech Stack:** React + react-router-dom, Tailwind, vitest + @testing-library/react

参照スペック: `docs/superpowers/specs/2026-05-08-storage-dir-nav-improvements-design.md`

---

## File Structure

- **Modify:** `front/components/StorageBrowser.tsx`
  - dir 行を `<Link>` 化 / dir 行に `CopyMenu` / 上部進捗バー + 旧内容 dim
  - `rowClass` の `focus-visible:` を `focus-within:` に変更
- **Modify:** `front/index.css`
  - `@keyframes storage-progress` + `.storage-progress` を追記
- **Create:** `front/components/StorageBrowser.test.tsx`
  - api を `vi.mock`、`MemoryRouter` で wrap、レンダリング/リンク href/CopyMenu 項目/進捗バー出現を検証

---

## Task 1: テストスキャフォールド + ディレクトリ行 Link 化

**Files:**
- Create: `front/components/StorageBrowser.test.tsx`
- Modify: `front/components/StorageBrowser.tsx` (dir 行を `<Link>`、`onClick` 撤去、rowClass の focus 切替)

### 背景

現在 dir 行は `<tr role="link" onClick={navigate}>`。`<tr>` は `<a>` ではないので Cmd/Ctrl+Click が効かず、新規タブで開けない。dir 名セルを実 `<Link>` (= `<a href>`) に変える。

### 設計判断

- `rowClass` の `focus-visible:bg-ink-1` は `tabIndex={0}` 前提だった。Link 化後は `<tr>` 自身が focus を受け取らないため、`focus-within:bg-ink-1` に差し替え。ファイル行 (tabIndex 持ち) でも `focus-within` は同じく発火するので一律置換でよい。
- name セルの padding を Link に移譲し (`td p-0` + `Link block px-2 py-2`)、行高は他列と同じ。
- ファイル行 (`role="button"` の preview drawer 開閉) は変更しない。

---

- [ ] **Step 1: テストファイルを作成して baseline + Link href のテストを書く (RED)**

`front/components/StorageBrowser.test.tsx` を作成:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageBrowser } from './StorageBrowser'

vi.mock('../lib/api/client', () => ({
  api: {
    list: vi.fn(),
    invalidateList: vi.fn(),
    downloadUrl: vi.fn(() => 'http://x/dl'),
  },
}))

import { api } from '../lib/api/client'

afterEach(() => {
  vi.clearAllMocks()
})

function renderBrowser(prefix = 'voice/') {
  return render(
    <MemoryRouter>
      <StorageBrowser connId="c1" bucket="b1" prefix={prefix} />
    </MemoryRouter>,
  )
}

describe('StorageBrowser - directory row', () => {
  it('renders directory name inside an <a href> for native cmd+click support', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
    })

    renderBrowser('voice/')

    const link = await screen.findByRole('link', { name: /jp\// })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/storage/c1/b1/voice/jp/')
  })
})
```

- [ ] **Step 2: テスト実行して fail を確認**

Run: `cd front && npx vitest run components/StorageBrowser.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "link" and name "jp/"` (現コードでは dir 名は `<td>` 内のテキストで、`role="link"` は `<tr>` についている)。

- [ ] **Step 3: `StorageBrowser.tsx` を修正して dir 行を Link 化**

`front/components/StorageBrowser.tsx`:

3-1. import に `Link` を追加:

```tsx
import { useNavigate, Link } from 'react-router-dom'
```

3-2. `rowClass` の focus 修飾子を差し替え (L26-27):

```tsx
const rowClass =
  'cursor-pointer transition-colors hover:bg-ink-0 focus-within:bg-ink-1'
```

3-3. dir 行 (L99-117) を以下に置換:

```tsx
{page.directories.map(d => {
  const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
  const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
  return (
    <tr key={d} className={rowClass}>
      <td className={`${tdNameClass} p-0`}>
        <Link
          to={dirHref}
          className="block px-2 py-2 font-semibold text-ink-11 no-underline"
        >
          📁 {tail}
        </Link>
      </td>
      <td className={tdNumClass}>—</td>
      <td className={tdNumClass}>—</td>
      <td className={tdNumClass}></td>
    </tr>
  )
})}
```

(`go` / `activate(go)` / `role` / `tabIndex` / `onClick` / `onKeyDown` を撤去。CopyMenu は次タスクで追加するため空 `<td>` のまま。)

- [ ] **Step 4: テストを実行して pass を確認**

Run: `cd front && npx vitest run components/StorageBrowser.test.tsx`
Expected: PASS — 1 test passed.

- [ ] **Step 5: 既存全体テスト実行で他に影響が無いか確認**

Run: `cd front && npm test`
Expected: 既存テストすべて pass (本コンポーネント以外の崩れなし)。

- [ ] **Step 6: コミット**

```bash
git add front/components/StorageBrowser.tsx front/components/StorageBrowser.test.tsx
git commit -m "feat(storage): ディレクトリ行を Link 化して cmd+click で新規タブを開けるように"
```

---

## Task 2: ディレクトリ行に CopyMenu 追加

**Files:**
- Modify: `front/components/StorageBrowser.tsx` (dir 行 4 列目に `<CopyMenu>`)
- Modify: `front/components/StorageBrowser.test.tsx` (CopyMenu 項目の検証テスト追加)

### 背景

ファイル行には Web URL / S3 URL / ダウンロードのコピーメニューがあるが、ディレクトリ行には無い。`s3://bucket/foo/` を貼り付けたいだけのときに URL バーから組み立てる必要があり面倒。`download` を除いた 2 項目で同等のメニューを出す。

`d` (CommonPrefix) は trailing slash 入り (`api/routes/storage-list.ts:73-75`)。`s3://bucket/foo/sub/` と末尾スラッシュ込みで出すのが S3 慣例。

---

- [ ] **Step 1: CopyMenu 項目のテストを追加 (RED)**

`front/components/StorageBrowser.test.tsx` の describe 内に追記:

```tsx
import userEvent from '@testing-library/user-event'

it('shows a copy menu on directory row with Web URL and S3 URL items', async () => {
  ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    directories: ['voice/jp/'],
    files: [],
    nextContinuation: null,
  })

  renderBrowser('voice/')
  await screen.findByRole('link', { name: /jp\// })

  const user = userEvent.setup()
  // 行は 1 件 (dir のみ)。CopyMenu の trigger ボタンを開く
  await user.click(screen.getByRole('button', { name: 'アクション' }))

  // Web URL 項目 (origin はテスト環境で http://localhost:3000 だが、
  // value 表示文字列に含まれているので部分一致で見る)
  expect(screen.getByRole('menuitem', { name: /Web URL をコピー/ })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /S3 URL をコピー/ })).toBeInTheDocument()

  // S3 URL の値が trailing slash 入りで s3://b1/voice/jp/ になっていること
  // (CopyMenu は item の value を title 属性 + 小さなプレビュー文字列に出す)
  const s3Item = screen.getByRole('menuitem', { name: /S3 URL をコピー/ })
  expect(s3Item).toHaveAttribute('title', 's3://b1/voice/jp/')
})
```

ファイル冒頭の import に `userEvent` を追加 (まだ無ければ):

```tsx
import userEvent from '@testing-library/user-event'
```

- [ ] **Step 2: テスト実行して fail を確認**

Run: `cd front && npx vitest run components/StorageBrowser.test.tsx -t "copy menu on directory row"`
Expected: FAIL — `Unable to find an accessible element with role "button" and name "アクション"` (dir 行に CopyMenu がまだ無い)。

- [ ] **Step 3: `StorageBrowser.tsx` の dir 行に CopyMenu を追加**

Task 1 で書いた dir 行を更に拡張。dir 行の中で `dirHref` の直後に items を組み立て、4 列目の空 `<td>` に `<CopyMenu items={items} />` を入れる:

```tsx
{page.directories.map(d => {
  const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
  const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
  const dirS3Url  = `s3://${bucket}/${d}`
  const dirWebUrl = `${window.location.origin}${dirHref}`
  const items: MenuItem[] = [
    { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
    { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url  },
  ]
  return (
    <tr key={d} className={rowClass}>
      <td className={`${tdNameClass} p-0`}>
        <Link
          to={dirHref}
          className="block px-2 py-2 font-semibold text-ink-11 no-underline"
        >
          📁 {tail}
        </Link>
      </td>
      <td className={tdNumClass}>—</td>
      <td className={tdNumClass}>—</td>
      <td className={tdNumClass}>
        <CopyMenu items={items} />
      </td>
    </tr>
  )
})}
```

- [ ] **Step 4: テスト実行して pass を確認**

Run: `cd front && npx vitest run components/StorageBrowser.test.tsx`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: コミット**

```bash
git add front/components/StorageBrowser.tsx front/components/StorageBrowser.test.tsx
git commit -m "feat(storage): ディレクトリ行に Web URL / S3 URL のコピーメニューを追加"
```

---

## Task 3: prefix 切替時の進捗バー表示

**Files:**
- Modify: `front/components/StorageBrowser.tsx` (return JSX を進捗バー + dim wrapper で囲む)
- Modify: `front/index.css` (`@keyframes storage-progress` + `.storage-progress` 追記)
- Modify: `front/components/StorageBrowser.test.tsx` (進捗バー出現のテスト追加)

### 背景

`useEffect([connId, bucket, prefix])` 内で `load(null)` するが `setPage(null)` していない。よって prefix 変更直後は古い `page` を表示したまま `loading=true` が立ち、視覚的フィードバックなしで「固まった」ように見える。テーブル真上に indeterminate progress bar を出し、内容を 60% 不透明 + pointer-events:none で「読み込み中」と分かる状態にする。

### 設計判断

- 初回ロード (`page === null`) は従来通り `'loading…'` テキスト。プログレスバーは「内容を持っているが新内容を読み込み中」の状況のため。
- バー領域は `<div h-[2px]>` を loading に関わらず常時描画 (バーアニメ要素だけ条件レンダ)。loading 切替で行高が変わってガタつかない。
- 色は `bg-ink-1` (背景) / `bg-ink-9` (バー)。テーマトークン流用でテーマ追従。
- `pointer-events:none` で読み込み中の二重 next/prev クリックを防止 (既存 `disabled` ロジックと整合)。
- アニメは `translateX(-100%) → translateX(400%)` の indeterminate (S3 list 応答時間が prefix で大きく変動するため決定的進捗より誠実)。

---

- [ ] **Step 1: 進捗バーのテストを追加 (RED)**

`front/components/StorageBrowser.test.tsx` の describe 内に追記。`api.list` の 2 回目呼び出しを deferred にして「読み込み中」状態をテスト中で固定する:

```tsx
it('shows a progress bar while a re-list is in flight (prefix change)', async () => {
  const listMock = api.list as ReturnType<typeof vi.fn>
  // 1 回目 (初回 mount): 即解決
  listMock.mockResolvedValueOnce({
    directories: ['voice/jp/'],
    files: [],
    nextContinuation: null,
  })
  // 2 回目 (prefix 変更後): 手動で resolve するまで pending
  let resolveSecond: (v: unknown) => void = () => {}
  listMock.mockReturnValueOnce(
    new Promise(res => { resolveSecond = res }),
  )

  const { rerender } = render(
    <MemoryRouter>
      <StorageBrowser connId="c1" bucket="b1" prefix="voice/" />
    </MemoryRouter>,
  )
  await screen.findByRole('link', { name: /jp\// })

  // prefix を変えると useEffect が走り 2 回目の load が始まる
  rerender(
    <MemoryRouter>
      <StorageBrowser connId="c1" bucket="b1" prefix="other/" />
    </MemoryRouter>,
  )

  // 2 回目が in-flight: api.list が 2 回呼ばれている
  await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))

  // 進捗バー要素が出る
  expect(document.querySelector('.storage-progress')).not.toBeNull()

  // 古い内容も dim 状態で残っている (link はまだ存在する)
  expect(screen.queryByRole('link', { name: /jp\// })).toBeInTheDocument()

  // 解決すれば消える
  resolveSecond({ directories: [], files: [], nextContinuation: null })
  await waitFor(() => expect(document.querySelector('.storage-progress')).toBeNull())
})
```

- [ ] **Step 2: テスト実行して fail を確認**

Run: `cd front && npx vitest run components/StorageBrowser.test.tsx -t "progress bar"`
Expected: FAIL — `expect(document.querySelector('.storage-progress')).not.toBeNull()` で null が返り fail。

- [ ] **Step 3: `index.css` に keyframes を追加**

`front/index.css` の末尾に追記:

```css
@keyframes storage-progress {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
.storage-progress {
  animation: storage-progress 1.1s ease-in-out infinite;
}
```

- [ ] **Step 4: `StorageBrowser.tsx` の return JSX を進捗バー + dim wrapper で囲む**

現 return ブロック (L87-181) を以下に置換:

```tsx
return (
  <div>
    {/* 進捗バー領域: 高さ 2px を常時確保しレイアウトシフトを避ける。
        loading 中だけバー要素を描画する。 */}
    <div className="relative h-[2px] w-full overflow-hidden bg-ink-1">
      {loading && <div className="storage-progress h-full w-1/3 bg-ink-9" />}
    </div>
    <div className={loading ? 'pointer-events-none opacity-60 transition-opacity' : 'transition-opacity'}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={headThClass}>Name</th>
            <th className={`${headThClass} text-right`}>Size</th>
            <th className={`${headThClass} text-right`}>Modified</th>
            <th className={headThClass}></th>
          </tr>
        </thead>
        <tbody>
          {page.directories.map(d => {
            const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
            const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
            const dirS3Url  = `s3://${bucket}/${d}`
            const dirWebUrl = `${window.location.origin}${dirHref}`
            const items: MenuItem[] = [
              { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
              { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url  },
            ]
            return (
              <tr key={d} className={rowClass}>
                <td className={`${tdNameClass} p-0`}>
                  <Link
                    to={dirHref}
                    className="block px-2 py-2 font-semibold text-ink-11 no-underline"
                  >
                    📁 {tail}
                  </Link>
                </td>
                <td className={tdNumClass}>—</td>
                <td className={tdNumClass}>—</td>
                <td className={tdNumClass}>
                  <CopyMenu items={items} />
                </td>
              </tr>
            )
          })}
          {page.files.map(f => {
            const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
            const select = () => onSelectFile?.(f.key)
            const s3Url = `s3://${bucket}/${f.key}`
            const webUrl =
              `${window.location.origin}` +
              `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}` +
              `?preview=${encodeURIComponent(f.key)}`
            const downloadUrl = api.downloadUrl(connId, bucket, f.key)
            const filename = f.key.split('/').pop() ?? 'file'
            const items: MenuItem[] = [
              { kind: 'download', label: 'このファイルをダウンロード', href: downloadUrl, filename },
              { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
              { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
            ]
            return (
              <tr
                key={f.key}
                className={rowClass}
                role="button"
                tabIndex={0}
                onClick={select}
                onKeyDown={activate(select)}
              >
                <td className={tdNameClass}>📄 {tail}</td>
                <td className={tdNumClass}>{fmtSize(f.size)}</td>
                <td className={tdNumClass}>{f.lastModified?.slice(0, 10) ?? ''}</td>
                <td className={tdNumClass}>
                  <CopyMenu items={items} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="flex items-center justify-center gap-3 py-3 tabular-nums">
        <button
          className="cursor-pointer rounded-2 border border-ink-3 bg-paper px-3 py-1 transition-colors hover:bg-ink-1 hover:border-ink-5 disabled:cursor-default disabled:opacity-40"
          onClick={prev}
          disabled={pageIdx === 0 || loading}
        >
          ← Prev
        </button>
        <span>page {pageIdx + 1}{page.nextContinuation ? '+' : ''}</span>
        <button
          className="cursor-pointer rounded-2 border border-ink-3 bg-paper px-3 py-1 transition-colors hover:bg-ink-1 hover:border-ink-5 disabled:cursor-default disabled:opacity-40"
          onClick={next}
          disabled={!page.nextContinuation || loading}
        >
          Next →
        </button>
        <button
          className="cursor-pointer rounded-2 border border-ink-3 bg-paper px-3 py-1 transition-colors hover:bg-ink-1 hover:border-ink-5 disabled:cursor-default disabled:opacity-40"
          onClick={forceRefresh}
          disabled={loading}
          title="キャッシュを破棄して再読み込み"
        >
          🔄
        </button>
      </div>
    </div>
  </div>
)
```

(変更点: 全体を `<div>` で wrap、進捗バー領域を上部に追加、`<table>` と pagination を loading 時 dim wrapper で囲む。テーブル本体・ファイル行・ページネーションは Task 1/2 から内容変更なし。)

- [ ] **Step 5: テスト実行して全 3 件 pass を確認**

Run: `cd front && npx vitest run components/StorageBrowser.test.tsx`
Expected: PASS — 3 tests passed.

- [ ] **Step 6: 既存全体テスト実行**

Run: `cd front && npm test`
Expected: 既存テストすべて pass。

- [ ] **Step 7: コミット**

```bash
git add front/components/StorageBrowser.tsx front/components/StorageBrowser.test.tsx front/index.css
git commit -m "feat(storage): prefix 切替時に上部進捗バー + 旧内容 dim でローディング可視化"
```

---

## Task 4: 手動ブラウザ確認

ユニットテストではアニメ・新規タブ実挙動・スクリーンリーダー読み上げまでは見られない。下記 8 項目を実機で確認。

- [ ] **Step 1: dev サーバ起動**

Run: `cd front && npm run dev`
ブラウザで `/storage/<conn>/<bucket>/<prefix>/` を開く。

- [ ] **Step 2: チェックリスト消化**

1. ディレクトリ行を **Cmd+Click** (mac) / **Ctrl+Click** (win): 新規タブで対象 prefix が開く
2. ディレクトリ行を **中クリック**: 新規タブで対象 prefix が開く
3. ディレクトリ行を **Shift+Click**: 新規ウィンドウで開く (ブラウザ依存)
4. ディレクトリ行を **通常クリック**: 同タブで navigate (従来挙動と同じ)
5. ディレクトリ行右の **⋯ メニュー**: Web URL / S3 URL の両方がコピーできる、貼り付けて期待通りの文字列であること
6. ディレクトリへ navigate 後: テーブル上部に細い進捗バー出現 + 旧内容が dim、ペイロード受信後に新内容に差し替わる
7. 同 prefix 内で **Next →**: 進捗バー出現 + 旧ページ dim
8. 1 ページ目初回ロード (page なし状態): 従来通り `'loading…'` テキスト表示
9. **Tab キー**: ディレクトリ行 Link → CopyMenu ボタン → 次行 Link, と移動でき、focus 中は行が `bg-ink-1` で光る

- [ ] **Step 3: 問題があれば修正後再テスト、無ければ完了**

問題なければ追加コミット不要。問題見つけたら原因に応じて Task 1〜3 のコードを修正し、対応するテストも追加してコミット。

---

## Self-Review

**1. Spec coverage:**
- 変更 1 (Link 化): Task 1 ✓
- 変更 2 (dir CopyMenu): Task 2 ✓
- 変更 3 (進捗バー + dim): Task 3 ✓
- focus-within への切替: Task 1 Step 3-2 ✓
- 手動確認チェックリスト全 8 項目: Task 4 ✓ (+ Shift+Click を追加して計 9)

**2. Placeholder scan:** TBD/TODO/「適切に...」「同様に...」なし。各ステップに具体コード/コマンド/期待出力あり。

**3. Type consistency:** `MenuItem`, `CopyMenu`, `Link`, `encPath`, `rowClass` 等の名前は既存コードと一致。dir items とファイル items で `kind: 'copy'` / `kind: 'download'` のフィールド形が CopyMenu の型定義と整合。

**4. Test独立性:** 各 it ブロックの先頭で `mockResolvedValueOnce` を呼ぶので前テストの mock が漏れない。`afterEach` で `vi.clearAllMocks()`。
