---
title: メトリクスヘルプモーダル
date: 2026-05-01
status: draft
authors: aida
---

# メトリクスヘルプモーダル

メトリクスページに「?」ボタンを追加し、クリックで送り方の手引きをモーダル表示する。送る側 = 見る側が同じ研究室メンバーである前提のもと、「これってどう送るんだっけ？」と思った瞬間にダッシュボード内で 1 クリックで答えが出ることを狙う。

実装の核は新コンポーネント 1 つ + ページヘッダへのボタン追加で、バックエンド変更・新 API・新スキーマ・テストは無し。

## 目的と非目的

### 目的
- メトリクスを送る最低限の手順（`curl` サンプル）をダッシュボード内で即座に提示する。
- 既存の収集スクリプトドキュメント（`metrics/README.md`, `api/cron-samples/README.md`）への動線を作る。

### 非目的（明示的に作らない）
- `WRITE_TOKEN` の実値を画面に出す。本 spec では**プレースホルダ表示のみ**。
- Python の長いサンプル — 既存 `metrics/README.md` に任せる。
- 命名指針・収集を止める手順 — 既存 README に任せる。
- スクリーンショット。
- サーバー分離・IP 制限・トークン分割 — 別 spec で扱う。
- OSS 化に伴うアーキテクチャ刷新 — 別 spec で扱う。
- 多言語対応 (i18n)。

## UI と配置

`front/pages/MetricsPage.tsx` のページヘッダ（`refresh` ボタンの近く）に `?` ボタンを追加。クリックで `MetricsHelpModal` が開く。

閉じる手段は 3 通り（既存 `TarEntryModal` を踏襲）:

- ✕ ボタン
- 背景 (backdrop) クリック
- Escape キー

```
[Metrics] [refresh] [直近1時間のデータ] [最終更新 ...]   [ ? ]
                                                        └─ 新規
```

## モーダルの構造

1 ページの縦スクロール。3 セクション + フッター。スケジューラ（cron / `systemd.timer` / 自前デーモン等）の話は意図的に含めない — `/api/metrics/push` を 1 回叩く手段だけ示し、いつ・どう叩くかは利用者の自由とする。

### (a) 送り方

bash + `curl` のコピペサンプル 1 本:

```sh
uptime | curl -sS -X POST \
  -H "Authorization: Bearer <あなたの WRITE_TOKEN>" \
  -H "Content-Type: text/plain" \
  --data-binary @- \
  "<ORIGIN>/api/metrics/push?host=myhost&command=uptime&category=load"
```

- `<ORIGIN>` は `window.location.origin` を JS で文字列置換してそのまま表示する（コピペで実 URL になる）。
- `<あなたの WRITE_TOKEN>` は**プレースホルダ固定**。横に「`.env` の `WRITE_TOKEN` を、管理者から受け取って差し替えてください」という 1 行を添える。
- `<pre>` の右上に**コピーボタン**を置く。クリックで `navigator.clipboard.writeText()` によりサンプル全文をクリップボードへ。
- 末尾に「Python で動かしたい人は `metrics/` ディレクトリを参照」の 1 行を添える。

### (b) `category` ってなに

2 行:

> 自由文字列。同じ `category` のメトリクスがダッシュボード上で 1 つのセクションにまとめて表示される。例: `load`, `disk`, `ジョブ一覧`。

### (c) 古いデータは消えます

1 行:

> 直近 **1 時間**に push したものだけが画面に出る（DB には残る）。

### (d) フッター — もっと知りたい人へ

以下のドキュメントへの**パス**を表記する（クリックリンクではなく `<code>` の表示のみ）。理由: README ファイルはダッシュボードから配信していないので、利用者は clone 済みのリポか git forge 上で開く想定:

- `metrics/README.md` — Python 収集スクリプトの追加方法。
- `api/cron-samples/README.md` — bash 版 (`push.sh`) の使い方。

## 実装

### ファイル変更

- 新規: `front/components/MetricsHelpModal.tsx`(~120 行)。
- 編集: `front/pages/MetricsPage.tsx`
  - `useState<boolean>` で開閉状態を持つ: `const [helpOpen, setHelpOpen] = useState(false)`。
  - ヘッダに `<button className="ghost" onClick={() => setHelpOpen(true)} aria-label="ヘルプを開く">?</button>` を追加。
  - `{helpOpen && <MetricsHelpModal onClose={() => setHelpOpen(false)} />}` を配置。

### 依存

- 既存の Tailwind ユーティリティ・カスタムクラス: `modal`, `modal-backdrop`, `ghost`, `text-ink-7`, `font-mono` ほか。
- 新規 CSS なし。
- 新規 API endpoint なし。
- 新規スキーマなし。
- ブラウザ標準: `navigator.clipboard.writeText`。

### モーダル内部の構造

- `useEffect` で Escape キーを監視（`TarEntryModal.tsx:19-25` と同じ実装）。
- 背景クリックで閉じる: `<div className="modal-backdrop" onClick={onClose}>`、内側で `e.stopPropagation()`。
- 中身は静的 JSX。state は持たない（唯一の例外はコピーボタンの "copied!" 一時表示用 boolean）。
- アクセシビリティ: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` を `TarEntryModal` と同様に設定。

### コピーボタンの挙動

- クリック時:
  - `navigator.clipboard.writeText(snippet)` を実行。
  - 成功時は 2 秒間「copied」ラベルを表示してからボタン文字列を戻す。
  - 失敗時（古いブラウザ等）は `console.error` のみ。サンプル本文は `<pre>` で画面に出ているので手動選択でコピー可能であり、追加の UI は出さない。

## エラー処理

ない。
- 静的 UI のため fetch も I/O も無い。
- `navigator.clipboard.writeText` の失敗は前述のとおりサイレントに飲む。

## テスト

作らない。フロント静的 UI に対する既存方針（目視確認）に倣う。

## 残課題・将来の検討

- **`WRITE_TOKEN` の実値表示**: 本 spec ではプレースホルダで確定。将来トークンを役割別に分離（`INGEST_TOKEN` と `ADMIN_TOKEN` 等）した場合は、ingest 側のみ画面表示する余地が出る。これは別 spec マター。
- **サーバー分離・LAN 制限**（`10.15.0.0/16` 等の IP allowlist）: 本 spec のスコープ外。`/sql/write` の存在を考えると本来やるべきだが、L1 とは独立に進める。
- **OSS 化に伴う再設計**: 本 spec のスコープ外。本気で目指す場合は別の brainstorm 〜 spec の連鎖が必要。
