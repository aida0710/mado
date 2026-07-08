# デッキ削除 + 一覧からの直接再生（ドロワーをサブに）

## 背景

同期マルチトラックプレイヤー（デッキ）は「チャンネル別ファイルを頭出しを揃えて同時再生」する機能として作ったが、実運用では過剰で、むしろ「一覧を上から順に、その場でさっと聴く」ニーズの方が強い。そこでデッキを撤去し、tar／ディレクトリ一覧から音声を**直接インライン再生**できるようにする。あわせて、リッチなプレビュー（波形・スペクトログラム・詳細情報）のドロワーは主役から**サブ**へ降ろし、音声行のクリックは再生を主動作にする。

波形・スペクトログラム・詳細情報の機能自体は残す（ドロワー内に据え置き、⋯ メニューの「詳細プレビュー」から明示的に開く）。

## 目的

- 音声行のクリックでその場で再生／一時停止できる（ドロワーを開かない）
- 同時に鳴るのは 1 つだけ（別の音声を再生すると前が止まる）
- tar エントリ一覧の音声も同じく直接再生できる
- 同期プレイヤー（デッキ）を完全に撤去する。ピン留めは残す
- 波形・スペクトログラム・詳細情報は ⋯ メニューの「詳細プレビュー」から見られる

## 設計

### 1. デッキ（同期プレイヤー）の全削除

- 削除ファイル: `front/components/PlayerDeck.tsx` + `PlayerDeck.test.tsx`、`front/lib/playerDeck.tsx` + `playerDeck.test.tsx`、`front/lib/driftSync.ts` + `driftSync.test.ts`、`front/components/storage/EntryTable.deck.test.tsx`
- `front/components/BottomDock.tsx`: PlayerDeck セクションを外し**ピン留め専用**に縮小（`usePlayerDeck`/`tracks` 依存を除去。`if (pins.length === 0) return null`）。BottomDock.test も追随
- `front/App.tsx`: `PlayerDeckProvider` と `usePlayerDeck` を撤去。`MainContent` の下部余白は `pins.length > 0` だけで判定
- `front/components/storage/EntryTable.tsx` / `front/components/PreviewArchive.tsx`: ⋯ メニュー（および残っていればインライン）から「デッキに追加」を撤去
- 撤去後に未参照になる import・型を掃除（lint/tsc で担保）

### 2. インライン再生: `front/lib/inlineAudio.tsx`

デッキと同型の Context をルーティング外（App）に置く。単一の `<audio>` を保持し、同時に鳴るのは 1 つだけを構造的に保証する。

```ts
export interface InlineAudioApi {
  // 現在再生中 (再生 or 一時停止で保持中) のトラック id。停止/未再生は null
  currentId: string | null
  playing: boolean
  // 指定 src を再生。同 id を再度呼ぶと play/pause トグル。別 id は切替 (前は停止)
  toggle(id: string, src: string): void
  stop(): void
}
usePinnedPreviews と同様に Provider 外では no-op を返す
```

- 実装: Provider が単一の `HTMLAudioElement`（`new Audio()` を ref 保持）を持ち、`toggle(id, src)` で src 切替 + play/pause。`ended` で `playing=false`。src は既存のストリーミング URL（単体は `api.audioUrl`、tar エントリは `api.tarEntryUrl`）
- 進捗バー等の常設 UI は作らない（YAGNI）。「今どの行が鳴っているか」は各行の ▶/⏸ 表示 + 行ハイライトで示す

### 3. 一覧行の挙動

- **音声行（`classify === 'audio'`）**: 行クリック（および Enter/Space）= `toggle(id, src)`。行の左に ▶/⏸ アイコン（`currentId === id && playing` で ⏸、それ以外 ▶）。再生中の行は淡くハイライト（`bg-ink-1` 等）
- **テキスト/画像/tar アーカイブ行**: 従来どおり行クリックでドロワー（変更なし）
- **⋯ メニュー**（EntryTable の音声行 / PreviewArchive の音声エントリ）に「**詳細プレビュー**」を追加:
  - EntryTable 音声行: 「詳細プレビュー」→ 従来の `onSelectFile(key)`（ドロワーを波形付きで開く）/ 「ピン留め」/ 「ダウンロード」
  - PreviewArchive 音声エントリ: 「詳細プレビュー」→ `setOpenedEntry(e)`（TarEntryModal を開く）/ 「ピン留め」/ 「ダウンロード」
  - 非音声行の ⋯ は現状維持
- id の構成: 単体 = `connId|bucket|key`、tar エントリ = `connId|bucket|key|entryPath`（ピン id と同形式で衝突しない）

### 4. ドロワー / モーダル自体は不変

PreviewDrawer / TarEntryModal / PreviewAudio（波形・スペクトログラム・詳細情報）はそのまま。開く導線が「行クリック」から「⋯ の詳細プレビュー」に変わるだけ。ドロワー内 PreviewAudio の再生はインライン再生とは独立（別の `<audio>`。同時に鳴りうるが、詳細を開いて聴く場面なので許容）。

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| 再生中に別の音声行をクリック | 前が停止し新しい方が再生（単一 audio なので構造的に保証） |
| 再生中の行を再クリック | 一時停止（再クリックで再開） |
| 非音声ファイルの src で再生失敗 | audio の error は無視（音声行のみ ▶ を出すので実質発生しない） |
| ディレクトリ移動 | Context はルーティング外なので再生は継続。停止したい場合は ⏸ |
| ドロワーの PreviewAudio とインライン再生が同時 | 別 audio 要素。同時に鳴りうるが許容（YAGNI、必要なら将来一本化） |

## テスト

- **inlineAudio Context**: toggle で 1 つだけ再生 / 同 id 再呼びで pause↔play / 別 id で前が停止（jsdom は play/pause をスタブ）/ Provider 外 no-op
- **EntryTable**: 音声行クリックで `toggle` 呼び出し・▶/⏸ 表示切替・再生中ハイライト / 非音声行はクリックで `onSelectFile`（従来）/ ⋯ に「詳細プレビュー」があり選ぶと `onSelectFile` / 「デッキに追加」が消えている
- **PreviewArchive**: 音声エントリクリックで `toggle`・モーダルは開かない / ⋯ の「詳細プレビュー」で `setOpenedEntry`（モーダル）/ 「デッキに追加」消滅
- **BottomDock**: ピン 0 件で非表示 / ピンのみ表示（デッキ痕跡なし）
- **削除確認**: `grep` で playerDeck/driftSync/usePlayerDeck/デッキに追加 の残骸が無いこと

## ロールバック

- 全て front のみ。inlineAudio と行挙動を戻し、削除したデッキ群を復帰すれば元に戻る（が、デッキ削除は意図的なので通常は戻さない）
