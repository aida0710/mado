# デッキ一括再生の 0 パディング（start 合わせ + 終端無音 + 波形時間軸統一）

## 背景

同期マルチトラックプレイヤー（デッキ）で長さの異なるトラックを一括再生すると、現状は「マスター時刻 = 先頭トラックの currentTime」で動くため、先頭が最短だと**先頭が終わった瞬間にマスター時計が止まり、ドリフト補正が長いトラックをその終端へ毎秒巻き戻す**。結果、長いトラックが最後まで再生できない。

これを「**スタートを合わせ、短いトラックは終端以降を無音（0 パディング）**」として扱うよう直す。あわせて波形もマルチトラックエディタ風に共通時間軸で描き、再生ヘッドを全トラックで水平に揃える。

## 目的

- 長さの違うトラックを一括再生しても、最長トラックが最後まで再生される
- 短いトラックは自分の終端で無音になり、長いトラックを巻き戻さない
- シークバー / 時刻表示は maxDuration（最長）まで進む
- 波形は共通時間軸で描画され、短いトラックは左寄せ + 右側空白、再生ヘッドが全トラックで揃う

## 設計

### A. マスター時計とトランスポート（`front/components/PlayerDeck.tsx` + `front/lib/driftSync.ts`）

- **マスター時刻の算出を変更**: 「先頭トラック」ではなく「**まだ終わっていない（`!ended`）トラックの currentTime の最大値**」。非終了トラックが無ければ maxDuration。
  - `driftSync.ts` に純関数を追加/変更してマスター算出をテスト可能にする:
    ```ts
    // 非終了トラックの currentTime の最大値。全終了なら null (呼び出し側で maxDuration 扱い)。
    export function masterTimeOf(trackSecs: Array<number | null>): number | null
    // trackSecs: 非終了は currentTime、終了(ended)は null。全 null → null
    ```
- **ドリフト補正**: 既存 `computeDriftAdjustments(masterSec, trackSecs, threshold?)` はそのまま使う。ただしマスターは上記 max、`trackSecs` は「終了トラック = null（補正対象外）」。加えて `masterTime >= そのトラックの長さ` のトラックは補正で前へ飛ばさない（終端で自然終了させ、以降は無音 = 0 パディング）。この長さガードは PlayerDeck 側の補正適用ループで `durations[track.id]` を見て行う。
- **全トラック終了で停止**: 非終了トラックが 0 になったら `playing=false`、`masterTime = maxDuration`。▶ で頭から再生し直せる状態にする。
- **`seekAll(sec)`**: 各トラックで `sec < 長さ` なら `currentTime = sec`（再生中なら再生継続）、`sec >= 長さ` なら終端（`currentTime = 長さ`, 無音）。`masterTime = sec`。
- **`playAll`**: `masterTime >= maxDuration`（全終了状態）なら先に `seekAll(0)` してから全 `play()`。それ以外は従来どおり。
- `onTrackArrive`（後着トラックの追従）は現状のまま。マスターの取り方が max ベースに変わっても「自分以外から選ぶ」ロジックは有効。

### B. 波形の共通時間軸（`front/components/Waveform.tsx`）

- `Waveform` props に optional `durationRatio?: number`（既定 1、0〜1）を追加。
  - ピークは canvas 幅 × `durationRatio` の範囲に**左寄せ描画**し、右側は空白のまま（= 0 パディングが視認できる）。
  - 再生ヘッド線は従来どおり `progress`（0〜1）を全幅に対して描く。
- デッキは各トラック行の `Waveform` に:
  - `durationRatio = (durations[t.id] ?? 0) / maxDuration`（maxDuration が 0 のときは 1）
  - `progress = maxDuration > 0 ? masterTime / maxDuration : 0`（現状のまま）
  - を渡す。これで短いトラックはピークが左に縮み、全トラックの再生ヘッドが同じ x 位置に揃う。
- PreviewAudio（単体プレビュー）は `durationRatio` 未指定 = 1 なので従来どおり全幅描画（影響なし）。

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| 最短トラックが終了 | 無音になり、マスターは残りの最長トラックに追従して進み続ける |
| 短いトラックの終端超えにシーク | そのトラックは無音（終端固定）、長いトラックは再生 |
| 短いトラックの範囲内へ戻すシーク | 再生中ならそのトラックも再生を再開 |
| 全トラック終了 | `playing=false` + マスター=maxDuration。▶ で先頭から再生 |
| maxDuration が 0（durations 未取得） | `durationRatio` は 1 にフォールバック（波形は全幅）、再生は従来どおり |
| 1 トラックのみ | max = そのトラック、従来と同じ挙動（durationRatio=1） |

## テスト

- **driftSync**: `masterTimeOf` — 非終了の最大を返す / 一部 null（終了）を無視 / 全 null で null。`computeDriftAdjustments` は既存テスト維持
- **Waveform**: `durationRatio=0.5` でピーク描画が左半分に収まる（fillRect の x 範囲）/ `progress` は全幅比で再生ヘッド位置が決まる（canvas スタブで fillRect 呼び出しを検証）/ 既定 1 で従来描画
- **PlayerDeck**: 長さ違い 2 トラック（例 durations {a:1, b:3}）で、(1) a が ended 後も masterTime が b に追従して進む（1 秒 interval を fake timer で回し、a.ended=true, b.currentTime 前進 → masterTime が b 由来）/ (2) a が巻き戻されない（a.currentTime が 0 に設定されない）/ (3) seekAll(2) で a は終端（`currentTime = 1` かつ無音扱い）、b は 2

## ロールバック

- 全て front。マスター算出を先頭ベースに戻し、Waveform の durationRatio を外せば元に戻る（が、これは既存バグ修正なので通常は戻さない）
