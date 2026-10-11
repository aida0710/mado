---
description: Local UserとOIDC SSO、組み込みロール、接続のホワイトリスト、ユーザーの無効化。
---

# 認証とアクセス権限を設定する

madoはLocal UserとOIDC SSOに対応しています。ユーザーの役割を決めるRBACと、接続ごとの操作制限・ホワイトリストを組み合わせて使います。

## Local UserとSSOを選ぶ

| `AUTH_MODE` | ログイン方法 |
| --- | --- |
| `local` | 管理者が作成したLocal User |
| `oidc` | OIDC SSO |
| `hybrid` | Local UserとOIDC SSO |

Local Userの自己登録はありません。初期Adminは[導入手順](./install.md#初期adminを作成する)のコマンドで作成します。

SSOではissuer、client ID、client secret、redirect URIを設定します。Authentikを使う場合の登録値、groupとroleの対応、logout設定は[OIDC連携の手順](https://github.com/aida0710/mado-s3-datacatalog/blob/main/docs/authentik.md)を参照してください。

## ロールを割り当てる

**Settings → Access → Users** でユーザーを管理します。

<Screenshot src="/screenshots/access-users.png" alt="AdminとViewerを登録したユーザー管理画面" caption="ユーザーの追加、ロールの変更、無効化はAccessから行います。" />

| ロール | 主な権限 |
| --- | --- |
| Viewer | StorageとLineageの閲覧 |
| Curator | 閲覧、README・ノートの編集、Lineageの登録・修正 |
| Operator | 閲覧、ジョブの操作 |
| Admin | 接続・設定・ユーザー・Service Accountの管理、監査ログの閲覧を含む全権限 |

複数のロールを付けた場合は、それぞれの権限を合わせて使えます。接続側で禁止した操作や、ユーザーに見せない接続へのアクセスは、別途制限されます。

## SSOの利用停止はmado側の状態も確認する

SSOのgroupから外しても、既存のmadoセッションが直ちに失効するとは限りません。すぐに利用を止める場合は、mado側のUserを無効化してください。

運用環境ではHTTPSを使い、`AUTH_COOKIE_SECURE=true` にします。認証無効モードは既存の開発・LAN環境向けで、本番モードでは起動できません。

## PipelineにはService Accountを使う

人のブラウザセッションと、PipelineやPrometheusの認証を分けます。Service Account keyはscopeごとに発行し、[APIの手順](../reference/api.md)に従って利用してください。
