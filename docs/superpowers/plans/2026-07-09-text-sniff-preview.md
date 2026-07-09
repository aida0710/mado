# 拡張子に頼らないテキストプレビュー 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** テキストの拡張子リストを削除し、先頭 64 KB に NUL バイトが無いファイルをすべてテキストとしてプレビューできるようにする。

**Architecture:** `classify()` から `'text'` を削除し、`image` / `audio` / `archive` 以外はすべて `unknown` にする。`unknown` の描画時に先頭 64 KB を取得し、NUL バイトを含めば「プレビュー非対応」、含まなければ不可逆 UTF-8 デコードして表示する。サーバー側 API は変更しない。

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind、テストは vitest + @testing-library/react（jsdom）。

## Global Constraints

- 設計は `docs/superpowers/specs/2026-07-09-text-sniff-preview-design.md` に準拠する。
- 判定は **NUL バイトの有無だけ**。`TextDecoder` の `fatal: true` は使わない（Shift_JIS の `.txt` が「非対応」に変わる退行を防ぐため）。
- **サーバー側（`api/`）は 1 行も変更しない。**
- `image` / `audio` / `archive` の拡張子リストは残す。**消すのは text のリストだけ。**
- 新しい拡張子を 1 つも足さない。
- コメントは既存の流儀に合わせ、日本語で「なぜ」を書く。「何を」は書かない。
- 各タスクの最後は必ず `cd front && npx vitest run` が全パスする状態にする。
- コミットメッセージ末尾に必ず以下を付ける:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- ブランチは `feature/text-sniff-preview`（設計ドキュメントのコミット `cdba6fa` が既にある）。

---

### Task 1: NUL バイト判定（純関数）

**Files:**
- Create: `front/lib/textSniff.ts`
- Test: `front/lib/textSniff.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `export const TEXT_HEAD_BYTES = 65536`
  - `export function looksBinary(head: Uint8Array): boolean`

- [ ] **Step 1: Write the failing test**

`front/lib/textSniff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { looksBinary, TEXT_HEAD_BYTES } from './textSniff'

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('looksBinary', () => {
  it('空バイト列はテキスト扱い', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false)
  })

  it('ASCII / 日本語 UTF-8 はテキスト', () => {
    expect(looksBinary(utf8('hello\nworld\t!'))).toBe(false)
    expect(looksBinary(utf8('こんにちは 世界'))).toBe(false)
  })

  it('npy のヘッダは NUL を含むのでバイナリ', () => {
    // \x93NUMPY + version major=1 minor=0 → 末尾に NUL が必ず来る
    expect(looksBinary(bytes(0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00))).toBe(true)
  })

  it('WAV のヘッダも NUL を含むのでバイナリ', () => {
    // "RIFF" + size + "WAVE" — size フィールドに NUL が入る
    expect(looksBinary(bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00))).toBe(true)
  })

  it('Shift_JIS のバイト列は NUL を含まないのでテキスト扱い (文字化けしても表示する)', () => {
    // 「あい」= 0x82 0xA0 0x82 0xA2。UTF-8 としては不正だが fatal 判定はしない。
    expect(looksBinary(bytes(0x82, 0xa0, 0x82, 0xa2))).toBe(false)
  })

  it('末尾に NUL が 1 つあるだけでバイナリ', () => {
    expect(looksBinary(bytes(0x68, 0x69, 0x00))).toBe(true)
  })
})

describe('TEXT_HEAD_BYTES', () => {
  it('サーバーの PREVIEW_TEXT_LIMIT と同値', () => {
    expect(TEXT_HEAD_BYTES).toBe(65536)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd front && npx vitest run lib/textSniff.test.ts`
Expected: FAIL — `Failed to resolve import "./textSniff"`

- [ ] **Step 3: Write minimal implementation**

`front/lib/textSniff.ts`:

```ts
// プレビューの中身がテキストかバイナリかを、拡張子ではなく先頭バイトで判定する。
//
// 判定は NUL バイトの有無だけ。UTF-8 として妥当かまでは見ない — 見てしまうと、
// いま文字化けしつつも表示できている Shift_JIS の .txt が「非対応」に変わり
// 退行する。逆に 64 KB の中に NUL が 1 つも無いバイナリは実質存在しないので、
// この 1 点で npy / wav / 画像 / 圧縮形式はすべて弾ける。

// サーバーが返すテキストプレビューの上限と同値 (api/env.ts の PREVIEW_TEXT_LIMIT)。
// 片方を変えたら他方も変えること。
export const TEXT_HEAD_BYTES = 65536

export function looksBinary(head: Uint8Array): boolean {
  return head.includes(0)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd front && npx vitest run lib/textSniff.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add front/lib/textSniff.ts front/lib/textSniff.test.ts
git commit -m "$(cat <<'EOF'
feat: 先頭バイトからテキスト/バイナリを判定する textSniff を追加

拡張子リストを引くのをやめ、中身で判定するための純関数。NUL バイトの有無
だけを見る。UTF-8 妥当性まで見ると、いま文字化けしつつも表示できている
Shift_JIS の .txt が「非対応」に変わって退行するため。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 先頭だけ読む fetch（`api.readHead`）

**Files:**
- Modify: `front/lib/api/client.ts`（`textPreviewUrl` の定義付近、`front/lib/api/client.ts:345`）
- Test: `front/lib/api/read-head.test.ts`（新規。`media-client.test.ts` と同じ「api の 1 機能に 1 ファイル」の流儀）

**Interfaces:**
- Consumes: なし
- Produces: `api.readHead(url: string, maxBytes: number): Promise<Uint8Array>`

`/preview/tar-entry` は Range 非対応で常に全量（最大 100 MB）返すため、レスポンスのストリームを `maxBytes` で打ち切り `reader.cancel()` する。100 MB の npy を落としてから弾く事故を防ぐ。

- [ ] **Step 1: Write the failing test**

`front/lib/api/read-head.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

afterEach(() => vi.restoreAllMocks())

// 指定チャンクを順に流す ReadableStream もどき。cancel の呼び出しを記録する。
function streamOf(chunks: number[][]) {
  let i = 0
  const cancel = vi.fn(async () => {})
  return {
    cancel,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: new Uint8Array(chunks[i++]) }
            : { done: true, value: undefined },
        cancel,
      }),
    },
  }
}

function res(chunks: number[][], init: { ok?: boolean; statusText?: string } = {}) {
  const s = streamOf(chunks)
  return {
    fake: {
      ok: init.ok ?? true,
      statusText: init.statusText ?? 'OK',
      body: s.body,
      json: async () => ({}),
    } as unknown as Response,
    cancel: s.cancel,
  }
}

describe('api.readHead', () => {
  it('maxBytes で打ち切り、残りのストリームを cancel する', async () => {
    const { fake, cancel } = res([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    const head = await api.readHead('/x', 4)

    expect([...head]).toEqual([1, 2, 3, 4])
    expect(cancel).toHaveBeenCalled()
  })

  it('maxBytes 未満のレスポンスは done まで読む', async () => {
    const { fake } = res([[1, 2], [3]])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    const head = await api.readHead('/x', 1024)

    expect([...head]).toEqual([1, 2, 3])
  })

  it('空レスポンスは空の Uint8Array', async () => {
    const { fake } = res([])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    expect((await api.readHead('/x', 1024)).length).toBe(0)
  })

  it('4xx / 5xx は statusText で throw する', async () => {
    const { fake } = res([], { ok: false, statusText: 'Not Found' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    await expect(api.readHead('/x', 1024)).rejects.toThrow('Not Found')
  })

  it('エラー body に error があればそれを使う', async () => {
    const fake = {
      ok: false,
      statusText: 'Payload Too Large',
      json: async () => ({ error: 'entry exceeds preview limit' }),
    } as unknown as Response
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    await expect(api.readHead('/x', 1024)).rejects.toThrow('entry exceeds preview limit')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd front && npx vitest run lib/api/read-head.test.ts`
Expected: FAIL — `api.readHead is not a function`

- [ ] **Step 3: Write minimal implementation**

`front/lib/api/client.ts` の `textPreviewUrl` の直前に追加する:

```ts
  // URL の先頭 maxBytes だけ読み、残りは reader.cancel() で捨てる。
  //
  // /preview/tar-entry は Range 非対応で常に全量 (最大 100MB) を返す。テキストか
  // どうかを見るだけのために 100MB の npy を落としきるのは無駄なので、ストリームを
  // 途中で打ち切る。size を知らなくても安全なので、呼び出し側にサイズ上限の分岐が要らない。
  readHead: async (url: string, maxBytes: number): Promise<Uint8Array> => {
    const res = await fetch(url)
    if (!res.ok) {
      let msg = res.statusText
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) msg = body.error
      } catch { /* statusText をそのまま使う */ }
      throw new Error(msg)
    }
    if (!res.body) return new Uint8Array(await res.arrayBuffer())

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.length
      }
    } finally {
      // 既に done でも cancel は解決する。打ち切り時はここで残りの転送が止まる。
      await reader.cancel().catch(() => { /* 二重 cancel は無視 */ })
    }

    const out = new Uint8Array(Math.min(total, maxBytes))
    let offset = 0
    for (const c of chunks) {
      if (offset >= out.length) break
      const take = Math.min(c.length, out.length - offset)
      out.set(c.subarray(0, take), offset)
      offset += take
    }
    return out
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd front && npx vitest run lib/api/read-head.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add front/lib/api/client.ts front/lib/api/read-head.test.ts
git commit -m "$(cat <<'EOF'
feat: レスポンスの先頭だけ読む api.readHead を追加

/preview/tar-entry は Range 非対応で常に全量 (最大 100MB) 返すため、テキスト
判定のためだけに全部落とすのを避ける。ストリームを maxBytes で打ち切って
reader.cancel() する。size を知らなくても安全なので、呼び出し側にサイズ上限の
分岐が要らない。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 取得と判定をまとめるフック

**Files:**
- Create: `front/lib/useSniffedText.ts`
- Test: `front/lib/useSniffedText.test.ts`

**Interfaces:**
- Consumes: `api.readHead`（Task 2）、`looksBinary` / `TEXT_HEAD_BYTES`（Task 1）
- Produces:
  ```ts
  export type SniffedText =
    | { status: 'loading' }
    | { status: 'text'; text: string }
    | { status: 'binary' }
    | { status: 'error'; message: string }
  export function useSniffedText(url: string): SniffedText
  ```

表示は 3 箇所で異なる（ドロワーは `max-h-[70vh]`、ピンカードは固定高さ `h-[280px]`、モーダルは行数表示付き）ので、共有するのは**取得と判定だけ**にする。

- [ ] **Step 1: Write the failing test**

`front/lib/useSniffedText.test.ts`:

```ts
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSniffedText } from './useSniffedText'

vi.mock('./api/client', () => ({
  api: { readHead: vi.fn() },
}))

import { api } from './api/client'

afterEach(() => vi.clearAllMocks())

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('useSniffedText', () => {
  it('最初は loading', () => {
    vi.mocked(api.readHead).mockReturnValue(new Promise<Uint8Array>(() => {}))
    const { result } = renderHook(() => useSniffedText('/x'))
    expect(result.current.status).toBe('loading')
  })

  it('NUL を含まなければ text (不可逆 UTF-8 デコード)', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('こんにちは\n世界'))
    const { result } = renderHook(() => useSniffedText('/x'))
    await waitFor(() => expect(result.current.status).toBe('text'))
    expect(result.current).toEqual({ status: 'text', text: 'こんにちは\n世界' })
  })

  it('NUL を含めば binary', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
    const { result } = renderHook(() => useSniffedText('/x'))
    await waitFor(() => expect(result.current.status).toBe('binary'))
  })

  it('取得に失敗したら error', async () => {
    vi.mocked(api.readHead).mockRejectedValue(new Error('Not Found'))
    const { result } = renderHook(() => useSniffedText('/x'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current).toEqual({ status: 'error', message: 'Not Found' })
  })

  it('先頭 TEXT_HEAD_BYTES だけ要求する', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('hi'))
    renderHook(() => useSniffedText('/some/url'))
    await waitFor(() => expect(api.readHead).toHaveBeenCalledWith('/some/url', 65536))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd front && npx vitest run lib/useSniffedText.test.ts`
Expected: FAIL — `Failed to resolve import "./useSniffedText"`

- [ ] **Step 3: Write minimal implementation**

`front/lib/useSniffedText.ts`:

```ts
import { useEffect, useState } from 'react'
import { api } from './api/client'
import { looksBinary, TEXT_HEAD_BYTES } from './textSniff'

export type SniffedText =
  | { status: 'loading' }
  | { status: 'text'; text: string }
  | { status: 'binary' }
  | { status: 'error'; message: string }

// プレビュー対象の先頭を取得し、テキストかバイナリかを決める。url は
// api.textPreviewUrl() か api.tarEntryUrl() の戻り値。
//
// url 変化時の loading への差し戻しはしない — 呼び出し側は key で再マウントする
// 流儀 (PreviewDrawer / TarEntryModal / PinnedPreviewCard)。effect 内で同期 setState
// すると react-hooks/set-state-in-effect に引っかかるので、そこは避ける。
export function useSniffedText(url: string): SniffedText {
  const [state, setState] = useState<SniffedText>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.readHead(url, TEXT_HEAD_BYTES)
      .then(head => {
        if (cancelled) return
        // fatal なしの不可逆デコード。64KB 境界で割れたマルチバイト文字は
        // U+FFFD 1 個で済み、非 UTF-8 のテキストも従来どおり文字化けして表示される。
        setState(looksBinary(head)
          ? { status: 'binary' }
          : { status: 'text', text: new TextDecoder().decode(head) })
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ status: 'error', message: e.message })
      })
    return () => { cancelled = true }
  }, [url])

  return state
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd front && npx vitest run lib/useSniffedText.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add front/lib/useSniffedText.ts front/lib/useSniffedText.test.ts
git commit -m "$(cat <<'EOF'
feat: 先頭バイトを取得してテキスト/バイナリを決める useSniffedText を追加

表示はドロワー/ピンカード/モーダルで高さも装飾も違うので、共有するのは取得と
判定だけにする。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ドロワーの `PreviewText` をスニッフに載せ替える

**Files:**
- Create: `front/components/UnsupportedPreview.tsx`
- Modify: `front/components/PreviewText.tsx`（全面書き換え）
- Modify: `front/components/PreviewDrawer.tsx:98-118`（`text` / `unknown` の 2 分岐を 1 本に）
- Test: `front/components/PreviewText.test.tsx`（mock 差し替え + binary ケース追加）
- Test: `front/components/PreviewDrawer.test.tsx`（`file.xyz` が fetch するようになる）

**Interfaces:**
- Consumes: `useSniffedText`（Task 3）、`api.textPreviewUrl`（既存、`front/lib/api/client.ts:345`。今まで未使用だった）
- Produces: `export function UnsupportedPreview(): JSX.Element`

この時点では `mime.ts` はまだ変更しない。`kind === 'text' || kind === 'unknown'` の両方を `PreviewText` に流す。

- [ ] **Step 1: Write the failing test**

`front/components/PreviewText.test.tsx` を全面差し替え:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewText } from './PreviewText'

vi.mock('../lib/api/client', () => ({
  api: {
    textPreviewUrl: vi.fn(() => 'http://x/text'),
    readHead: vi.fn(async () => new Uint8Array(0)),
  },
}))
vi.mock('../lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

import { api } from '../lib/api/client'
import { copyToClipboard } from '../lib/clipboard'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

afterEach(() => {
  vi.clearAllMocks()
})

describe('PreviewText - copy', () => {
  it('copies the loaded text content', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('hello\nworld'))
    render(<PreviewText connId="c" bucket="b" k="x.txt" />)
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('hello\nworld')
  })

  it('shows no copy button while loading', () => {
    vi.mocked(api.readHead).mockReturnValue(new Promise<Uint8Array>(() => {}))
    render(<PreviewText connId="c" bucket="b" k="x.txt" />)
    expect(screen.queryByRole('button', { name: '内容をコピー' })).toBeNull()
    expect(screen.getByText('loading…')).toBeInTheDocument()
  })
})

describe('PreviewText - スニッフ', () => {
  it('拡張子が unknown でも中身がテキストなら開ける', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('#!/bin/sh\necho hi'))
    render(<PreviewText connId="c" bucket="b" k="run.sh" />)
    expect(await screen.findByText(/echo hi/)).toBeInTheDocument()
  })

  it('NUL を含むファイルは「プレビュー非対応」', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
    render(<PreviewText connId="c" bucket="b" k="a.npy" />)
    expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '内容をコピー' })).toBeNull()
  })

  it('取得に失敗したらエラーを出す', async () => {
    vi.mocked(api.readHead).mockRejectedValue(new Error('Not Found'))
    render(<PreviewText connId="c" bucket="b" k="x.txt" />)
    expect(await screen.findByText('Not Found')).toBeInTheDocument()
  })
})
```

`front/components/PreviewDrawer.test.tsx` の `vi.mock('../lib/api/client', ...)` を差し替える（`file.xyz` が `PreviewText` に流れるため）:

```tsx
vi.mock('../lib/api/client', () => ({
  api: {
    downloadUrl: vi.fn(() => 'http://x/dl'),
    textPreviewUrl: vi.fn(() => 'http://x/text'),
    // unknown 拡張子もスニッフ経由でテキスト判定される。NUL を返してバイナリ扱いにし、
    // 「プレビュー非対応」表示のままにする (このテストの関心はピン留めボタンの有無)。
    readHead: vi.fn(async () => new Uint8Array([0x00])),
    tarPreview: vi.fn(() => new Promise(() => {})),
    invalidateTarPreview: vi.fn(),
    lastFetched: { tar: vi.fn(() => null) },
  },
}))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd front && npx vitest run components/PreviewText.test.tsx`
Expected: FAIL — `api.textPreview is not a function`（`PreviewText` がまだ旧実装）

- [ ] **Step 3: Write minimal implementation**

`front/components/UnsupportedPreview.tsx`（新規）:

```tsx
// プレビューできないファイルの案内。ドロワー / ピンカード / tar エントリモーダルの
// 3 箇所で同じ文言を出すため共有する。
export function UnsupportedPreview() {
  return (
    <p className="text-[13px] text-ink-7">
      プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。
    </p>
  )
}
```

`front/components/PreviewText.tsx`（全面書き換え）:

```tsx
import { useState } from 'react'
import { api } from '../lib/api/client'
import { copyToClipboard } from '../lib/clipboard'
import { useSniffedText } from '../lib/useSniffedText'
import { UnsupportedPreview } from './UnsupportedPreview'

export function PreviewText({ connId, bucket, k }: { connId: string; bucket: string; k: string }) {
  const sniffed = useSniffedText(api.textPreviewUrl(connId, bucket, k))
  const [copyMsg, setCopyMsg] = useState<string | null>(null)

  if (sniffed.status === 'error') return <p className="error">{sniffed.message}</p>
  if (sniffed.status === 'loading') return <p className="text-[13px] text-ink-7">loading…</p>
  if (sniffed.status === 'binary') return <UnsupportedPreview />

  const text = sniffed.text
  const handleCopy = async () => {
    const ok = await copyToClipboard(text)
    setCopyMsg(ok ? 'コピーしました ✓' : 'コピー失敗')
    setTimeout(() => setCopyMsg(null), 1500)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
        <button
          type="button"
          className="ghost text-[11px]"
          onClick={handleCopy}
          title="内容をコピー"
          aria-label="内容をコピー"
        >
          {copyMsg ?? '内容をコピー'}
        </button>
      </div>
      <pre
        className="m-0 max-h-[70vh] overflow-auto whitespace-pre p-3 text-[12px] leading-snug"
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
    </div>
  )
}
```

`front/components/PreviewDrawer.tsx` の本文分岐を差し替える。旧:

```tsx
        {kind === 'text' && (
          <PreviewText key={`${connId}|${bucket}|${k}`} connId={connId} bucket={bucket} k={k} />
        )}
        {kind === 'image' && <PreviewImage connId={connId} bucket={bucket} k={k} />}
```

新（`unknown` の分岐ごと `PreviewText` に寄せる。末尾の `kind === 'unknown'` ブロックは削除する）:

```tsx
        {/* 画像 / 音声 / アーカイブ以外はすべてテキストとして開こうとする。
            中身がバイナリなら PreviewText 側が「プレビュー非対応」を出す。 */}
        {(kind === 'text' || kind === 'unknown') && (
          <PreviewText key={`${connId}|${bucket}|${k}`} connId={connId} bucket={bucket} k={k} />
        )}
        {kind === 'image' && <PreviewImage connId={connId} bucket={bucket} k={k} />}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd front && npx vitest run components/PreviewText.test.tsx components/PreviewDrawer.test.tsx`
Expected: PASS（PreviewText 5 tests、PreviewDrawer 既存 8 tests）

Run: `cd front && npx vitest run && npx tsc -b --noEmit`
Expected: 全パス、tsc OK

- [ ] **Step 5: Commit**

```bash
git add front/components/UnsupportedPreview.tsx front/components/PreviewText.tsx \
        front/components/PreviewText.test.tsx front/components/PreviewDrawer.tsx \
        front/components/PreviewDrawer.test.tsx
git commit -m "$(cat <<'EOF'
feat: ドロワーのプレビューを中身のスニッフに載せ替える

拡張子が unknown でも中身がテキストなら開くようにし、バイナリなら従来どおり
「プレビュー非対応」を出す。3 箇所に重複していた非対応の文言は
UnsupportedPreview に集約していく。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: ピンカードをスニッフに載せ替える

**Files:**
- Modify: `front/lib/format.ts`（`prettyPrintJson` を追加）
- Test: `front/lib/format.test.ts`（**新規**）
- Modify: `front/components/PinnedPreviewCard.tsx`（`PinnedTextBody` と `PinnedPreviewBody` の分岐、`unsupportedMessage` 削除）
- Test: `front/components/PinnedPreviewCard.test.tsx`
- Test: `front/components/BottomDock.test.tsx`（`x.bin` のカードが fetch するようになる）

**Interfaces:**
- Consumes: `useSniffedText`（Task 3）、`UnsupportedPreview`（Task 4）、`api.textPreviewUrl` / `api.tarEntryUrl`（既存）
- Produces: `export function prettyPrintJson(name: string, text: string): string`（Task 6 の `TarEntryModal.TextBody` も使う）

`.json` のプリティプリントは**表示上の整形**として残す。描画先の分岐ではないので拡張子リストの復活には当たらない。

整形ロジックは現在 `PinnedPreviewCard.tsx:39-47` と `TarEntryModal.tsx:146-156` に逐語的に重複している。両方を書き換えるこのタイミングで `front/lib/format.ts` に抽出し、Task 5 と Task 6 の両方から呼ぶ。

**追加ステップ（Step 0）: `prettyPrintJson` を先に切り出す**

`front/lib/format.test.ts`（新規）:

```ts
import { describe, expect, it } from 'vitest'
import { prettyPrintJson } from './format'

describe('prettyPrintJson', () => {
  it('.json は minify されていても整形する', () => {
    expect(prettyPrintJson('a.json', '{"a":1,"b":2}')).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })

  it('.jsonl / .ndjson は 1 行 1 JSON 値なので整形しない', () => {
    expect(prettyPrintJson('a.jsonl', '{"a":1}\n{"b":2}')).toBe('{"a":1}\n{"b":2}')
    expect(prettyPrintJson('a.ndjson', '{"a":1}\n{"b":2}')).toBe('{"a":1}\n{"b":2}')
  })

  it('不正な JSON はそのまま返す', () => {
    expect(prettyPrintJson('bad.json', '{oops not json')).toBe('{oops not json')
  })

  it('json 以外の拡張子はそのまま返す', () => {
    expect(prettyPrintJson('a.txt', '{"a":1}')).toBe('{"a":1}')
    expect(prettyPrintJson('README', 'hello')).toBe('hello')
  })

  it('拡張子の大小文字を問わない', () => {
    expect(prettyPrintJson('A.JSON', '{"a":1}')).toBe('{\n  "a": 1\n}')
  })
})
```

`front/lib/format.ts` に追加:

```ts
// .json (単一ドキュメント) だけプリティプリントする。.jsonl / .ndjson は
// 1 行 1 JSON 値の形式なのでそのまま返す。整形できない (不正な JSON) ときも
// そのまま返し、プレビューが空にならないようにする。
//
// これは表示上の整形であって、プレビューの描画先を決める分岐ではない
// (種別は中身のスニッフで決める。front/lib/textSniff.ts を参照)。
export function prettyPrintJson(name: string, text: string): string {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.json') || lower.endsWith('.jsonl')) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
```

Run: `cd front && npx vitest run lib/format.test.ts` → PASS（5 tests）

このステップだけを先にコミットしてよい:

```bash
git add front/lib/format.ts front/lib/format.test.ts
git commit -m "$(cat <<'EOF'
refactor: JSON プリティプリントを prettyPrintJson に抽出する

PinnedPreviewCard と TarEntryModal に逐語的に重複していた整形ロジックを
format.ts へ寄せる。表示上の整形であって描画先の分岐ではない。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 1: Write the failing test**

`front/components/PinnedPreviewCard.test.tsx` の api mock を差し替え、非対応テストを非同期にし、スニッフのケースを足す。

mock ブロックを次に置き換える:

```tsx
vi.mock('../lib/api/client', () => ({
  api: {
    downloadUrl: vi.fn(() => 'http://x/dl'),
    textPreviewUrl: vi.fn(() => 'http://x/text'),
    tarEntryUrl: vi.fn(() => 'http://x/entry'),
    imageUrl: vi.fn(() => 'http://x/image'),
    readHead: vi.fn(async () => new Uint8Array(0)),
  },
}))
```

`api.textPreview` / `api.tarEntryText` を使っている既存テストを `api.readHead` に書き換える。例:

```tsx
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

it('renders text preview for a plain text file', async () => {
  vi.mocked(api.readHead).mockResolvedValue(utf8('hello text'))
  render(<PinnedPreviewCard item={item({ key: 'notes/readme.txt' })} />)
  expect(await screen.findByText('hello text')).toBeInTheDocument()
  const title = screen.getByTitle('notes/readme.txt')
  expect(title).toHaveTextContent('readme.txt')
})
```

`'renders a lightweight tarEntryText body for a tar-entry text pin'` も同様に `readHead` を `utf8('entry text body')` に。

`'単体テキストファイルのピンは固定高さの pre で表示される'` / `'tar エントリのテキストも固定高さの pre で表示される'` / JSON 整形の 4 本も、`api.textPreview` / `api.tarEntryText` を `api.readHead` + `utf8(...)` に置換する。

非対応テストを差し替える:

```tsx
it('NUL を含むファイルは「プレビュー非対応」になる (拡張子ではなく中身で判定)', async () => {
  vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
  render(<PinnedPreviewCard item={item({ key: 'weird.xyz' })} />)
  expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
})

it('拡張子が未知でも中身がテキストなら開ける', async () => {
  vi.mocked(api.readHead).mockResolvedValue(utf8('FROM alpine'))
  render(<PinnedPreviewCard item={item({ key: 'Dockerfile' })} />)
  expect(await screen.findByText('FROM alpine')).toBeInTheDocument()
})
```

`front/components/BottomDock.test.tsx` に api mock を足す（先頭の import 群の直後）。

**注意:** `BottomDock` は `PlayerDeck` も描画する。api モジュールを丸ごと mock すると
`PlayerDeck` が呼ぶ `api.audioUrl`（`useAudioSrc` 経由）と `api.mediaAnalyze`（波形取得）が
`undefined` になり、`addTrack` するテストが `TypeError` で落ちる。今は mock していないので
実 api が走り fetch 失敗が `.catch` で握り潰されている。両方を mock に含めること。

```tsx
// x.bin / y.bin のカードは中身をスニッフするようになったので、NUL を返して
// バイナリ (=「プレビュー非対応」) に落とす。
// audioUrl / mediaAnalyze は同居する PlayerDeck が呼ぶ。mediaAnalyze は reject させて
// おけば PlayerDeck 側の .catch が拾い、波形なしで続行する (本テストの関心外)。
vi.mock('../lib/api/client', () => ({
  api: {
    downloadUrl: vi.fn(() => 'http://x/dl'),
    textPreviewUrl: vi.fn(() => 'http://x/text'),
    readHead: vi.fn(async () => new Uint8Array([0x00])),
    audioUrl: vi.fn(() => 'http://x/audio'),
    mediaAnalyze: vi.fn(async () => { throw new Error('unavailable') }),
  },
}))
```

同ファイルの「プレビュー非対応」を見る 3 箇所を非同期にする:

```tsx
  it('カードがグリッドに描画され、「全部外す」で全ピンが消える (デッキ 0 ならドックごと消える)', async () => {
    setup(<AddPinButton k="y.bin" />)
    fireEvent.click(screen.getByText('addPin:x.bin'))
    fireEvent.click(screen.getByText('addPin:y.bin'))
    expect(screen.getByText(/ピン留め \(2\)/)).toBeInTheDocument()
    expect(await screen.findAllByText(/プレビュー非対応/)).toHaveLength(2)
    fireEvent.click(screen.getByText('全部外す'))
    expect(document.querySelector('.fixed')).toBeNull()
  })

  it('折りたたみトグルでカードが隠れる (ヘッダは残る)', async () => {
    setup()
    fireEvent.click(screen.getByText('addPin:x.bin'))
    expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/ピン留め \(1\)/))
    expect(screen.queryByText(/プレビュー非対応/)).not.toBeInTheDocument()
    expect(screen.getByText(/ピン留め \(1\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/ピン留め \(1\)/))
    expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
  })
```

`BottomDock.test.tsx` の `AddPinButton` のコメントを更新する:

```tsx
// key は NUL を返す readHead mock でバイナリ判定に落ち、カード本体が重い
// プレビューを描画しない (PreviewDrawer.test.tsx の 'file.xyz' と同じ発想)。
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd front && npx vitest run components/PinnedPreviewCard.test.tsx components/BottomDock.test.tsx`
Expected: FAIL — `api.textPreview is not a function` / 非対応の文言が同期では出ない

- [ ] **Step 3: Write minimal implementation**

`front/components/PinnedPreviewCard.tsx`:

`unsupportedMessage` 定数（`:9-13`）を削除し、import に `useSniffedText` と `UnsupportedPreview` を足す。`PinnedTextBody` を書き換える:

```tsx
// ピンカード内のテキスト/JSON 表示。url は単体ファイルなら api.textPreviewUrl、
// tar エントリなら api.tarEntryUrl。minify された 1 行 JSON でも潰れないよう固定高さ
// (音声カードのスペクトログラム相当) にして縦横スクロールで読ませる。name は拡張子
// 判定用のファイル名 (単体は key、tar エントリは entryPath)。
function PinnedTextBody({ name, url }: { name: string; url: string }) {
  const sniffed = useSniffedText(url)

  if (sniffed.status === 'error') return <p className="error">{sniffed.message}</p>
  if (sniffed.status === 'loading') return <p className="text-[13px] text-ink-7">loading…</p>
  if (sniffed.status === 'binary') return <UnsupportedPreview />

  const display = prettyPrintJson(name, sniffed.text)
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
      {display}
    </pre>
  )
}
```

`PinnedPreviewBody` の分岐を書き換える:

```tsx
function PinnedPreviewBody({ item }: { item: PinnedItem }) {
  const { connId, bucket, key, entryPath } = item
  if (entryPath != null) {
    const kind = classifyEntry(entryPath)
    if (kind === 'audio') {
      return <PreviewAudio connId={connId} bucket={bucket} k={key} entryPath={entryPath} />
    }
    if (kind === 'image') {
      return <PinnedEntryImage connId={connId} bucket={bucket} archiveKey={key} entry={entryPath} />
    }
    // text / unknown はどちらも中身で判定する。
    return <PinnedTextBody name={entryPath} url={api.tarEntryUrl(connId, bucket, key, entryPath)} />
  }
  const kind = classify(key)
  if (kind === 'image')   return <PreviewImage connId={connId} bucket={bucket} k={key} />
  if (kind === 'audio')   return <PreviewAudio connId={connId} bucket={bucket} k={key} />
  if (kind === 'archive') return <PreviewArchive connId={connId} bucket={bucket} k={key} />
  return <PinnedTextBody name={key} url={api.textPreviewUrl(connId, bucket, key)} />
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd front && npx vitest run components/PinnedPreviewCard.test.tsx components/BottomDock.test.tsx`
Expected: PASS

Run: `cd front && npx vitest run && npx tsc -b --noEmit`
Expected: 全パス、tsc OK

- [ ] **Step 5: Commit**

```bash
git add front/components/PinnedPreviewCard.tsx front/components/PinnedPreviewCard.test.tsx \
        front/components/BottomDock.test.tsx
git commit -m "$(cat <<'EOF'
feat: ピンカードのプレビューを中身のスニッフに載せ替える

拡張子が未知でも中身がテキストなら開く。.json のプリティプリントは表示上の
整形として残す (描画先の分岐ではないので拡張子リストの復活には当たらない)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: tar エントリモーダルをスニッフに載せ替える

**Files:**
- Modify: `front/components/TarEntryModal.tsx`（`TextBody` 書き換え、`UnknownBody` 削除、本文分岐）
- Test: `front/components/TarEntryModal.test.tsx`
- Test: `front/components/PreviewArchive.test.tsx`（モーダルが `tarEntryText` ではなく `readHead` を使う）

**Interfaces:**
- Consumes: `useSniffedText`（Task 3）、`UnsupportedPreview`（Task 4）、`prettyPrintJson`（Task 5）、`api.tarEntryUrl`（既存）
- Produces: なし

- [ ] **Step 1: Write the failing test**

`front/components/TarEntryModal.test.tsx` の mock を差し替える:

```tsx
vi.mock('../lib/api/client', () => ({
  api: {
    tarEntryUrl: vi.fn(() => 'http://x/entry'),
    readHead: vi.fn(async () => new Uint8Array(0)),
  },
}))
```

既存の 2 本を `readHead` ベースに書き換える:

```tsx
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('TarEntryModal - copy all', () => {
  it('copies the full pretty-printed text of a .json entry', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('{"a":1}'))
    renderEntry('x.json')
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('{\n  "a": 1\n}')
  })

  it('copies the raw text of a .jsonl entry (no pretty-print)', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('{"a":1}\n{"b":2}'))
    renderEntry('x.jsonl')
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('{"a":1}\n{"b":2}')
  })
})
```

スニッフの describe を追加する:

```tsx
describe('TarEntryModal - スニッフ', () => {
  it('拡張子が未知でも中身がテキストなら開ける', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('root:x:0:0'))
    renderEntry('etc/passwd')
    expect(await screen.findByText(/root:x:0:0/)).toBeInTheDocument()
  })

  it('NUL を含むエントリは「プレビュー非対応」', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
    renderEntry('feat.npy')
    expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
  })
})
```

`'opened tar エントリの 📌 を押すとピンに積まれる'` は `entry={{ name: 'file.bin', size: 7, type: '' }}` のままでよいが、`readHead` が既定で空を返すのでテキスト扱いになる。ピン留めの検証には影響しない。

`front/components/PreviewArchive.test.tsx` の api mock から `tarEntryText` を外し `readHead` を足す:

```tsx
    tarEntryUrl: vi.fn(() => 'http://x/entry'),
    // モーダル本文はスニッフ経由で取得される。
    readHead: vi.fn(async () => new TextEncoder().encode('entry body')),
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd front && npx vitest run components/TarEntryModal.test.tsx`
Expected: FAIL — `api.tarEntryText is not a function`

- [ ] **Step 3: Write minimal implementation**

`front/components/TarEntryModal.tsx`:

import から `useState`（`TextBody` 用に `copyMsg` だけ残る）と `useSniffedText` / `UnsupportedPreview` を整理し、`TextBody` を書き換える:

```tsx
function TextBody({ url, name }: { url: string; name: string }) {
  const sniffed = useSniffedText(url)
  const [copyMsg, setCopyMsg] = useState<string | null>(null)

  if (sniffed.status === 'error') return <p className="error">{sniffed.message}</p>
  if (sniffed.status === 'loading') return <p className="text-[13px] text-ink-7">loading…</p>
  if (sniffed.status === 'binary') return <UnsupportedPreview />

  const display = prettyPrintJson(name, sniffed.text)

  // 末尾の改行で行数が余分に増えないようにする。
  const trimmed = display.endsWith('\n') ? display.slice(0, -1) : display
  const lines = trimmed.length === 0 ? 0 : trimmed.split('\n').length

  const handleCopy = async () => {
    const ok = await copyToClipboard(display)
    setCopyMsg(ok ? 'コピーしました ✓' : 'コピー失敗')
    setTimeout(() => setCopyMsg(null), 1500)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[11px] text-ink-7 tabular-nums"
          style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
        >
          {lines} 行
        </span>
        <button
          type="button"
          className="ghost text-[11px]"
          onClick={handleCopy}
          title="内容をコピー"
          aria-label="内容をコピー"
        >
          {copyMsg ?? '内容をコピー'}
        </button>
      </div>
      <pre
        className="m-0 max-h-[70vh] overflow-auto whitespace-pre p-3 text-[12px] leading-snug"
        style={{
          fontFamily: 'var(--font-mono)',
          background: 'var(--ink-0)',
          border: '1px solid var(--rule)',
          borderRadius: 'var(--radius-2)',
          color: 'var(--ink-11)',
        }}
      >
        {display}
      </pre>
    </div>
  )
}
```

`UnknownBody` 関数を削除し、本文分岐を書き換える:

```tsx
        <div className="overflow-auto">
          {kind === 'image' && <ImageBody url={url} alt={entry.name} />}
          {kind === 'audio' && (
            <PreviewAudio
              key={`${connId}|${bucket}|${archiveKey}|${entry.name}`}
              connId={connId}
              bucket={bucket}
              k={archiveKey}
              entryPath={entry.name}
            />
          )}
          {/* 画像 / 音声以外はすべてテキストとして開こうとする。
              中身がバイナリなら TextBody が「プレビュー非対応」を出す。 */}
          {kind !== 'image' && kind !== 'audio' && <TextBody url={url} name={entry.name} />}
        </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd front && npx vitest run components/TarEntryModal.test.tsx components/PreviewArchive.test.tsx`
Expected: PASS

Run: `cd front && npx vitest run && npx tsc -b --noEmit`
Expected: 全パス、tsc OK

- [ ] **Step 5: Commit**

```bash
git add front/components/TarEntryModal.tsx front/components/TarEntryModal.test.tsx \
        front/components/PreviewArchive.test.tsx
git commit -m "$(cat <<'EOF'
feat: tar エントリモーダルのプレビューを中身のスニッフに載せ替える

画像 / 音声以外はすべてテキストとして開こうとし、NUL を含めば非対応に落ちる。
UnknownBody は UnsupportedPreview に置き換えて削除。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `classify()` から `'text'` を削除する

**Files:**
- Modify: `front/lib/api/mime.ts`
- Modify: `front/components/PreviewDrawer.tsx`（`kind === 'text' || kind === 'unknown'` → `kind === 'unknown'`）
- Modify: `front/lib/api/client.ts`（不要になった `textPreview` / `tarEntryText` を削除）
- Test: `front/lib/api/mime.test.ts`

**Interfaces:**
- Consumes: Task 4〜6 で全描画箇所が `unknown` をテキストとして扱えるようになっていること
- Produces: `export type PreviewKind = 'image' | 'audio' | 'archive' | 'unknown'`

ここが本設計の要点。**text の拡張子リストを丸ごと消す。**

- [ ] **Step 1: Write the failing test**

`front/lib/api/mime.test.ts` の 2 つ目の describe を差し替える:

```ts
describe('classify - その他種別は影響を受けない', () => {
  it.each([
    ['a.png', 'image'],
    ['a.tar.xz', 'archive'],
    ['a.bin', 'unknown'],
    ['a.m4v', 'unknown'], // 動画は audio に巻き込まない
  ] as const)('%s -> %s', (key, kind) => {
    expect(classify(key)).toBe(kind)
  })

  it('tar エントリでは archive を unknown に落とすが audio は残す', () => {
    expect(classifyEntry('inner.tar')).toBe('unknown')
    expect(classifyEntry('clip.m4a')).toBe('audio')
  })
})

describe('classify - テキストは拡張子で判定しない', () => {
  // テキストかどうかは描画時に中身 (先頭 64KB の NUL) で決める。ここで
  // 'text' を返してしまうと、拡張子リストの保守が永遠に終わらない。
  it.each([
    'a.md', 'a.jsonl', 'a.txt', 'a.csv',
    'README', 'Dockerfile', 'run.sh', 'conf.toml', 'utt.lab',
  ])('%s は unknown (= 中身を見る)', key => {
    expect(classify(key)).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd front && npx vitest run lib/api/mime.test.ts`
Expected: FAIL — `expected 'text' to be 'unknown'`

- [ ] **Step 3: Write minimal implementation**

`front/lib/api/mime.ts`（text 判定を削除）:

```ts
// 拡張子から判別できる種別だけを返す。テキストかどうかは拡張子では決めない —
// 中身の先頭バイトを見て決める (front/lib/textSniff.ts)。拡張子リストを持つと
// README / Dockerfile / .py / .lab … と際限なく足し続けることになるため。
// image / audio / archive はサーバーが拡張子から Content-Type を決める
// (api/routes/storage-preview.ts の IMAGE_MIME / AUDIO_MIME) ので拡張子判定のまま。
export type PreviewKind = 'image' | 'audio' | 'archive' | 'unknown'

export function classify(key: string): PreviewKind {
  const k = key.toLowerCase()
  if (k.endsWith('.tar') || k.endsWith('.tar.gz') ||
      k.endsWith('.tgz') || k.endsWith('.tar.xz')) {
    return 'archive'
  }
  const ext = /\.([a-z0-9]+)$/.exec(k)?.[1] ?? ''
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image'
  // 音声: <audio> で再生できる主要フォーマットを広く拾う。ブラウザ/OS のコーデック
  // 次第で再生できないもの (wma, aiff 等) も含むが、その場合もプレイヤー + DL ボタンが
  // 出るので「プレビュー非対応」より親切。サーバ側 Content-Type は
  // api/routes/storage-preview.ts の AUDIO_MIME と対応させること。
  if ([
    'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus',
    'm4a', 'm4b', 'aac', 'weba',
    'aiff', 'aif', 'wma',
  ].includes(ext)) return 'audio'
  return 'unknown'
}

// tar 内エントリ用のサブセット — tar-in-tar はレンダリングしない。
export type EntryKind = Exclude<PreviewKind, 'archive'>

export function classifyEntry(name: string): EntryKind {
  const k = classify(name)
  return k === 'archive' ? 'unknown' : k
}
```

`front/components/PreviewDrawer.tsx` の条件を縮める:

```tsx
        {/* 画像 / 音声 / アーカイブ以外はすべてテキストとして開こうとする。
            中身がバイナリなら PreviewText 側が「プレビュー非対応」を出す。 */}
        {kind === 'unknown' && (
          <PreviewText key={`${connId}|${bucket}|${k}`} connId={connId} bucket={bucket} k={k} />
        )}
```

`front/lib/api/client.ts` から使われなくなった 2 つを削除する:

- `textPreview`（`api.textPreviewUrl` の直前にある `textPreview: async (...)` ブロック全体）
- `tarEntryText`（`tarEntryUrl` の直後のブロック全体）

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd front && npx vitest run lib/api/mime.test.ts`
Expected: PASS

Run: `cd front && npx vitest run && npx tsc -b --noEmit && npm run build`
Expected: 全パス、tsc OK、build OK（未使用 import があれば tsc / eslint が落とす）

Run: `cd front && npm run lint 2>&1 | tail -2`
Expected: `✖ 4 problems (4 errors, 0 warnings)` — 本 PR 以前から存在する既存分のみ。増えていないこと。

- [ ] **Step 5: Commit**

```bash
git add front/lib/api/mime.ts front/lib/api/mime.test.ts \
        front/components/PreviewDrawer.tsx front/lib/api/client.ts
git commit -m "$(cat <<'EOF'
feat: classify からテキストの拡張子リストを削除する

テキストかどうかは描画時に中身 (先頭 64KB の NUL) で決めるので、拡張子で
判定する必要がなくなった。README / Dockerfile / .py / .lab が何も足さずに
開くようになる。image / audio / archive はサーバーが拡張子から Content-Type を
決めるため拡張子判定のまま残す。

使われなくなった api.textPreview / api.tarEntryText を削除。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: ピン留めゲートの撤廃

**Files:**
- Modify: `front/components/storage/EntryTable.tsx:123`（`FileRow`）と `:234`（`FileCard`）
- Modify: `front/components/PreviewArchive.tsx`（tar エントリ行の `classifyEntry(...) !== 'unknown'` ゲート）
- Test: `front/components/storage/EntryTable.pin.test.tsx`
- Test: `front/components/PreviewArchive.test.tsx`

**Interfaces:**
- Consumes: Task 7（`classify` が `'text'` を返さなくなったので、`isPreviewable` は事実上「画像/音声/アーカイブか」でしかない）
- Produces: なし

スニッフしてみるまでテキストかどうか分からない以上、拡張子でピン留めメニューを出し分けると「ドロワーでは開けるのにピン留めはできない」という不揃いが残る。バイナリをピン留めしたらカードに「非対応」と出るだけで実害はない。

- [ ] **Step 1: Write the failing test**

`front/components/storage/EntryTable.pin.test.tsx` の 2 本目を差し替える:

```tsx
  it('unknown 種別のファイルにも出る (中身を見るまでテキストか分からないため)', () => {
    setup([{ key: 'a.weird', size: 10 }])
    fireEvent.click(screen.getByRole('button', { name: 'アクション' }))
    fireEvent.click(screen.getByText('ピン留め'))
    expect(screen.getByTestId('count').textContent).toBe('1')
  })
```

`front/components/PreviewArchive.test.tsx` の 3 本目を差し替える:

```tsx
  it('unknown 種別 (bin) にもピン留めが出る (デッキに追加は音声のみ)', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
      </PinnedPreviewsProvider>,
    )
    await openMenuFor('blob.bin')
    expect(screen.getByRole('menuitem', { name: 'このエントリをダウンロード' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'ピン留め' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'デッキに追加' })).not.toBeInTheDocument()
  })
```

同ファイルの `'json エントリにはピン留め・ダウンロードのみ (デッキに追加は出ない)'` はそのまま通る。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd front && npx vitest run components/storage/EntryTable.pin.test.tsx components/PreviewArchive.test.tsx`
Expected: FAIL — 「ピン留め」が見つからない

- [ ] **Step 3: Write minimal implementation**

`front/components/storage/EntryTable.tsx` の `FileRow`（`:123` 付近）:

```tsx
  const isAudio = classify(f.key) === 'audio'
  const items = useMemo<MenuItem[]>(() => [
    ...(isAudio ? [{
      kind: 'action' as const,
      label: 'デッキに追加',
      onSelect: () => deck.addTrack({
        label: filename, connId, bucket, key: f.key,
      }),
    }] : []),
    // 種別で出し分けない。中身を見るまでテキストかどうか分からないので、
    // 拡張子でゲートすると「ドロワーでは開けるのにピン留めできない」不揃いが残る。
    // バイナリをピンしてもカードに「プレビュー非対応」と出るだけで実害はない。
    {
      kind: 'action' as const,
      label: 'ピン留め',
      onSelect: () => pinned.addPin({ connId, bucket, key: f.key }),
    },
    { kind: 'download', label: 'このファイルをダウンロード', href: downloadUrl, filename },
    { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
    { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
  ], [isAudio, deck, pinned, connId, bucket, f.key, downloadUrl, webUrl, s3Url, filename])
```

`isPreviewable` の宣言（`:123`）を削除する。`FileCard`（`:234` 付近）も同一の変更を行う（`isPreviewable` 宣言の削除、ゲートの解除、`useMemo` の deps から `isPreviewable` を除去）。

`front/components/PreviewArchive.tsx` の行メニュー:

```tsx
              const items: MenuItem[] = [
                ...(classify(e.name) === 'audio' ? [{
                  kind: 'action' as const,
                  label: 'デッキに追加',
                  onSelect: () => deck.addTrack({
                    label: e.name,
                    connId, bucket, key: k, entryPath: e.name,
                  }),
                }] : []),
                // 種別で出し分けない (EntryTable と同じ理由)。
                {
                  kind: 'action' as const,
                  label: 'ピン留め',
                  onSelect: () => addPin({ connId, bucket, key: k, entryPath: e.name }),
                },
```

`classifyEntry` が未使用になるので import から外す（`front/components/PreviewArchive.tsx:4`）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd front && npx vitest run components/storage/EntryTable.pin.test.tsx components/PreviewArchive.test.tsx`
Expected: PASS

Run: `cd front && npx vitest run && npx tsc -b --noEmit && npm run lint 2>&1 | tail -2`
Expected: 全パス、tsc OK、lint は既存の 4 件のみ

- [ ] **Step 5: Commit**

```bash
git add front/components/storage/EntryTable.tsx front/components/storage/EntryTable.pin.test.tsx \
        front/components/PreviewArchive.tsx front/components/PreviewArchive.test.tsx
git commit -m "$(cat <<'EOF'
feat: 全ファイルをピン留め可にする

中身を見るまでテキストかどうか分からないので、拡張子でピン留めメニューを
出し分けると「ドロワーでは開けるのにピン留めできない」という不揃いが残る。
バイナリをピンしてもカードに「プレビュー非対応」と出るだけで実害はない。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 実アプリでの検証

**Files:**
- なし（検証のみ）

**Interfaces:**
- Consumes: Task 1〜8 のすべて
- Produces: なし

- [ ] **Step 1: 全自動テスト・型・ビルド・lint**

```bash
cd front
npx vitest run
npx tsc -b --noEmit
npm run build
npm run lint 2>&1 | tail -2
```

Expected: 全テストパス / tsc OK / build OK / lint は既存 4 件のみ（増えていないこと）

- [ ] **Step 2: dev スタックに検証用フィクスチャを投入**

dev の minio に、検証専用のバケットを作って投入する（既存の `audio-e2e` は触らない）。

`\xNN` は `/bin/sh` の `printf` で移植性がないため、8 進エスケープ（`\NNN`）を使う。

```bash
FX=$(mktemp -d)
mkdir -p "$FX/plain" "$FX/build/deep"
printf '# mado\n\nREADME に拡張子は無い。\n' > "$FX/plain/README"
printf 'FROM alpine\nRUN echo hi\n'          > "$FX/plain/Dockerfile"
printf '#!/bin/sh\necho hello\n'             > "$FX/plain/run.sh"
printf '[tool]\nname = "mado"\n'             > "$FX/plain/conf.toml"
# Shift_JIS の「あいう」(NUL を含まない → 文字化けしつつ表示されること)
printf '\202\240\202\242\202\244\n'          > "$FX/plain/sjis.txt"
# npy 相当 (\223 NUMPY + version 1.0 → 先頭に NUL を含む → 非対応に落ちること)
printf '\223NUMPY\001\000v\000{"descr": "<f4"}' > "$FX/plain/feat.npy"

# 生成物を確認: sjis.txt に NUL が無く、feat.npy に NUL があること。
# grep で NUL は探せない ($(printf '\000') はコマンド置換で空文字列になる) ので od で見る。
has_nul() { od -An -tx1 "$1" | tr -s ' ' '\n' | grep -qx '00'; }
has_nul "$FX/plain/sjis.txt" && echo "sjis.txt: NUL あり (NG)" || echo "sjis.txt: NUL なし OK"
has_nul "$FX/plain/feat.npy" && echo "feat.npy: NUL あり OK" || echo "feat.npy: NUL なし (NG)"

cp "$FX/plain/README" "$FX/plain/feat.npy" "$FX/build/deep/"
tar -cf "$FX/pack.tar" -C "$FX/build" deep

mkdir -p "$FX/up/plain" "$FX/up/shards"
cp "$FX/plain/"* "$FX/up/plain/"
cp "$FX/pack.tar" "$FX/up/shards/"

docker cp "$FX/up" mado-dev-minio:/tmp/fx
docker exec mado-dev-minio mc alias set local http://127.0.0.1:9000 minioadmin minioadmin
docker exec mado-dev-minio mc mb -p local/sniff-check
docker exec mado-dev-minio mc cp --recursive /tmp/fx/ local/sniff-check/
```

- [ ] **Step 3: ブラウザで確認**

`docker compose -f compose.dev.yaml up -d` の後、`http://localhost:5173` を開き、接続 `minio-e2e` の `sniff-check` バケットで次を確認する。

| 確認項目 | 期待 |
|---|---|
| `plain/README` を開く | 中身が表示される（拡張子なし） |
| `plain/Dockerfile` / `run.sh` / `conf.toml` を開く | 中身が表示される |
| `plain/sjis.txt` を開く | **文字化けしつつ表示される**（「プレビュー非対応」にならない） |
| `plain/feat.npy` を開く | 「プレビュー非対応」 |
| `plain/feat.npy` を ⋯ からピン留め | カードに「プレビュー非対応」が出る（メニュー項目自体は出る） |
| `shards/pack.tar` → `deep/README` | 中身が表示される |
| `shards/pack.tar` → `deep/feat.npy` | 「プレビュー非対応」 |
| 既存の `audio-e2e` の `.wav` / `.tar` / `.json` | 挙動が変わっていない |

- [ ] **Step 4: 転送量が 64 KB 以内に収まることを確認**

DevTools の Network を開いた状態で `shards/pack.tar` の中の大きめのバイナリエントリを開き、`preview/tar-entry` のレスポンスサイズが 64 KB 前後で止まる（全量落ちていない）ことを確認する。

- [ ] **Step 5: 後片付け**

```bash
docker exec mado-dev-minio mc rb --force local/sniff-check
docker exec mado-dev-minio sh -c 'rm -rf /tmp/fx'
rm -rf "$FX"
```

`docker exec mado-dev-minio mc ls local` の結果が `audio-e2e/` のみになること。

- [ ] **Step 6: Commit（検証で修正が入った場合のみ）**

検証で問題が見つかったら修正し、該当タスクのコミットに fixup するか新規コミットを積む。問題がなければコミット不要。

---

## Self-Review

**1. Spec coverage**

| 設計セクション | 対応タスク |
|---|---|
| 判定ロジック（NUL のみ、`fatal` なし） | Task 1、Task 3 |
| `readHead`（ストリーム打ち切り） | Task 2 |
| `useSniffedText` フック | Task 3 |
| `UnsupportedPreview` に文言集約 | Task 4（作成）、Task 5・6（利用） |
| `PreviewText` / `PinnedTextBody` / `TarEntryModal.TextBody` の移行 | Task 4・5・6 |
| `mime.ts` から `'text'` 削除 | Task 7 |
| `api.textPreview` / `tarEntryText` 削除 | Task 7 |
| ピン留めゲート撤廃（`EntryTable` / `PreviewArchive`） | Task 8 |
| `.json` プリティプリントを表示上の整形として残す | Task 5（`prettyPrintJson` に抽出）・Task 6（利用） |
| 既存テスト 7 本の更新 | Task 4（`PreviewText` / `PreviewDrawer`）、Task 5（`PinnedPreviewCard` / `BottomDock`）、Task 6（`TarEntryModal` / `PreviewArchive`）、Task 7（`mime`）、Task 8（`EntryTable.pin` / `PreviewArchive`） |
| 検証（`README` / npy / Shift_JIS / 転送量） | Task 9 |

**2. Placeholder scan:** なし。すべてのコードステップに実際のコードを載せた。

**3. Type consistency:**

- `looksBinary(head: Uint8Array): boolean` — Task 1 で定義、Task 3 で使用。一致。
- `TEXT_HEAD_BYTES = 65536` — Task 1 で定義、Task 3 で使用、Task 3 のテストで `65536` を直値検証。一致。
- `api.readHead(url, maxBytes): Promise<Uint8Array>` — Task 2 で定義、Task 3 で使用、Task 4〜6 のテストで mock。一致。
- `SniffedText` の `status` は `'loading' | 'text' | 'binary' | 'error'`、`text` フィールドは `text` 状態のみ、`message` は `error` 状態のみ — Task 3 で定義、Task 4〜6 で `sniffed.text` / `sniffed.message` を各状態のナローイング後にのみ参照。一致。
- `UnsupportedPreview()` — Task 4 で定義、Task 4〜6 で使用。一致。
- `PinnedTextBody({ name, url })` — Task 5 で `load` prop を廃し `url` に変更。同タスク内の呼び出し 2 箇所も `url` に更新済み。一致。
- `TextBody({ url, name })` — Task 6 で `connId` / `bucket` / `archiveKey` / `entry` prop を廃し `url` / `name` に変更。同タスク内の呼び出しも更新済み。一致。
- `PreviewKind` から `'text'` を除去（Task 7）した後、`kind === 'text'` を参照する箇所は残っていない（Task 4 で `PreviewDrawer`、Task 5 で `PinnedPreviewCard`、Task 6 で `TarEntryModal` が先に `unknown` も受けるようになっているため、Task 7 は条件を縮めるだけ）。一致。
