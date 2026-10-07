---
description: DatasetとJob、DatasetVersionとRunをグラフで辿り、データの処理と保存先を確認する。
---

# Dataset Lineageでデータの来歴を辿る

DataLineageでは、元データ、処理、生成されたデータのつながりを見られます。メタデータの正本はDataset Registryで、OpenLineageイベントや手動登録した情報を表示します。

<Screenshot src="/screenshots/lineage.png" alt="元の音声、ノイズ除去、処理後の音声をつなぐDataset Lineage" caption="左から元データ、処理、生成されたデータへ。ノードを選ぶと詳細を開けます。" />

## カタログからデータセットを選ぶ

DataLineageを開き、カタログで名前やnamespaceを絞って対象を選びます。対象の上流・下流がグラフに表示されます。深さを変えると、辿る範囲を調整できます。

グラフはドラッグで移動でき、拡大・縮小もできます。ノードを選ぶと、登録されている説明や実行情報を右側で確認できます。

## データ全体とバージョン別のつながりを切り替える

| 表示 | 関係 |
| --- | --- |
| 論理 | Dataset → Job → Dataset。データと処理の全体像 |
| バージョン | DatasetVersion → Run → DatasetVersion。特定の生成結果と実行 |

バージョンの詳細では、内容のハッシュ、保存場所、生成したRunなど、登録された情報を確認できます。保存先がmadoの接続と紐付いていれば、Storageへ移動できます。Storage側からも、同じ保存場所に紐付くLineageを確認できます。

## 手動登録とPipelineからの送信を使い分ける

CuratorまたはAdminは、画面からデータセット・保存場所・処理履歴を登録できます。既存データを整理するときに使います。

Pipelineからの継続的な送信は、`lineage:write` のService Account keyを使います。[APIの設定](../reference/api.md)に、送信先とscopeの指定をまとめています。

Lineageの情報が未登録なら、madoが来歴を自動推測することはありません。登録状況と投影の状態を確認してください。
