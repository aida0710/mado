# Storage ディレクトリナビゲーション UX 改善

## 背景

`StorageBrowser` のディレクトリ行は JS ナビ (`<tr onClick={navigate(...)}>`) で実装されており、以下のペインポイントがある:

1. **新規タブで開けない** — `<tr>` は `<a>` ではないので Cmd/Ctrl+Click や中クリックがネイティブに動作しない。複数のディレクトリを並行して見たい場面で操作が破綻する。
2. **ディレクトリの URL 共有が手間** — ファイル行には Web URL / S3 URL のコピー機能があるが、ディレクトリ行には無い。`s3://bucket/foo/` を貼り付けたいだけのときに URL バーから組み立てる必要がある。
3. **ディレクトリ間ナビ時に固まって見える** — `useEffect([connId, bucket, prefix])` で `load(null)` が走るが `setPage(null)` していないため、古い `page` を表示したまま `loading=true` だけが立つ。視覚的フィードバックが無いので「クリックしても何も起きない」と感じる。

## 目的

`StorageBrowser` のディレクトリ操作を、ブラウザの一般的なリンク操作・コピー操作・読み込み待ちのお作法に揃える。本変更は単一コンポーネント (+ CSS 1 箇所) で完結する小規模リファクタ。

## 影響ファイル

- `front/components/StorageBrowser.tsx` — 主な変更
- `front/index.css` — 進捗バー用 `@keyframes` 追加

API・ルーティング・他のページコンポーネントは触らない。

## 変更 1: ディレクトリ行を `<Link>` 化

### 現状

```tsx
const go = () => navigate(`/storage/.../${encPath(d)}`)
<tr role="link" tabIndex={0} onClick={go} onKeyDown={activate(go)}>
  <td className={`${tdNameClass} font-semibold`}>📁 {tail}</td>
  <td>—</td><td>—</td><td></td>
</tr>
```

### 変更後

```tsx
const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
<tr key={d} className={rowClass}>
  <td className={`${tdNameClass} font-semibold p-0`}>
    <Link
      to={dirHref}
      className="block px-2 py-2 text-ink-11 no-underline"
    >
      📁 {tail}
    </Link>
  </td>
  <td className={tdNumClass}>—</td>
  <td className={tdNumClass}>—</td>
  <td className={tdNumClass}><CopyMenu items={dirItems} /></td>
</tr>
```

### 設計判断

- **行全体クリック (`onClick={go}` on `<tr>`) は外す。** Link を踏まずに size/modified 列をクリックしてもナビしないが、ユーザは通常ディレクトリ名を狙うため UX 体感差は小さい。代わりに cmd/ctrl/middle/shift クリックの修飾キー検出ボイラープレートが消えるためコードがクリーン。
- **name セルの padding を Link に移譲。** `td p-0` + `Link block px-2 py-2` で同じ行高を維持しつつ、Link がセル全幅クリック領域になる。
- **`role="link"` / `tabIndex={0}` / `onKeyDown` は撤去。** `<Link>` (= `<a>`) が正しい semantics・tab focus・Enter 起動をネイティブに持つ。スクリーンリーダー的にも改善。
- **focus 表示の調整。** 現 `rowClass` の `focus-visible:bg-ink-1` は `tabIndex={0}` 前提で機能していた。Link 化後は `<tr>` 自身が focus を受け取らないので、`focus-within:bg-ink-1` に変更し「行内の Link が focus されたら行をハイライト」する形にする。ファイル行 (`tr` 自身が focusable) でも `focus-within` は同様に発火するので、`rowClass` を一律差し替えれば足りる。
- ファイル行 (`<tr role="button" onClick={select}>`) はそれ以外変更しない — preview drawer 開閉なのでナビではなく、cmd+click 期待されない。

### 副次効果

- 中クリック → 新規タブ ✓
- Cmd/Ctrl+Click → 新規タブ ✓
- Shift+Click → 新規ウィンドウ ✓
- リンクの右クリック → コンテキストメニュー (URL コピー等) ✓
- Tab フォーカス時にアウトライン表示 ✓ (既存 `focus-visible:bg-ink-1` の row hover が消えるが、Link 自身が focus される)

## 変更 2: ディレクトリ行に CopyMenu 追加

### 仕様

ファイル行の CopyMenu と同型で、`download` 項目を除いた 2 項目構成:

```tsx
const dirS3Url  = `s3://${bucket}/${d}`              // d は trailing slash 入り
const dirWebUrl = `${window.location.origin}${dirHref}`
const dirItems: MenuItem[] = [
  { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
  { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url  },
]
```

### 設計判断

- **`d` (= `CommonPrefix`) は trailing slash 入り** (`api/routes/storage-list.ts:73-75` で S3 の `Prefix` をそのまま返している)。`s3://bucket/foo/sub/` のようにスラッシュが付くのが S3 慣例で、貼り付け先の AWS CLI や Console でも問題ない。
- **`download` 項目は出さない。** 現 API はディレクトリ単位のダウンロードを提供していない (ファイルだけ `downloadUrl`)。将来 zip 等を実装するなら追加検討。
- **ファイル行と同じ `<CopyMenu>` コンポーネント** を再利用。既存の "コピー失敗時のフィードバック" や "Escape で閉じる" 挙動はそのまま継承。

## 変更 3: ローディング表示 (上部進捗バー)

### 現状の問題

```tsx
useEffect(() => {
  setHistory([null])
  setPageIdx(0)
  load(null)         // setLoading(true) はするが setPage(null) しない
}, [connId, bucket, prefix])

if (!page) return <p>{loading ? 'loading…' : ''}</p>   // page は古い値で残るので通らない
return <table>...</table>                                // 古い内容を表示し続ける
```

prefix 変更後 → 古い内容のまま fetch 中 → 完了したら新内容に差し替わる。視覚フィードバックなし。

### 変更後

```tsx
if (error) return <p className="error">{error}</p>
if (!page) return <p className="text-ink-7">{loading ? 'loading…' : ''}</p>

return (
  <div>
    {/* 進捗バー領域: 高さは常時 2px 確保しレイアウトシフトを避ける */}
    <div className="relative h-[2px] w-full overflow-hidden bg-ink-1">
      {loading && <div className="storage-progress h-full w-1/3 bg-ink-9" />}
    </div>
    {/* 旧内容を残しつつ操作不可・薄表示にする */}
    <div className={loading ? 'pointer-events-none opacity-60 transition-opacity' : 'transition-opacity'}>
      <table>...</table>
      <div className="pagination">...</div>
    </div>
  </div>
)
```

`front/index.css` に追加:

```css
@keyframes storage-progress {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
.storage-progress {
  animation: storage-progress 1.1s ease-in-out infinite;
}
```

### 設計判断

- **初回ロード (`page === null`) は今まで通り `'loading…'` テキスト** のままにする。プログレスバーはあくまで「内容を持っているが新内容を読み込み中」のための表示。
- **進捗バーは "indeterminate" (時間不明)**。S3 list は応答までの時間が prefix によって 100ms〜数秒と幅があるため、決定的進捗より indeterminate の方が誠実。
- **pointer-events:none** で読み込み中の next/prev 二重押しを防ぐ。既存の `disabled` ロジックと整合 (見た目も操作も両方止まる)。
- **opacity 60% + transition** で「読み込み中であること」を視覚的に伝えつつ、内容自体は読める状態を維持。
- **進捗バー領域は高さ 2px を常時確保** (loading でなくても `<div h-[2px] bg-ink-1>` を出す)。loading の有無で行高が変わるとテーブルがガタつくため。
- 色は既存トークン (`bg-ink-1` 背景 / `bg-ink-9` バー) を流用。テーマ変更にも追従。

## テスト

`StorageBrowser` には現時点でテストファイルが無く、本変更は DOM 構造 + 既存ハンドラの組み替えに留まるため、自動テストは追加せず手動ブラウザ確認で完結させる:

1. ディレクトリ行を **Cmd+Click**: 新規タブで対象 prefix が開く
2. ディレクトリ行を **中クリック**: 新規タブで対象 prefix が開く
3. ディレクトリ行を **クリック**: 同タブで navigate (既存挙動と同じ)
4. ディレクトリ行右の **⋯ メニュー**: Web URL / S3 URL の両方がコピーできる
5. ディレクトリへ navigate 後: テーブル上部に進捗バー出現 + 旧内容が dim
6. 同 prefix 内で **Next →**: 進捗バー出現 + 旧ページ dim
7. 1 ページ目初回ロード (page なし状態): 従来通り `'loading…'` テキスト
8. Tab キー: ディレクトリ行の Link → CopyMenu → 次行の Link, と移動できる

## ロールバック

単一コンポーネント + CSS 数行の変更で、API・データモデル・URL スキーマに影響なし。問題があればコミットを revert すれば復旧する。
