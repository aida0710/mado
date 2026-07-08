# デッキ一括再生の 0 パディング Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 長さの違うトラックを一括再生しても最長トラックが最後まで再生され（短いトラックは終端で無音 = 0 パディング）、波形が共通時間軸で再生ヘッドが揃うようにする。

**Architecture:** マスター時刻を「先頭トラック」から「非終了トラックの currentTime の最大値」へ変更（純関数 `masterTimeOf` を driftSync に追加）。長さ超過トラックはドリフト補正で前へ飛ばさず自然終了させる。Waveform に `durationRatio` を足し、短いトラックのピークを左寄せ・右空白で描き、再生ヘッドは全幅比で揃える。front のみ。

**Tech Stack:** React 19 / vitest / jsdom

**Spec:** `docs/superpowers/specs/2026-07-08-deck-zero-padding-design.md`

## Global Constraints

- ブランチ: feature/audio-explorer。コミットは feat:/fix: + 日本語、amend なし、git stash 禁止
- front lint は main 由来の既存 4 エラーが baseline（新規禁止）
- ドリフト補正のしきい値は既存の 0.05 秒を維持
- マスター時刻 = 非終了(!ended)トラックの currentTime の最大値。非終了が無ければ maxDuration
- `durationRatio` は 0〜1、既定 1。PreviewAudio は未指定（=1）で従来の全幅描画
- 検証は各タスクで `cd front && npx vitest run <対象> && npm test && npx tsc -b && npm run lint`

---

### Task 1: driftSync に masterTimeOf を追加

**Files:**
- Modify: `front/lib/driftSync.ts`
- Test: `front/lib/driftSync.test.ts`（既存に追記）

**Interfaces:**
- Produces: `export function masterTimeOf(trackSecs: Array<number | null>): number | null`
  - trackSecs: 非終了トラックは currentTime(number)、終了(ended)トラックは null。非 null の最大値を返す。全 null なら null

- [ ] **Step 1: 失敗するテストを書く**

`front/lib/driftSync.test.ts` の末尾（既存 describe の外）に追記:

```ts
import { computeDriftAdjustments, masterTimeOf } from './driftSync'

describe('masterTimeOf', () => {
  it('非終了トラックの currentTime の最大値を返す', () => {
    expect(masterTimeOf([1.0, 3.2, 2.5])).toBe(3.2)
  })
  it('終了トラック (null) は無視する', () => {
    // 短いトラックが ended=null。長い方が進み続けてマスターになる
    expect(masterTimeOf([null, 2.7])).toBe(2.7)
  })
  it('全トラック終了 (全 null) なら null', () => {
    expect(masterTimeOf([null, null])).toBeNull()
  })
  it('空配列なら null', () => {
    expect(masterTimeOf([])).toBeNull()
  })
})
```

（既存ファイルが `import { computeDriftAdjustments } from './driftSync'` を持つ場合、その行に `masterTimeOf` を足す形にする。重複 import を作らないこと。）

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run lib/driftSync.test.ts`
Expected: FAIL（masterTimeOf 未定義）

- [ ] **Step 3: 実装**

`front/lib/driftSync.ts` の末尾に追加:

```ts
// 非終了トラックの currentTime の最大値をマスター時刻とする。終了 (ended) は
// null で渡し無視する。全 null (全トラック終了) なら null を返す。
// マスターを「先頭トラック」ではなく「まだ鳴っている中の最長 (最も進んだ) 時刻」に
// することで、短いトラックが終わっても時計が止まらず、長いトラックを終端へ
// 巻き戻さない (= 短いトラックの終端以降は無音 = 0 パディング)。
export function masterTimeOf(trackSecs: Array<number | null>): number | null {
  let max: number | null = null
  for (const t of trackSecs) {
    if (t == null) continue
    if (max == null || t > max) max = t
  }
  return max
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run lib/driftSync.test.ts && npx tsc -b && npm run lint`
Expected: PASS（既存 computeDriftAdjustments テスト含む）

- [ ] **Step 5: Commit**

```bash
git add front/lib/driftSync.ts front/lib/driftSync.test.ts
git commit -m "feat: driftSync に非終了トラック基準のマスター時刻算出を追加"
```

---

### Task 2: Waveform に durationRatio を追加

**Files:**
- Modify: `front/components/Waveform.tsx`
- Test: `front/components/Waveform.test.tsx`（既存に追記）

**Interfaces:**
- Produces: `Waveform` props に `durationRatio?: number`（既定 1、0〜1）。ピークを `canvas 幅 × durationRatio` に左寄せ描画、右側空白。再生ヘッドは従来どおり `progress` を全幅に対して描画

- [ ] **Step 1: 失敗するテストを書く**

`front/components/Waveform.test.tsx` の既存 describe 内に追記（既存テストが `getContext` をスタブして `fillRect` を spy している流儀に合わせる。既存の ctx スタブ変数名を確認して使う）:

```ts
it('durationRatio<1 でピークが左寄せ (幅が縮む) に描画される', () => {
  const fillRect = vi.fn()
  const ctx = {
    clearRect: vi.fn(), fillRect, scale: vi.fn(), setTransform: vi.fn(), fillStyle: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  // clientWidth を 200 に固定
  vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(200)

  render(<Waveform peaks={[[-1, 1], [-1, 1]]} progress={0} durationRatio={0.5} />)

  // ピークの塗り (bar) の x はすべて幅の左半分 (0〜100) に収まる。
  // 最後の fillRect は progress>0 のヘッド線だが progress=0 なので bar のみ。
  const barCalls = fillRect.mock.calls
  const maxX = Math.max(...barCalls.map(c => c[0] as number))
  expect(maxX).toBeLessThan(100)
})
```

注意: 既存テストが `clientWidth` を別途モックしていない場合、jsdom の clientWidth は 0 になり draw が早期 return する。既存テストがどう clientWidth を確保しているか（or 0 でも描画される別経路か）を確認し、既存の成功パターンに合わせてこのテストの canvas 幅確保を書くこと。テストが通る形が正。

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run components/Waveform.test.tsx`
Expected: FAIL（durationRatio 未対応で peaks が全幅 → maxX >= 100、または型エラー）

- [ ] **Step 3: 実装**

`front/components/Waveform.tsx`:

- Props に追加:
```ts
interface Props {
  peaks: Array<[number, number]>
  progress: number
  onSeek?: (ratio: number) => void
  height?: number
  // ピーク描画幅の全幅に対する比 (0〜1、既定 1)。デッキで各トラックの長さ /
  // maxDuration を渡すと、短いトラックは左寄せ + 右側空白になり、全トラックの
  // 再生ヘッド (progress は全幅比のまま) が水平に揃う (0 パディングの可視化)。
  durationRatio?: number
}
```
- シグネチャ: `export function Waveform({ peaks, progress, onSeek, height = 64, durationRatio = 1 }: Props) {`
- draw 内の bar 幅計算を変更（`const barW = w / peaks.length` を差し替え）:
```ts
    // ピークは全幅 × durationRatio の範囲に描く (残りは 0 パディングの空白)。
    const peaksW = w * Math.min(1, Math.max(0, durationRatio))
    const barW = peaksW / peaks.length
```
（`playedX = progress * w` は変更なし = ヘッド線は全幅比。ループ内 `const x = i * barW` はそのまま、`ctx.fillRect(x, top, Math.max(1, barW - 0.5), bh)` もそのまま。）
- `draw` の useCallback 依存配列に `durationRatio` を追加: `}, [peaks, progress, height, durationRatio])`

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run components/Waveform.test.tsx && npm test && npx tsc -b && npm run lint`
Expected: PASS（既存 Waveform テストも維持）

- [ ] **Step 5: Commit**

```bash
git add front/components/Waveform.tsx front/components/Waveform.test.tsx
git commit -m "feat: Waveform に durationRatio (共通時間軸の左寄せ描画) を追加"
```

---

### Task 3: PlayerDeck を max マスター + 0 パディングに統合

**Files:**
- Modify: `front/components/PlayerDeck.tsx`
- Test: `front/components/PlayerDeck.test.tsx`（既存に追記）

**Interfaces:**
- Consumes: `masterTimeOf` (Task 1)、`Waveform` の `durationRatio` (Task 2)、既存 `computeDriftAdjustments`

- [ ] **Step 1: 失敗するテストを書く**

`front/components/PlayerDeck.test.tsx` に追記（既存テストの deck セットアップ・play/pause スタブ・トラック追加ヘルパーの流儀に合わせる。以下は要旨。長さは `onLoadedMetadata` 経由で durations に入るため、テストでは各 `<audio>` の `duration` を定義し loadedmetadata を発火させる or 既存テストの duration 注入手段を踏襲する）:

```ts
it('短いトラックが終了しても masterTime が長いトラックに追従して進む', async () => {
  vi.useFakeTimers()
  // 2 トラック追加 (a: 長さ1, b: 長さ3)。既存ヘルパーで add → <audio> を取得し、
  // a.duration=1, b.duration=3 を定義、onLoadedMetadata を発火して durations を埋める。
  // playAll。1 秒 interval を進める前に a を ended 状態 (a.ended=true, currentTime=1)、
  // b は currentTime=2 に。
  // vi.advanceTimersByTime(1000) 後、時刻表示 (fmt(masterTime)) が b 由来 (0:02) で
  // あり、a.currentTime が 0 に巻き戻されていないことを assert。
  vi.useRealTimers()
})
```

注意: 既存 PlayerDeck.test は jsdom で HTMLMediaElement.play/pause/duration/ended/currentTime を制御する仕組みを既に持っているはず（ドリフト補正やソロのテストがある）。その仕組みを読んで、`ended`/`currentTime`/`duration` を設定できる形でこのテストを書く。`vi.useFakeTimers()` で 1 秒 interval を駆動する。既存テストが fake timer を使っていない場合は、マスター算出ロジックを直接呼べないので、interval を 1 回進めて `screen.getByText('0:02 / 0:03')` 等の表示で検証する。テストが通る形が正。

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run components/PlayerDeck.test.tsx`
Expected: FAIL（現状は master=先頭トラックなので、a が先頭だと masterTime が a の終端で止まる / b が巻き戻る）

- [ ] **Step 3: 実装**

`front/components/PlayerDeck.tsx`:

(a) import に `masterTimeOf` を追加（既存の driftSync import 行に足す）:
```ts
import { computeDriftAdjustments, masterTimeOf } from '../lib/driftSync'
```

(b) マスター時刻 useEffect（現状 76-91 行目付近の `const master = list[0]` のブロック）を差し替え:
```ts
  // マスター時刻 = 非終了トラックの currentTime の最大値。1 秒ごとにドリフト補正。
  // 先頭トラック基準だと最短トラックが終わった瞬間に時計が止まり、補正が長い
  // トラックをその終端へ巻き戻してしまう。max ベースなら短いトラックが終わっても
  // 長いトラックが最後まで進み、短いトラックの終端以降は無音 (0 パディング) になる。
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      // track と audio をペアで保持する。audios() の filter(null 除外) で
      // インデックスがずれる (blob 取得中トラックは <audio> 未マウント) のを避け、
      // computeDriftAdjustments の index から track の長さを正しく引くため。
      const entries = tracks
        .map(t => ({ t, a: audioRefs.current.get(t.id) }))
        .filter((e): e is { t: typeof e.t; a: HTMLAudioElement } => e.a != null)
      if (entries.length === 0) return
      const secs = entries.map(e => (e.a.ended ? null : e.a.currentTime))
      const master = masterTimeOf(secs)
      if (master == null) {
        // 全トラック終了 → 停止し、頭出しに戻れる状態にする。
        setPlaying(false)
        setMasterTime(maxDurationRef.current)
        return
      }
      setMasterTime(master)
      for (const adj of computeDriftAdjustments(master, secs)) {
        const e = entries[adj.index]
        const dur = durations[e.t.id] ?? Infinity
        // 自分の長さを超える位置へは飛ばさない (終端で自然に無音 = 0 パディング)。
        if (adj.to < dur) e.a.currentTime = adj.to
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [playing, tracks, durations])
```

注意: `maxDuration` は現状 render 内で計算される変数で effect からは直接読めない（stale 回避のため）。`maxDurationRef` を用意して同期する:
```ts
  const maxDurationRef = useRef(0)
  // maxDuration は下で render 用にも計算するが、interval effect からも参照するため
  // ref にミラーする。
  useEffect(() => {
    maxDurationRef.current = Math.max(0, ...tracks.map(t => durations[t.id] ?? 0))
  }, [tracks, durations])
```
（既存の `const maxDuration = Math.max(...)` は render 用にそのまま残す。）

(c) `seekAll` を長さガード対応に差し替え:
```ts
  const seekAll = (sec: number): void => {
    for (const t of tracks) {
      const a = audioRefs.current.get(t.id)
      if (!a) continue
      const dur = durations[t.id] ?? Infinity
      // 自分の長さ以内ならその位置へ。超える場合は終端 (無音 = 0 パディング)。
      a.currentTime = Math.min(sec, dur)
      if (playing && sec < dur) void a.play()
    }
    setMasterTime(sec)
  }
```

(d) `playAll` を全終了時の頭出し対応に差し替え:
```ts
  const playAll = (): void => {
    // 全トラック終了状態から ▶ を押したら頭から再生し直す。
    if (maxDuration > 0 && masterTime >= maxDuration) {
      for (const a of audios()) a.currentTime = 0
      setMasterTime(0)
    }
    for (const a of audios()) void a.play()
    setPlaying(true)
  }
```

(e) 各トラック行の `Waveform` に `durationRatio` を渡す（223-227 行目）:
```tsx
                  <Waveform
                    peaks={peaksById[t.id] ?? []}
                    progress={maxDuration > 0 ? masterTime / maxDuration : 0}
                    durationRatio={maxDuration > 0 ? (durations[t.id] ?? 0) / maxDuration : 1}
                    height={28}
                  />
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run components/PlayerDeck.test.tsx && npm test && npx tsc -b && npm run lint`
Expected: PASS（既存デッキテスト全て + 新規。lint baseline 4 のみ）

- [ ] **Step 5: 実機確認（dev スタック）**

長さの違う 2 音声をデッキに積んで一括再生し、(1) 短い方が終わっても時刻/シークバーが最長まで進む、(2) 短い方が巻き戻らない、(3) 短い方の波形が左寄せ + 右空白で、再生ヘッドが両トラックで揃う、を目視。MinIO の recordings/ch1.wav（1 秒）と、長い音声を 1 つ用意（無ければ ffmpeg で数秒の wav を作って put）。

- [ ] **Step 6: Commit**

```bash
git add front/components/PlayerDeck.tsx front/components/PlayerDeck.test.tsx
git commit -m "feat: デッキ一括再生を max マスター + 終端 0 パディングにする"
```
