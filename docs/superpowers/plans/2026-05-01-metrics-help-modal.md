# メトリクスヘルプモーダル Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メトリクスページに `?` ボタンを追加し、クリックで「送り方の手引き」モーダルを表示する。送る側 = 見る側が同じ研究室メンバーである前提のもとで、ダッシュボード内 1 クリックで答えにたどり着けるようにする。

**Architecture:** 新規 React コンポーネント `MetricsHelpModal` を追加し、`MetricsPage` に開閉用の `useState` と `?` ボタンを追加。バックエンド変更・新 API・新スキーマ・テストは無し（spec の方針）。

**Tech Stack:** React 19 + TypeScript、Tailwind 4 + 既存カスタム CSS（`modal`, `modal-backdrop`, `ghost`）、`navigator.clipboard`（ブラウザ標準）。

**Spec:** `docs/superpowers/specs/2026-05-01-metrics-help-modal-design.md`

---

## File Structure

| ファイル | 役割 | 変更種別 |
|---|---|---|
| `front/components/MetricsHelpModal.tsx` | 静的なヘルプモーダル本体。snippet 生成・コピー・Escape 監視を内包 | **新規** |
| `front/pages/MetricsPage.tsx` | 開閉 state と `?` ボタンを追加し、モーダルを呼び出す | **編集** |

これ以外のファイルは触らない。

---

## Task 1: MetricsHelpModal コンポーネントを新規作成

**Files:**
- Create: `front/components/MetricsHelpModal.tsx`

**参考にする既存コード:**
- `front/components/TarEntryModal.tsx` — modal-backdrop + Escape + click-outside の標準パターン

- [ ] **Step 1: ファイルを作成して以下のコードを書く**

```tsx
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

interface Props {
  onClose: () => void
}

export function MetricsHelpModal({ onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const snippet = buildSnippet(window.location.origin)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('clipboard write failed', err)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="metrics-help-title"
      >
        <header className="flex items-center gap-3 pb-3">
          <h3 id="metrics-help-title" className="m-0 flex-1">
            メトリクスの送り方
          </h3>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="ヘルプを閉じる"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-6">
          <Section title="送り方">
            <div className="relative">
              <pre className="m-0 max-h-72 overflow-auto whitespace-pre rounded-2 border border-ink-2 bg-ink-0 p-3 text-xs leading-snug">
                {snippet}
              </pre>
              <button
                type="button"
                className="ghost absolute right-2 top-2 text-xs"
                onClick={onCopy}
              >
                {copied ? 'copied' : 'copy'}
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-7">
              <code>{'<あなたの WRITE_TOKEN>'}</code> は <code>.env</code> の <code>WRITE_TOKEN</code> を、管理者から受け取って差し替えてください。
            </p>
            <p className="mt-1 text-xs text-ink-7">
              Python で動かしたい人は <code>metrics/</code> ディレクトリを参照。
            </p>
          </Section>

          <Section title={<><code>category</code> ってなに</>}>
            <p className="m-0 text-sm">
              自由文字列。同じ <code>category</code> のメトリクスがダッシュボード上で 1 つのセクションにまとめて表示される。例: <code>load</code>, <code>disk</code>, <code>ジョブ一覧</code>。
            </p>
          </Section>

          <Section title="古いデータは消えます">
            <p className="m-0 text-sm">
              直近 <strong>1 時間</strong>に push したものだけが画面に出る。cron が止まると勝手に画面から消える（DB には残る）。
            </p>
          </Section>

          <Section title="届かないとき">
            <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-sm">
              <li>
                <strong>cron 自体が動いてる？</strong> — <code>crontab -l</code> でエントリ確認。実行ログ（<code>/var/log/cron</code> や journal）で直近の起動を確認。
              </li>
              <li>
                <strong>環境変数がセットされてる？</strong> — <code>DASHBOARD_URL</code> と <code>WRITE_TOKEN</code> の両方。cron の実行環境はログインシェルとは別なので、<code>.bashrc</code> などからは引き継がれない。
              </li>
              <li>
                <strong>最後の push から 1 時間以内？</strong> — 経ってれば画面に出ない（仕様）。送信側で <code>date</code> をログに残しておくと判別しやすい。
              </li>
            </ol>
          </Section>

          <Section title="もっと知りたい人へ">
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
              <li><code>metrics/README.md</code> — Python 収集スクリプトの追加方法</li>
              <li><code>api/cron-samples/README.md</code> — bash 版 (<code>push.sh</code>) の使い方</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      {children}
    </section>
  )
}

function buildSnippet(origin: string): string {
  return [
    'uptime | curl -sS -X POST \\',
    '  -H "Authorization: Bearer <あなたの WRITE_TOKEN>" \\',
    '  -H "Content-Type: text/plain" \\',
    '  --data-binary @- \\',
    `  "${origin}/api/metrics/push?host=myhost&command=uptime&category=load"`,
  ].join('\n')
}
```

- [ ] **Step 2: lint を実行**

Run: `npm run lint`
Expected: 新規ファイルに警告なし、既存ファイルへの新規エラーなし。

- [ ] **Step 3: front の型チェック（ビルド）を走らせる**

Run: `npm --workspace front run build`
Expected: 成功（`tsc -b` と `vite build` の両方）。型エラーがあればここで出る。

- [ ] **Step 4: 一旦コミット**

```bash
git add front/components/MetricsHelpModal.tsx
git commit -m "feat(metrics): MetricsHelpModal コンポーネントを追加"
```

---

## Task 2: MetricsPage に `?` ボタンとモーダル呼び出しを追加

**Files:**
- Modify: `front/pages/MetricsPage.tsx`

**参考にする既存コード:**
- `front/pages/MetricsPage.tsx:1-89` — 既存のページ実装（ヘッダ構造、状態管理パターン）

- [ ] **Step 1: import を追加**

`front/pages/MetricsPage.tsx` 冒頭の import 群（既存 1-6 行目）の最後に追加:

```tsx
import { MetricsHelpModal } from '../components/MetricsHelpModal'
```

- [ ] **Step 2: 開閉用の useState を追加**

既存の `MetricsPage` 関数本体、`const [fetchedAt, setFetchedAt] = useState<Date | null>(null)`（18 行目付近）の直後に 1 行追加:

```tsx
const [helpOpen, setHelpOpen] = useState(false)
```

- [ ] **Step 3: ヘッダに `?` ボタンを追加**

既存の `<header className="page-head">` 内（`MetricsPage.tsx:59-68`）の構造を以下に変更する。`?` ボタンを末尾に追加し、`ml-auto` で右寄せ:

```tsx
<header className="page-head">
  <h2>Metrics</h2>
  <button className="ghost" onClick={refresh} disabled={loading}>
    {loading ? '...' : 'refresh'}
  </button>
  <span className="text-ink-7">直近 1 時間のデータ</span>
  {fetchedAt && (
    <span className="text-ink-7">最終更新 {formatTime(fetchedAt)}</span>
  )}
  <button
    type="button"
    className="ghost ml-auto"
    onClick={() => setHelpOpen(true)}
    aria-label="ヘルプを開く"
  >
    ?
  </button>
</header>
```

- [ ] **Step 4: `</section>` の直前にモーダルを条件付きレンダリング**

`MetricsPage.tsx` の最後の `</section>` の **直前**（86 行目付近）に追加:

```tsx
{helpOpen && <MetricsHelpModal onClose={() => setHelpOpen(false)} />}
```

最終的な `return (...)` の末尾はこうなる:

```tsx
      {grouped.map(([category, ms]) => (
        <section key={category} className="mt-6">
          {/* ... 既存のまま ... */}
        </section>
      ))}
      {helpOpen && <MetricsHelpModal onClose={() => setHelpOpen(false)} />}
    </section>
  )
}
```

- [ ] **Step 5: lint と型チェック**

Run: `npm run lint && npm --workspace front run build`
Expected: 警告・エラーなし。

- [ ] **Step 6: コミット**

```bash
git add front/pages/MetricsPage.tsx
git commit -m "feat(metrics): メトリクスページに ? ボタンとヘルプモーダルを配線"
```

---

## Task 3: ブラウザでの動作確認（手動）

テストは作らないので、目視でチェックする。実装方針のドキュメント（spec）の通りに動くことを確認する。

**Files:** なし（dev server 起動のみ）

- [ ] **Step 1: dev server を起動（既に起動中ならスキップ）**

Run: `npm run dev`
Expected: vite (front, 5173) と tsx watch (api, 3000) が並列で立ち上がる。コンソールに `server listening on http://localhost:3000` と vite 用の URL が出る。

- [ ] **Step 2: メトリクスページを開く**

ブラウザで `http://localhost:5173/` にアクセスし、メトリクスページに移動する。

- [ ] **Step 3: ヘッダ右端に `?` ボタンが見えることを確認**

`Metrics` 見出し・`refresh` ボタン・`直近 1 時間のデータ`・`最終更新 ...` の右側に `?` ボタンが表示されている（`ml-auto` で右寄せ）。

- [ ] **Step 4: `?` ボタンをクリックしてモーダルが開くことを確認**

クリックで暗い背景のオーバーレイが出て、中央にモーダルが現れる。タイトルは `メトリクスの送り方`、その下に 5 つのセクション（送り方 / category ってなに / 古いデータは消えます / 届かないとき / もっと知りたい人へ）が縦に並ぶ。

- [ ] **Step 5: snippet 内の URL が現在のオリジンになっていることを確認**

「送り方」セクションの `<pre>` 内、最終行の URL が `http://localhost:5173/api/metrics/push?host=myhost&command=uptime&category=load` のように **現在のオリジンを含む** こと。`<ORIGIN>` のような未置換文字列が残っていないこと。

- [ ] **Step 6: コピーボタンを押すとクリップボードに入ることを確認**

`copy` ボタンを押す → ボタンの文字が `copied` に変わる → 2 秒後に `copy` に戻る。
別のエディタやアドレスバーにペーストして、5 行のコマンド全文が入っていることを確認。

- [ ] **Step 7: 閉じる手段 3 つを確認**

- ✕ ボタンクリック → 閉じる
- 背景の暗いエリアをクリック → 閉じる
- モーダルを開き直して Escape キー → 閉じる

`?` ボタンを再度押せばまた開けることも確認。

- [ ] **Step 8: モーダルが開いている間も他のキーや UI に副作用がないことを確認**

Escape 以外のキー入力でモーダルが閉じないこと。`refresh` ボタンや背後のメトリクスカードがクリックできない（モーダル背景でブロックされる）こと。

- [ ] **Step 9: 確認 OK ならまだコミット不要（コードは前タスクで commit 済み）**

実装変更は無いのでコミットなし。手動確認で問題があれば前タスクに戻って修正してから再度確認する。

---

## Self-Review チェックリスト（プラン書いた人が最後に通す用）

このプランの作成者として、書いたあとセルフレビューする項目（**実装する人は気にしなくて OK**）:

- spec のセクション (a)〜(e) すべてが Task 1 のコードに含まれているか → ✓ 確認済み
- snippet の `<ORIGIN>` 動的置換 → ✓ `buildSnippet(window.location.origin)` で実現
- snippet の `<あなたの WRITE_TOKEN>` プレースホルダ表示 → ✓ ハードコード
- コピーボタン → ✓ 実装あり、失敗時 `console.error` のみ
- Escape / 背景クリック / ✕ で閉じる → ✓ 実装あり
- ARIA 属性 → ✓ `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- 新 API・新 schema・テストなし → ✓ プランにそれらを作るタスクがない
- フッターはクリックリンクではなく `<code>` 表示 → ✓ `<code>` のみ
