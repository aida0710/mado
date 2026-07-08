# ピン留め式マルチプレビュー

> 改訂 (2026-07-08): 初版はドロワー内縦積みで実装したが、ユーザーフィードバックにより表示場所を**下部ドック（同期プレイヤーと同じ領域）のグリッド**に移設。tar をドロワーで開きながらエントリを積む際に閲覧面と収集面が分離され、広い横幅で json 同士の比較もできる。ドロワーのピンセクションは撤去。詳細は「ドック表示（改訂後）」節。

## 背景

プレビュードロワーは 1 件入れ替え式で、複数アイテム（json + json + 音声など）を同時に見られない。WebDataset の検分では「音声 + サイドカー json + 別ディレクトリの設定 json」を並べたい場面が頻出する。別ウィンドウ案はデッキ・blob 音声・解析キャッシュが 1 ページ内に住む現設計と衝突し、モバイルでも破綻するため不採用。デッキで確立した「行から積む」パターンをプレビュー全般に拡張する。

## 目的

- 任意のプレビュー可能アイテムを複数「ピン留め」して、ドロワー内に縦積みで同時表示できる
- ピンはディレクトリ移動を跨いで残る（リロードで消える。デッキと同じ寿命）
- 枚数無制限・全種別対応（text / json / 画像 / 音声 / tar アーカイブ / tar 内エントリ）
- スマホでは既存の全幅オーバーレイ + 縦スクロールでそのまま機能する

## 設計

### 状態管理: `front/lib/pinnedPreviews.tsx`

`playerDeck.tsx` と同型の Context。ルーティングの外（App、PlayerDeckProvider の隣）に Provider を置く。

```ts
export interface PinnedItem {
  id: string          // connId|bucket|key|entryPath?? '' (重複ピンは無視)
  connId: string
  bucket: string
  key: string         // tar 内エントリの場合は tar のキー
  entryPath?: string  // tar 内エントリのパス
}
usePinnedPreviews(): {
  pins: PinnedItem[]
  addPin(item: Omit<PinnedItem, 'id'>): void   // 追加順に末尾へ
  removePin(id: string): void
  clearPins(): void
}
```

- Provider 外では no-op API を返す（usePlayerDeck と同じフォールバック — 既存テストを壊さない）

### ドロワー: `front/components/PreviewDrawer.tsx` 拡張

- 構造: 上 = 現在のプレビュー（従来どおり行クリックで差し替え）、下 = ピン留めセクション（追加順の縦積み）
- **表示条件の変更**: `k != null || pins.length > 0` で表示（呼び出し元 StorageBucket 側の条件も追随）。ヘッダの ✕ は現在プレビューを閉じるだけでピンは残る。現在プレビューが無くピンだけのときは現在プレビュー部を出さない
- ヘッダに **📌 ボタン**（`k != null` のとき表示、クリックで現在の k をピン留め。既にピン済みなら無効表示）
- ピン留めセクションヘッダ: 「ピン留め (N)」+「全部外す」

### カード: `front/components/PinnedPreviewCard.tsx`

- ヘッダ: パス末尾（title=フルパス）+ DL リンク + ✕（removePin）
- 本体: 種別を classify で判定し既存コンポーネントを再利用
  - text → PreviewText / image → PreviewImage / audio → PreviewAudio（波形・情報行込み）/ archive → PreviewArchive / unknown → 既存の非対応メッセージ
  - tar 内エントリ（entryPath あり）: audio → PreviewAudio(entryPath) / text・json → tarEntryText 表示（TarEntryModal の本体表示と同等の軽量版）/ image → tarEntryUrl の img
- key={item.id} で状態リセットの一貫性を保つ（既存の key-remount パターン）

### 入口 3 箇所

1. **ドロワーヘッダ 📌**: 今開いているプレビューを留める
2. **一覧行の ⋯ メニュー**: 「ピン留め」action（Task 15 で追加した CopyMenu の action kind を再利用）。プレビュー可能種別のみ表示（unknown は出さない）
3. **TarEntryModal ヘッダ 📌**: 開いている tar エントリを留める

### ドック表示（改訂後）

- ピン留めセクションは **下部ドック** に移設。同期プレイヤーと同じ固定領域に 2 セクション（上: 同期プレイヤー、下: ピン留め）として同居し、単一の fixed コンテナで管理（fixed 要素の二重スタックはしない）
- カードは **レスポンシブグリッド**: 広画面 2〜3 列（`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`）、スマホ 1 列。ドック全体は最大高さ（例 60vh）付きで縦スクロール
- 各セクションは独立に折りたたみ可（プレイヤーの既存トグルと同型）。ピン 0 件ならピンセクション自体を出さない
- `<main>` の下部余白確保はデッキ既存の仕組みを「デッキ or ピンがあるとき」に拡張
- **PreviewDrawer は初版で足したピンセクション・ピンのみ表示条件・ピンのみ時ヘッダを撤去**し、`k != null` 表示に戻す。ヘッダの 📌（現在のプレビューをピン留め）は残す
- 入口 3 箇所（ドロワー 📌 / 行メニュー / TarEntryModal 📌）と Context・カードコンポーネントは変更なし

### デッキとの住み分け

- デッキ = 同期再生（聴き比べ）、ピン = 閲覧の集約。音声はどちらにも積める（独立）
- ドロワー幅リサイズ（useDrawerResize）は従来どおりドロワー全体に効く

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| 重複ピン | 無視（追加されない） |
| ピン済みアイテムの S3 側削除 | カード内の既存コンポーネントが各自のエラー表示を出す（fetch 404 等）。ピンは手動で外す |
| 接続削除後のピン | 同上（API 404 がカード内に出る）。v1 では自動掃除しない |
| ピンのみでドロワー表示中に行クリック | 現在プレビュー部が出現（従来動作） |

## テスト

- Context: 重複無視 / removePin / clearPins / Provider 外 no-op
- PinnedPreviewCard: 種別ごとの分岐（text/audio/tar エントリ text）、✕ で removePin
- PreviewDrawer: ピンのみでも表示 / ✕ でピンが残る / 📌 でピン追加・既ピン時無効
- 統合: ピン留め → MemoryRouter でディレクトリ遷移相当の再レンダ → ピンが残る
- 入口: 行メニューの「ピン留め」/ TarEntryModal の 📌

## ロールバック

- 全て front のみ・追加コンポーネント + 既存 3 ファイルの小変更。Provider とセクションを外せば従来動作
