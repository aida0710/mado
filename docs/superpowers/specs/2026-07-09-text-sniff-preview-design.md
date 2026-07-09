# 拡張子に頼らないテキストプレビュー（内容スニッフ）

## 背景

`.npy` を開きたい、という要望が発端だった。しかし npy は先頭に `\x93NUMPY` + ヘッダ辞書を持つバイナリで、生のまま文字として出せない。numpy の `print` 相当に整形するには専用のパーサとレンダラが要り、次は `.pt`、`.h5`、`.parquet` … と際限がなくなる。**形式ごとのレンダラは追加しない**方針とした。

代わりに拾うのは「普通に txt で開けるものは全部開けるようにしたい」という本来の要求である。現状 `classify()` は拡張子の allowlist（`txt` `md` `json` `jsonl` `ndjson` `yaml` `yml` `csv` `tsv` `log`）でしかテキストを判定しないため、以下が「プレビュー非対応」になる。

- 拡張子なしのファイル（`README` / `LICENSE` / `Dockerfile` / `Makefile`）
- ソースコードや設定（`.py` `.sh` `.toml` `.ini` `.cfg` `.xml` `.sql`）
- 音声コーパス由来の書き起こし（`.lab` `.scp` `.trn` `.stm` `.vtt` `.srt`）

allowlist を伸ばしても、次に来る拡張子でまた伸ばすことになる。これは「無限に対応が必要」の縮小版でしかない。

## 目的

- **テキストの拡張子リストを丸ごと削除**し、中身がテキストであるファイルを開けるようにする
- npy のようなバイナリは今までどおり「プレビュー非対応」に落ちる
- 利用者から見て挙動が悪化するケースを作らない（今まで開けたものは全部開ける）。
  ただし **UTF-16 のテキストファイルだけは唯一の例外**として退行する（詳細は「エラー処理」参照）

## 非目標

- npy / pt / h5 / parquet など、形式固有のパーサやレンダラ
- 文字コードの自動判別（デコードは従来どおり UTF-8 の不可逆デコード）
- サーバー側 API の変更

## 設計

### 全体像

テキストかどうかを**拡張子で決めるのをやめ、中身で決める**。`classify()` から `'text'` を削除し、`unknown` の意味を「プレビュー非対応」から **「拡張子からは判別できない = 中身を見る」** に変える。

```
classify(key) → 'image' | 'audio' | 'archive' | 'unknown'
                                                  │
                     ┌────────────────────────────┘
                     ▼
              先頭 64 KB を取得
                     │
       ┌─────────────┴─────────────┐
       ▼                           ▼
   NUL を含まない               NUL を含む
       │                           │
       ▼                           ▼
  テキストとして表示        「プレビュー非対応」
```

`image` / `audio` / `archive` の拡張子リストは残す。`<img>` や `<audio>` に流すにはサーバーが拡張子から `Content-Type` を決める必要があり（`api/routes/storage-preview.ts` の `IMAGE_MIME` / `AUDIO_MIME`）、そこは拡張子判定が自然なため。**消えるのは text のリストだけ**である。

`classify()` は**同期のまま**にする。非同期にすると `EntryTable` の「ピン留めできるか」の判定まで非同期に波及するため、スニッフはあくまで**描画時**に行う。

### 1. 判定ロジック（新規 `front/lib/textSniff.ts`）

`driftSync.ts` / `deckAudioGraph.ts` と同じく、純関数を lib に切り出して単体テストする。

```ts
// 先頭バイト列がバイナリなら true。判定は NUL バイトの有無だけ。
export function looksBinary(head: Uint8Array): boolean
```

**NUL バイト（`0x00`）を 1 つでも含めばバイナリ**、それ以外はテキストとして不可逆デコードする。ルールはこれだけである。

- npy は `\x93NUMPY` の直後にバージョンの `\x01\x00` が来るので必ず NUL を含む。
- 64 KB の中に NUL が 1 つも無いバイナリは実質存在しない。
- 逆に UTF-8 妥当性（`TextDecoder` の `fatal: true`）までは**見ない**。見てしまうと、いま文字化けしつつも表示できている Shift_JIS の `.txt` が「プレビュー非対応」に変わってしまい、退行になる。NUL だけを見れば、そうしたファイルは今までどおり表示される。

デコードは既存と同じ不可逆 UTF-8（`new TextDecoder()`、`fatal` なし）。サーバーが 64 KB ちょうどで切って末尾のマルチバイト文字が割れても、置換文字（U+FFFD）1 個で済む。空ファイル（0 バイト）は空文字列 = テキスト扱い。

### 2. 先頭だけ読む fetch（`front/lib/api/client.ts`）

新しいエンドポイントも URL ビルダーも作らない。既存の `api.textPreviewUrl()` と `api.tarEntryUrl()` に、先頭だけ読むヘルパーを噛ませる。

```ts
// 先頭 maxBytes だけ読み、残りは reader.cancel() で捨てる。
readHead(url: string, maxBytes: number): Promise<Uint8Array>
```

上限は `front/lib/textSniff.ts` に `TEXT_HEAD_BYTES = 65536` として置き、サーバーの `PREVIEW_TEXT_LIMIT` と同値にする（別々の場所にある同じ意味の定数なので、片方を変えたら他方も、とコメントで結ぶ）。

`api.textPreviewUrl()` は現在**定義されているが未使用**（`front/lib/api/client.ts:345`）で、本設計で初めて使われる。

- 単体ファイル: `/preview/text` は既にサーバー側で `PREVIEW_TEXT_LIMIT`（64 KB、`api/env.ts:23`）まで読んで返すため、そもそも安全。`readHead` は二重の保険になる。
- tar エントリ: `/preview/tar-entry` は Range 非対応で常に全量（最大 100 MB）返す。`readHead` がストリームを 64 KB で打ち切ることで、**100 MB の npy を落としてから弾く事故を防ぐ**。

これにより `entry.size` を見たサイズ上限の分岐が不要になる。共有 URL で 2 ページ目のエントリを直接開いた場合（`size` が不明）も同じ経路で安全に扱える。

**サーバー側の展開コストは減らない。** `/preview/tar-entry` は `extractTarEntry` がエントリ全体を Buffer にしてから返すため、削減できるのはネットワーク転送とブラウザのメモリのみ。これは既存のテキストエントリでも同じで、新たな悪化ではない。

### 3. 取得と判定を担うフック（新規 `front/lib/useSniffedText.ts`）

テキストの見せ方は 3 箇所で異なる（ドロワーはコピーボタン + `max-h`、ピンカードは固定高さ `h-[280px]`、モーダルは行数表示 + `max-h-[70vh]`）。表示を 1 つに統合するとどこかが窮屈になるので、**共有するのはデータ取得と判定だけ**にする。

```ts
export type SniffedText =
  | { status: 'loading' }
  | { status: 'text'; text: string }
  | { status: 'binary' }
  | { status: 'error'; message: string }

// url は api.textPreviewUrl() か api.tarEntryUrl() の戻り値。
export function useSniffedText(url: string): SniffedText
```

これにより、既存の 3 つの表示コンポーネント（`PreviewText` / `PinnedTextBody` / `TarEntryModal.TextBody`）は、いま各自が持っている `useEffect` + `load()` + `text`/`error` state を捨ててこのフックに置き換わる。`PinnedTextBody` の `load: () => Promise<string>` prop は不要になり、代わりに url を受け取る。

あわせて「プレビュー非対応」の文言を新規 `front/components/UnsupportedPreview.tsx` に集約する（現在 3 箇所に同じ文字列が重複している）。

### 4. 呼び出し側の変更

`'text'` 種別が無くなるので、各所の `kind === 'text'` と `kind === 'unknown'` の **2 分岐が 1 本にまとまる**。

| ファイル | 変更 |
|---|---|
| `front/lib/api/mime.ts` | `PreviewKind` から `'text'` を削除。text の拡張子リストを削除 |
| `front/components/PreviewText.tsx` | `useSniffedText` を使い、`binary` なら `<UnsupportedPreview>` を返す |
| `front/components/PinnedPreviewCard.tsx` | `PinnedTextBody` を同様に。`unsupportedMessage` 定数と `unknown` 分岐を削除 |
| `front/components/TarEntryModal.tsx` | `TextBody` を同様に。`UnknownBody` を削除 |
| `front/components/PreviewDrawer.tsx` | `text` / `unknown` の 2 分岐を `<PreviewText>` 1 本に |
| `front/components/storage/EntryTable.tsx` | `isPreviewable` ゲートを撤廃し、全ファイルをピン留め可にする |
| `front/components/PreviewArchive.tsx` | tar エントリ行の `classifyEntry(...) !== 'unknown'` ゲートを撤廃 |
| `front/lib/api/client.ts` | `readHead` を追加。使われなくなる `textPreview` / `tarEntryText` を削除 |

ピン留めゲートの撤廃は必然である。スニッフしてみるまでテキストかどうか分からない以上、拡張子でメニュー項目を出し分けると「ドロワーでは開けるのにピン留めはできない」という不揃いが残る。バイナリをピン留めしたらカードに「非対応」と出るだけで実害はない。

`.json` のプリティプリントは**表示上の整形**として残す。`PinnedTextBody` / `TarEntryModal.TextBody` は既にファイル名を受け取っており、`.json` で終わるときだけ整形する。これは描画の分岐ではないので、拡張子リストの復活には当たらない。

## エラー処理

| 状況 | 挙動 |
|---|---|
| 404 / 500 | 赤字でサーバーのメッセージ（既存どおり） |
| NUL を含む | 「プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。」（既存と同じ文言） |
| 空ファイル | 空のテキストとして表示 |
| 64 KB を超えるテキスト | 先頭 64 KB のみ表示（既存のテキストプレビューと同じ挙動） |
| Shift_JIS などの非 UTF-8 | 文字化けしつつ表示（**既存と同じ**。ここが `fatal` デコードを避ける理由） |
| UTF-16 のテキスト | **「プレビュー非対応」に落ちる（退行）**。ASCII の 1 文字ごとに `\x00` が挟まるため NUL 判定に引っかかる。変更前は `.txt` が拡張子で text 判定されており、文字化けしつつも表示できていた |

利用者から見て**挙動が悪化するケースはない**。今まで「非対応」と出ていたものの一部が開くようになるだけである。**唯一の例外が UTF-16 のテキストファイル**で、上表のとおり表示できていたものが「非対応」に変わる。Shift_JIS（NUL を含まない）は今までどおり表示されるのと対照的に、UTF-16 だけは NUL 判定に引っかかってしまう。音声コーパス / ML アーティファクトというこのドメインでは UTF-16 のテキストファイルは稀であること、また NUL 混じりの文字化け表示を見せるより「非対応 + DL ボタン」で正直に落とす方が実用上はむしろ妥当であることから、この退行は許容する。

## テスト

新規:

- `front/lib/textSniff.test.ts` — NUL を含む / 含まない、npy の実ヘッダ（`\x93NUMPY\x01\x00`）、空バイト列、日本語 UTF-8、Shift_JIS 相当のバイト列（NUL なし → テキスト扱い）
- `readHead` — 64 KB で打ち切ること、`reader.cancel()` を呼ぶこと、64 KB 未満のレスポンスで `done` まで読むこと
- `useSniffedText` — loading → text / binary / error の遷移

既存テストの更新（`unknown` が「何も取りに行かない」前提のもの）:

| ファイル | 何が変わるか |
|---|---|
| `PreviewDrawer.test.tsx` | `file.xyz` が fetch するようになる（mock 追加） |
| `BottomDock.test.tsx` | 同上（カードが fetch しない前提を崩す） |
| `PinnedPreviewCard.test.tsx` | `weird.xyz` の非対応表示が非同期になる。`textPreview` mock を `readHead` に置換 |
| `PreviewText.test.tsx` | 同上 |
| `TarEntryModal.test.tsx` | `tarEntryText` mock を `readHead` に置換 |
| `PreviewArchive.test.tsx` | `blob.bin` にピン留めが出るようになる |
| `components/storage/EntryTable.pin.test.tsx` | ピン留めゲート撤廃 |

## 検証

- `README`（拡張子なし）、`.py`、`.toml` が S3 のディレクトリと tar の中の両方で開けること
- `.npy` と `.bin` が「プレビュー非対応」に落ちること
- 既存の `.txt` / `.json`（整形あり）/ 画像 / 音声 / tar の挙動が変わらないこと
- Shift_JIS の `.txt` が今までどおり文字化けしつつ表示されること（「非対応」にならないこと）
- 100 MB 級のバイナリを tar 内で開いても、DevTools の Network で転送量が 64 KB 程度に留まること
