# デッキ波形クリックシーク + ピンカードのテキスト固定高さ化

## 背景

2 つの小さな UX 改善:

1. デッキ（下部ドック）のトラック波形はクリックしてもシークできない（シークは下のマスターバーのみ）。0 パディングで波形が共通時間軸のエディタ風になったため、波形クリックでシークしたい。
2. ピン留めカードで JSON / テキストを見ると 1 行で潰れて見にくい。原因は `<pre>` が `whitespace-pre` + `max-h`（最大高さ）で、minify された 1 行 JSON だと高さが 1 行分に縮むため。数万行の JSON もあるので、音声カード相当の**固定高さ + スクロール**で見たい。

## 目的

- デッキの各トラック波形をクリックすると、全トラックがその時刻へシークする（共通時間軸なのでどのトラックでも同じ）
- ピンカードの text/JSON を固定高さのボックスで表示し、内容によらず一定サイズ + スクロール（縦横）で読める

## 設計

### 1. デッキ波形のクリックシーク（`front/components/PlayerDeck.tsx`）

- 各トラック行の `<Waveform>` に `onSeek` を渡す:
  ```tsx
  onSeek={ratio => seekAll(ratio * maxDuration)}
  ```
- `Waveform` の click ratio は全幅比（0〜1）、タイムラインは maxDuration なので `ratio * maxDuration` が目的時刻。既存の `seekAll` は各トラックを長さでクランプ（短いトラックは終端=無音）するので、短いトラックの空白部（終端超え）をクリックしても 0 パディングと整合する。
- `maxDuration === 0`（durations 未取得）のときは `ratio * 0 = 0` になるが、その状況では再生前で実害なし。念のため `maxDuration > 0` のときだけ onSeek を渡す形でもよい（実装時判断、テストが通る形が正）。
- ドロワー / 単体プレビュー（PreviewAudio）の波形クリックシークは既に動作しており変更しない。

### 2. ピンカードのテキスト固定高さ（`front/components/PinnedPreviewCard.tsx`）

- ピンカード専用の共通テキスト表示 `PinnedTextBody` を作る:
  ```tsx
  function PinnedTextBody({ load }: { load: () => Promise<string> }): JSX.Element
  ```
  - `useEffect` で `load()` を呼び（AbortController 不要 — cancelled フラグの既存流儀）、`text`/`error`/loading を管理
  - `<pre>` を **固定高さ**（`h-[280px]`、音声カードのスペクトログラム相当）にし `overflow-auto`（縦横スクロール）、`whitespace-pre` 維持。スタイルは既存 `PinnedEntryText` の pre と同じトークン（mono / var(--ink-0) 背景 / var(--rule) ボーダー / var(--radius-2) / var(--ink-11)）だが `max-h-[40vh]` を `h-[280px]` に変更
- `PinnedPreviewCard` の分岐を修正:
  - 単体ファイル text（`classify(key) === 'text'`）: `<PreviewText>` をやめ `<PinnedTextBody load={() => api.textPreview(connId, bucket, key)} />`
  - tar エントリ text（`classifyEntry(entryPath) === 'text'`）: 既存 `PinnedEntryText` を廃し `<PinnedTextBody load={() => api.tarEntryText(connId, bucket, key, entryPath)} />`
  - 既存の `PinnedEntryText` 関数は削除（`PinnedTextBody` に統合）。`PreviewText` の import はカードから不要になれば外す（ドロワーでは引き続き使用）
- **ドロワーの `PreviewText` 自体は変更しない**（プレビューは max-h-70vh の全高で見たいので現状維持）。画像 / 音声 / archive のピンカード分岐も変更なし。

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| minify された 1 行 JSON をピン | 280px の固定ボックスに横スクロールで表示（1 行ペタンコにならない） |
| 数万行 JSON をピン | 280px の固定ボックスを縦スクロール |
| fetch 失敗 | 既存流儀のエラー表示（`<p className="error">`） |
| 空テキスト | 空の固定ボックス（高さは維持） |
| デッキ波形の空白部クリック（短いトラック） | seekAll → そのトラックは終端で無音、長いトラックは再生（0 パディング整合） |

## テスト

- **PlayerDeck**: トラック波形（`role="slider"` の canvas）に onSeek が渡り、クリックで seekAll が呼ばれる（既存の seekAll / audio currentTime 検証基盤を流用。1 トラックの波形を fireEvent.click し、currentTime が ratio×maxDuration になる、または seekAll 経由でマスター時刻が動くのを確認）
- **PinnedTextBody / PinnedPreviewCard**: 単体ファイル text と tar エントリ text の両方で、`load` の解決後に固定高さ（`h-[280px]` クラス）を持つ `<pre>` にテキストが表示される（fetch/tarEntryText をモック）/ fetch 失敗でエラー表示 / 既存のピンカードテスト（種別分岐・✕・DL）が維持される

## ロールバック

- 全て front。onSeek を外し、PinnedTextBody を元の PreviewText / PinnedEntryText に戻せば復帰。
