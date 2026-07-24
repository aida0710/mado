# データの家系図（親子リンク・家系図ビュー）

## 背景

ストレージ上のデータは、処理が進むごとに「どのディレクトリ/ファイルが、どこから加工されて生まれたか」という親子関係が深くなっていく。数ステップ進むと、この関係は人の記憶からも README の断片的な記述からも追いきれなくなる。

現状のダッシュボードは bucket / prefix / key の**階層構造**（S3 のパス構造）しか表現できない。しかし加工結果は元データの配下に置かれるとは限らず、むしろ全く別の bucket・別の prefix に置かれるのが普通である。パスの入れ子関係と、データの由来（リネージ）関係は別物であり、後者を表現する手段が存在しない。

そこで、bucket・directory・file を「ノード」として、任意の2ノード間に「親→子」の**登録制リンク**を張れるようにし、インタラクティブに辿れる家系図ビューを追加する。

## 目的

- bucket / directory / file を問わず、任意のノード同士に手動で親子リンクを登録できる
- 1ノードが複数の親・複数の子を持てる（マージ・分岐する実際の加工パイプラインに追従できる DAG）
- リンクは同一 connection 内であれば bucket をまたいでよい
- ノードをクリックすると小さいポップアップで中身（README冒頭 / ファイルプレビュー）を確認でき、そのパスへ移動もできる
- 登録数が増えても破綻しないよう、「全て」「バケット単位」「現在地」の3段階の表示スコープを用意する
- README / お気に入りバケットと同じ「LAN 共有・認証なし」の運用モデルを踏襲する

## 非目標

- リンクの自動検出・自動推論（命名規則・メタデータからの自動リンク付け）。v1 は完全手動登録のみ
- 異なる connection をまたぐリンク
- エッジ（リンク）自体への注釈・メモ機能
- 任意の2ノードを自由に結べる汎用グラフエディタ。リンク追加は常に「今見ているノード」を起点に、その親または子を1つ選んで追加する形に限定する
- サイクル（A→B→A）の登録を防ぐバリデーション。通常の処理フローでは発生しない想定であり、検知・防止のための複雑な仕組みは作らない（ただし後述のとおりトラバーサル側では無限ループを防ぐ）

## データモデル

ノードそのものはテーブルを持たない。`(bucket, path)` の組がそのままノードの識別子であり、`path` の形から種別を導出する（`storage-list.ts` にある既存の規約を踏襲）。

- `path === ''` → bucket ルート
- `path` が `/` で終わる → directory
- それ以外 → file（S3 key）

エッジ（親子リンク）だけを1テーブルで持つ。

```sql
CREATE TABLE storage_lineage_links (
  id            BIGSERIAL   PRIMARY KEY,
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  parent_bucket TEXT        NOT NULL,
  parent_path   TEXT        NOT NULL,
  child_bucket  TEXT        NOT NULL,
  child_path    TEXT        NOT NULL,
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((parent_bucket, parent_path) IS DISTINCT FROM (child_bucket, child_path)),
  UNIQUE (connection_id, parent_bucket, parent_path, child_bucket, child_path)
);

CREATE INDEX storage_lineage_links_conn_idx   ON storage_lineage_links (connection_id);
CREATE INDEX storage_lineage_links_parent_idx ON storage_lineage_links (connection_id, parent_bucket, parent_path);
CREATE INDEX storage_lineage_links_child_idx  ON storage_lineage_links (connection_id, child_bucket, child_path);

ALTER TABLE    storage_lineage_links         OWNER TO dashboard_rw;
ALTER SEQUENCE storage_lineage_links_id_seq  OWNER TO dashboard_rw;
GRANT SELECT ON storage_lineage_links TO dashboard_ro;
```

`created_by` は README / notes の `editor` と同じ、認証なしの自己申告名テキストである。

## API 設計

`api/routes/storage-lineage.ts` を新設し、`storage-favorites.ts`（LAN 共有・認証なし・防御は LAN 境界に委ねる、という既存の契約）と同じ形で実装する。

- `GET /storage/:connId/lineage-links`
  その connection に登録された**全エッジ**をそのまま返す。表示スコープ（全て/バケット単位/現在地）の絞り込みはクライアント側で行うため、サーバー側では絞り込まない。LAN チーム規模の利用を想定すれば全件取得しても軽量。

  ```json
  [{ "id": 1, "parentBucket": "raw", "parentPath": "2024-01/", "childBucket": "clean", "childPath": "v2/", "createdBy": "aida", "createdAt": "..." }]
  ```

- `POST /storage/:connId/lineage-links`
  body: `{ parentBucket, parentPath, childBucket, childPath, editor }`
  `INSERT ... ON CONFLICT DO NOTHING` で重複登録を無害化。`parent === child` はハンドラ側で 400 を返す（DB の `CHECK` はバックストップ）。

- `DELETE /storage/:connId/lineage-links/:id`
  id 指定で1エッジ削除。

## UI 設計

### エントリポイント

`StorageBucket` 画面（一覧表示）に「一覧 / 家系図」の切り替えタブを追加する。選択状態は `?view=lineage` という query param で表現し、既存の `?preview=` と同じ「URL 駆動・深リンク可能・戻る/進むが自然に効く」パターンに合わせる。選択すると、専用タブとして画面いっぱいにグラフ表示へ切り替わる。

### 表示スコープ（3段階）

- **全て** — その connection に登録された全ノード・全エッジをそのまま描画する
- **バケット単位** — `parent_bucket` / `child_bucket` のみを見てバケット同士のノードに集約する（directory / file の詳細は畳む。bucket 内で閉じたリンクは表示しない）
- **現在地** — 今見ているノードを起点に、登録済みリンクを辿れるだけ辿った**祖先・子孫の全体**（DAG のトラバーサル。1階層に限らない）を表示する

「現在地」はパスの入れ子（「今いるディレクトリの配下にあるパス」）ではなく、**登録されたリンクを辿った到達可能ノード全体**と定義する。加工結果は元データの配下ではなく別ディレクトリ・別バケットに置かれるのが普通であり、パスの入れ子で絞り込むと肝心のリンクが表示されなくなるため。

デフォルトのスコープは「現在地」とする（最も軽量で、今いる場所に関係あるものだけが出る）。

### ノード表示

bucket（📦）/ directory（📁）/ file（📄）をアイコンで区別する。ノードをクリックすると小さいポップアップが開き、以下を表示する。

- bucket / directory ノード: そのパスの README 冒頭（`storage_readme_meta` / README 取得 API を流用）
- file ノード: 既存の `PreviewText` / `PreviewImage` 等のスニッフ済みプレビューを縮小埋め込み
- 「このパスへ移動」（`StorageBucket` へ遷移し、家系図ビューは閉じる）
- そのノードの**直接の親・直接の子**を小さなリストで列挙し、行ごとに「解除」ボタンを置く

最後の項目は「現在地」モードのような単一の中心ノードを前提にしない。「全て」「バケット単位」モードにはグラフ全体の中心が存在せず、ノードをクリックしただけでは「どのエッジを解除したいか」が一意に決まらないため、常に**クリックしたノード自身が当事者になっているエッジの一覧**として表現する。これはどの表示スコープでも同じ形で成立する。

### リンク追加

家系図ビューに「＋ リンクを追加」ボタンを置く。フローは以下の通り。

1. 「親を追加」/「子を追加」を選ぶ
2. `StorageBrowser` をモーダルで開き、対象の bucket / directory / file を選ぶピッカーを表示する（自分自身は選択不可）
3. 編集者名を入力する（README / notes と同じ名前欄慣習）
4. 保存すると `POST /storage/:connId/lineage-links` を呼び、グラフを即座に更新する

## エラー処理

- リンク先のパスが後でストレージから削除されていても、`storage_lineage_links` の行自体は残す。グラフ上は該当ノードをグレーアウトし、README / プレビューの取得が失敗しても握りつぶして「見つかりません」と表示する。「このパスへ移動」は無効化する
- 循環（A→B→A）は登録時にブロックしない。ただし「現在地」モードの祖先/子孫トラバーサルは訪問済みセットを持ち、循環があっても無限ループしないようにする
- 自己参照（親 = 子）は DB の `CHECK` 制約でブロックし、API ハンドラでも 400 を返す。ピッカーでも自分自身は選択肢から除外する
- 重複登録は `UNIQUE` 制約 + `ON CONFLICT DO NOTHING` で無害化する（エラーにしない）
- connection 削除時は `ON DELETE CASCADE` でリンクも自動的に削除される

## テスト方針

- `api/routes/storage-lineage.test.ts` — 既存 `storage-favorites.test.ts` と同型で GET / POST（重複・自己参照） / DELETE を検証する
- 祖先/子孫トラバーサルは純関数として `front/lib` に切り出し、循環を含むデータでの単体テストを書く（無限ループしないことを確認する）
- `LineageView`（新規コンポーネント）のスコープ切り替え・ポップアップ開閉をコンポーネントテストで検証する（既存 `StorageBrowser.test.tsx` の流儀に合わせる）
