---
description: ディレクトリのREADMEと、チーム全体で共有するTeam noteを書く。Markdown編集と履歴。
---

# データのそばにREADMEとノートを残す

ディレクトリの説明は **S3 README**、チーム全体の連絡や置き場所の案内は **Team note** に書きます。どちらもMarkdownに対応し、編集履歴を確認できます。

## ディレクトリのREADMEを書く

Storageで対象のディレクトリを開き、READMEの **編集** を押します。まだREADMEがなければ **作成** から書けます。内容・ファイル形式・処理条件・利用上の注意などを記録してください。

<Screenshot src="/screenshots/storage-directory.png" alt="ファイル一覧の上に表示されたS3 README" caption="そのディレクトリの説明を、ファイルを開く前に読めます。" />

<Screenshot src="/screenshots/readme-edit.png" alt="ファイル一覧とMarkdownエディタを並べたREADME編集画面" caption="左側のファイルを本文へ挿入しながら、Markdownを編集できます。" />

READMEの本文はS3に書き戻します。そのため、書き込み可能な接続と、**READMEの編集** が許可された設定が必要です。

## Homeで共有ノートを書く

Homeにはmado全体でひとつの共有ノートがあります。ストレージの用途、作業手順、チーム内の連絡など、ディレクトリに属さない内容を置けます。

<Screenshot src="/screenshots/home.png" alt="接続の用途と確認手順を書いたTeam note" caption="Team noteはチーム全体で共有するメモ。本文はmadoのDBに保存します。" />

## 履歴から変更を確認する

**履歴** を押すと、編集者・編集時刻・過去の本文を確認できます。Accountで設定した署名は、編集時の名前に使われます。

<Screenshot src="/screenshots/readme-history.png" alt="READMEの編集履歴を表示した画面" caption="更新の経緯を確認したいときは履歴を開きます。" />
