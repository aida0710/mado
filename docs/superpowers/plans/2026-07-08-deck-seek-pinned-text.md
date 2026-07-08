# デッキ波形シーク + ピンカードテキスト固定高さ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** デッキのトラック波形クリックで全トラックをシークできるようにし、ピンカードの JSON/テキストを固定高さ + スクロールで表示する。

**Architecture:** front のみ。PlayerDeck の各 Waveform に `onSeek={ratio => seekAll(ratio * maxDuration)}` を渡す。PinnedPreviewCard のテキスト表示を固定高さ (280px) の共通コンポーネント `PinnedTextBody` に統一する（単体ファイル・tar エントリ両方）。

**Tech Stack:** React 19 / vitest / jsdom

**Spec:** `docs/superpowers/specs/2026-07-08-deck-seek-pinned-text-design.md`

## Global Constraints

- ブランチ: feature/audio-explorer。コミットは feat:/fix: + 日本語、amend なし、git stash 禁止
- front lint は main 由来の既存 4 エラーが baseline（新規禁止）
- ドロワーの `PreviewText`（max-h-70vh）は変更しない（プレビューは全高で見る）
- 固定高さは `h-[280px]`（音声カードのスペクトログラム相当）
- 検証は各タスクで `cd front && npx vitest run <対象> && npm test && npx tsc -b && npm run lint`

---

### Task 1: デッキ波形のクリックシーク

**Files:**
- Modify: `front/components/PlayerDeck.tsx`
- Test: `front/components/PlayerDeck.test.tsx`（既存に追記）

**Interfaces:**
- Consumes: 既存 `seekAll(sec)` / `maxDuration` / `Waveform` の `onSeek?: (ratio) => void`

- [ ] **Step 1: 失敗するテストを書く**

`front/components/PlayerDeck.test.tsx` に追記（既存の 2 トラック追加 + duration 注入ヘルパーの流儀に合わせる。波形は `role="slider"`）:

```ts
it('トラック波形クリックで全トラックがその時刻へシークする', () => {
  // a: 長さ1, b: 長さ3 を追加し duration を注入 (maxDuration=3)。
  // 1 本目のトラック波形 (canvas role="slider") を取得し、getBoundingClientRect を
  // { left:0, width:100, ... } にモックして clientX=50 で click → ratio=0.5。
  // seekAll(0.5 * 3 = 1.5) 相当: a は Math.min(1.5,1)=1 (終端), b は 1.5、
  // マスター表示が 0:01 / 0:03 になることを assert。
})
```

注意: 既存 PlayerDeck.test は波形 slider の getBoundingClientRect をモックする Waveform.test の手法（`vi.spyOn(el, 'getBoundingClientRect')`）と、duration/currentTime 制御の手法（`Object.defineProperty` + `fireEvent.loadedMetadata`）を持つ。両方を組み合わせて、click 後に各 audio の currentTime とマスター表示を検証する。テストが通る形が正。

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run components/PlayerDeck.test.tsx`
Expected: FAIL（onSeek 未配線でクリックしても currentTime が動かない）

- [ ] **Step 3: 実装**

`front/components/PlayerDeck.tsx` の各トラック行の `<Waveform>`（`peaks` / `progress` / `durationRatio` / `height` を渡している箇所）に `onSeek` を追加:

```tsx
                  <Waveform
                    peaks={peaksById[t.id] ?? []}
                    progress={maxDuration > 0 ? masterTime / maxDuration : 0}
                    durationRatio={maxDuration > 0 ? (durations[t.id] ?? 0) / maxDuration : 1}
                    onSeek={maxDuration > 0 ? ratio => seekAll(ratio * maxDuration) : undefined}
                    height={28}
                  />
```

（`maxDuration === 0` のときは onSeek を渡さない = クリック無効。durations 取得後は有効になる。）

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run components/PlayerDeck.test.tsx && npm test && npx tsc -b && npm run lint`
Expected: PASS（既存デッキテスト維持、lint baseline 4）

- [ ] **Step 5: Commit**

```bash
git add front/components/PlayerDeck.tsx front/components/PlayerDeck.test.tsx
git commit -m "feat: デッキのトラック波形クリックで全トラックをシークする"
```

---

### Task 2: ピンカードのテキストを固定高さ + スクロール

**Files:**
- Modify: `front/components/PinnedPreviewCard.tsx`
- Test: `front/components/PinnedPreviewCard.test.tsx`（既存に追記）

**Interfaces:**
- Produces: `PinnedTextBody`（カード内部の共通テキスト表示、固定高さ 280px + overflow-auto）

- [ ] **Step 1: 失敗するテストを書く**

`front/components/PinnedPreviewCard.test.tsx` に追記（既存のカードテストが api をモックしている流儀に合わせる。`api.textPreview` と `api.tarEntryText` をモックして固定文字列を返す）:

```tsx
it('単体テキストファイルのピンは固定高さの pre で表示される', async () => {
  vi.mocked(api.textPreview).mockResolvedValue('{"a":1}')
  render(<PinnedPreviewCard item={{ id: 'i1', connId: 'c', bucket: 'b', key: 'x.json' }} />)
  const pre = await screen.findByText('{"a":1}')
  expect(pre.tagName).toBe('PRE')
  expect(pre.className).toContain('h-[280px]')
})

it('tar エントリのテキストも固定高さの pre で表示される', async () => {
  vi.mocked(api.tarEntryText).mockResolvedValue('hello')
  render(<PinnedPreviewCard item={{ id: 'i2', connId: 'c', bucket: 'b', key: 's.tar', entryPath: 'u.txt' }} />)
  const pre = await screen.findByText('hello')
  expect(pre.tagName).toBe('PRE')
  expect(pre.className).toContain('h-[280px]')
})
```

注意: 既存 PinnedPreviewCard.test の api モック方法（`vi.mock('../lib/api/client')` の形）を確認し、`textPreview` / `tarEntryText` がモック対象に含まれるようにする。`PinnedPreviewsProvider` でラップが必要ならラップする（既存テストに倣う）。

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run components/PinnedPreviewCard.test.tsx`
Expected: FAIL（現状 PreviewText / PinnedEntryText は max-h で h-[280px] を持たない）

- [ ] **Step 3: 実装**

`front/components/PinnedPreviewCard.tsx`:

(a) `PinnedEntryText` 関数（19-48 行目）を削除し、共通の `PinnedTextBody` に置換:

```tsx
// ピンカード内のテキスト/JSON 表示。単体ファイルは api.textPreview、tar エントリは
// api.tarEntryText を load に渡す。minify された 1 行 JSON でも潰れないよう固定高さ
// (音声カードのスペクトログラム相当) にして縦横スクロールで読ませる。
function PinnedTextBody({ load }: { load: () => Promise<string> }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    load()
      .then(t => { if (!cancelled) setText(t) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
    // load は呼び出しごとに新しい関数だが、item 由来で安定しているため deps は空でよい
    // (呼び出し側は key={item.id} でカードごと再マウントされる)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) return <p className="error">{error}</p>
  if (text === null) return <p className="text-[13px] text-ink-7">loading…</p>
  return (
    <pre
      className="m-0 h-[280px] overflow-auto whitespace-pre p-3 text-[12px] leading-snug"
      style={{
        fontFamily: 'var(--font-mono)',
        background: 'var(--ink-0)',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--radius-2)',
        color: 'var(--ink-11)',
      }}
    >
      {text}
    </pre>
  )
}
```

注意: `load` を deps 空で使う eslint 抑制がベースライン以外の新規 lint エラーを出す場合は、`load` を deps に入れる形（呼び出し側で useCallback するか、connId/bucket/key/entryPath を直接 props で受けて deps にする形）に変える。新規 lint エラーを出さない形が正 — 出るなら props 直接受け（`{ connId, bucket, k, entryPath? }` を受けて内部で分岐）に切り替えてよい。

(b) `PinnedPreviewBody`（67-88 行目付近）の text 分岐を差し替え:

```tsx
  if (entryPath != null) {
    const kind = classifyEntry(entryPath)
    if (kind === 'audio') {
      return <PreviewAudio connId={connId} bucket={bucket} k={key} entryPath={entryPath} />
    }
    if (kind === 'image') {
      return <PinnedEntryImage connId={connId} bucket={bucket} archiveKey={key} entry={entryPath} />
    }
    if (kind === 'text') {
      return <PinnedTextBody load={() => api.tarEntryText(connId, bucket, key, entryPath)} />
    }
    return unsupportedMessage
  }
  const kind = classify(key)
  if (kind === 'text')    return <PinnedTextBody load={() => api.textPreview(connId, bucket, key)} />
  if (kind === 'image')   return <PreviewImage connId={connId} bucket={bucket} k={key} />
  if (kind === 'audio')   return <PreviewAudio connId={connId} bucket={bucket} k={key} />
  if (kind === 'archive') return <PreviewArchive connId={connId} bucket={bucket} k={key} />
  return unsupportedMessage
```

(c) `PreviewText` の import（5 行目）がカード内で未使用になったら削除（他で使っていなければ）。`useState`/`useEffect` は PinnedTextBody で使うので残す。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run components/PinnedPreviewCard.test.tsx && npm test && npx tsc -b && npm run lint`
Expected: PASS（既存カードテスト維持、lint baseline 4）

- [ ] **Step 5: 実機確認（dev スタック）**

json ファイル（minify 1 行 / 複数行）をピン留めして、下部ドックのカードが 280px の固定高さ + スクロールで表示されることを目視。

- [ ] **Step 6: Commit**

```bash
git add front/components/PinnedPreviewCard.tsx front/components/PinnedPreviewCard.test.tsx
git commit -m "feat: ピンカードのテキスト/JSON を固定高さ + スクロール表示にする"
```
