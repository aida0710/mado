# Mado 認証・Dataset Registry・OpenLineage統合設計

## 背景

Madoは複数S3互換ストレージの接続情報とブラウズ機能を持つが、現在はLAN/VPN境界を信頼し、ユーザー認証を持たない。外部公開とDataset lineageの統合に向け、次を同時に満たす必要がある。

- SSOとLocal Userによる人間の認証
- Role/permissionによる認可
- Pipeline向けService Account/API key
- Dataset、Version、保存場所、購入元、処理Runの一元表示
- OpenLineage準拠の自動lineage
- 手動リンク登録を利用者へ要求しない

2026-07-24の旧家系図はS3パス同士を人が手動で結ぶ方式であり、運用負荷を理由に撤去された。本設計ではこれを復活させず、Runのinput/outputからlineage edgeを自動生成する。

## 決定

```text
Pipeline
  │ Bearer service key
  ▼
Mado api-lineage ── internal credential ──► Dataset Registry
                                                │ canonical metadata + outbox
                                                ▼
                                           Marquez projection

Browser
  │ user session + RBAC
  ▼
Mado api-internal
  ├─ Registry: DatasetVersion / Location / Source / Run detail
  └─ Marquez: Dataset → Job → Dataset topology
          │
          ▼
     React Flow UI
```

役割を次に固定する。

- **Mado**: 認証・認可された入口、Storage接続とのbinding、統合read model、React Flow UI
- **Dataset Registry**: Dataset、Version、Location、Source、Transformation、Runの唯一の正本
- **Registry outbox worker**: OpenLineage eventをMarquezへ再送可能に投影する唯一のwriter
- **Marquez**: OpenLineage topologyとRun履歴を提供する再構築可能なprojection
- **S3等**: データ本体とimmutable manifest/evidence

MadoがRegistryとMarquezへ同時writeしてはならない。MadoはRegistryへだけwriteし、Registryが同一DB transactionでcanonical metadataとoutboxを更新する。

## 認証境界

ブラウザsessionとPipeline keyを相互利用させない。

```text
Browser  → /api/auth/*, /api/internal/*      Cookie session
Pipeline → /api/openlineage/v1/lineage       Bearer service key
```

### 人間のIdentity

- OIDCはAuthorization Code + PKCE S256 + state + nonce
- OIDC identityは`issuer + subject`で一意にする
- email一致によるLocal Userとの自動統合を行わない
- Local Userは自己登録不可。Adminが作成する
- 初期Local Adminのusernameは`admin`とし、bootstrap時に対話入力した初期passwordはArgon2id hashだけを保存する。初回ログインでは12文字以上の新passwordへ強制変更する
- SSO障害時のbreak-glass Local Adminを維持する
- session tokenはDBへSHA-256 hashだけを保存する
- passwordはArgon2idで保存する

CookieはHTTPS本番で次を必須とする。

```text
__Host-mado_session
Secure; HttpOnly; SameSite=Lax; Path=/
```

`AUTH_MODE=disabled|required`を設け、既存環境には最初に`disabled`で投入する。Admin作成とログイン確認後に`required`へ切り替える。

### RBAC

Roleは複数付与可能、permissionは和集合、未定義routeは拒否する。

| Role | 主な権限 |
|---|---|
| Viewer | Storage、Dataset、Lineage、Noteの閲覧 |
| Curator | README、Note、Tag、Dataset metadataの編集 |
| Operator | Scan、Job、料金更新、将来の転送実行 |
| Admin | Connection、Settings、User、Role、Service Account、Audit管理 |

既存connection capabilityは認可の代替ではない。

```text
allowed = user permission AND connection capability
```

### Service Account/API key

API keyは次の形式とし、secretは発行時に一度だけ表示する。

```text
mado_lin_<public-key-id>.<32-byte-random-secret>
```

DBにはsecret hashだけを保存し、scope、namespace allow-list、expiry、revoke、last-used、発行者を保持する。

OpenLineage ingestionには`lineage:write`を要求する。Job/output namespaceはallow-list必須とし、未知inputを新規作成する場合はそのnamespaceも要求する。

## DB

### Mado `021_auth.sql`

- `auth_users`
- `auth_oidc_identities`
- `auth_local_credentials`
- `auth_roles`
- `auth_permissions`
- `auth_role_permissions`
- `auth_user_roles`
- `auth_sessions`
- `auth_oidc_attempts`
- `service_accounts`
- `service_account_keys`
- `service_account_key_scopes`
- `service_account_key_namespaces`
- `audit_events`

### Mado `022_lineage_bindings.sql`

```text
lineage_storage_bindings
  registry_storage_system_key UNIQUE
  connection_id REFERENCES storage_connections
```

RegistryはS3 credentialを持たず、StorageSystem endpoint/regionとLocation URIだけを持つ。Madoのbindingから既存Storage画面へのdeep linkを生成する。

### Registry additive migration

- raw OpenLineage lifecycle eventとingestion key
- external dataset version IDとRegistry DatasetVersion UUIDのmapping
- StorageSystem
- Locationの`UNIQUE(dataset_version_id, storage_system_id, uri)`
- 双方向Version graphに必要なindex

既存volumeには初期SQL変更が自動適用されないため、additive migrationとして適用する。

## OpenLineage ingestion

```http
POST /api/openlineage/v1/lineage
Authorization: Bearer mado_lin_...
Content-Type: application/json
```

Madoはkeyとnamespace/profileを検証後、service keyを転送せず、内部principal envelopeをRegistryへ送る。

```json
{
  "event": {},
  "principal": {
    "serviceAccountId": "...",
    "keyId": "...",
    "allowedNamespaces": ["speech"]
  }
}
```

Registryはcanonical JSONのSHA-256をingestion keyにしてexact retryを無害化し、1 transactionで次を行う。

1. event dedup
2. Dataset、Version、StorageLocation、Transformation、Runのupsert
3. lifecycle event保存
4. outbox追加
5. commit

MVPのRegistry profileではDatasetVersion identityを必須とする。

- 標準`version.datasetVersion`
- またはversioned custom facetの`datasetVersionId`

identityのないinputを「最新version」と推測しない。strict endpointでは422とする。

## ID

| Entity | ID |
|---|---|
| Logical Dataset | Registry UUID + unique `(namespace,name)` |
| Marquez Dataset node | opaque `dataset:<namespace>:<name>` |
| DatasetVersion | Registry UUID |
| Run | Registry UUID = OpenLineage `runId` |
| Job | `(job_namespace,job_name)` |
| Source | Registry `source_key`; Marquezでは`external-source` Dataset |
| StorageLocation | Registry UUID。通常のlogical graphには出さない |

Marquez node IDをコロンでsplitしない。レスポンスのstructured `node.data.id.namespace/name`を使う。

## Mado read API

```http
GET /api/internal/lineage/search?q=&namespace=&types=&limit=
GET /api/internal/lineage/graph?rootKind=dataset|job&namespace=&name=&depth=3
GET /api/internal/lineage/version-graph?versionId=&direction=both&depth=3
GET /api/internal/lineage/nodes/:id
GET /api/internal/lineage/projection-status
```

backendはReact Flow形式ではなくdomain DTOを返す。

```json
{
  "nodes": [
    { "id": "opaque", "kind": "dataset", "label": "raw", "namespace": "speech" }
  ],
  "edges": [
    { "id": "edge-id", "source": "opaque", "target": "opaque", "kind": "input" }
  ],
  "projection": {
    "state": "synced",
    "pendingEvents": 0,
    "oldestPendingAt": null
  },
  "generatedAt": "...",
  "truncated": false,
  "warnings": []
}
```

logical graphはMarquez topology、Version graphと詳細はRegistryを使う。Marquez停止時もRegistry detail/version graphは利用可能にする。

## React Flow UI

上部へlazy-loaded `/lineage`タブを追加する。

- 通常表示: `Dataset → Job → Dataset`
- 「版・Runを表示」: `Source/DatasetVersion → Run → DatasetVersion`
- StorageLocationはnodeを増やさず右詳細パネルへ表示
- 左から右のDAG layout
- graphはpan/zoom/selectのみ。手動edge編集・削除を持たない
- selected node、mode、namespace、depthをURL queryへ保持する
- desktopはcanvas + 340px detail、mobileはgraph下へdetail
- 大規模graphはroot/depth/searchで絞り、truncated警告を表示する

Node kindは`source`, `dataset`, `job`, `version`, `run`。詳細パネルにversion/location/manifest/source、Git SHA、container digest、config hash、model revision、metrics、logを表示する。

## Process/Container

```text
api-internal  Browser session + RBAC、Registry/Marquez read
api-lineage   Service key Bearer、Registry ingest writeのみ
media-worker  既存
```

nginx route:

```text
/api/auth/*             → api-internal
/api/internal/*         → api-internal
/api/openlineage/*      → api-lineage
```

Mado統合後、Registry `8088`とMarquez `5000`の直接公開を止め、Mado/backendからだけ到達可能にする。

## Security

- external公開前にTLSを必須にする
- public callback URLは`PUBLIC_BASE_URL`から固定生成し、Host headerを信用しない
- Origin検査をsession導入後も維持する
- request body上限、timeout、rate limitを設ける
- audit logへAPI key、password、OIDC token、OpenLineage event本体を保存しない
- Registry/Marquez responseはallow-list DTOへ変換し、丸ごとproxyしない
- contract/license自由metadataはRoleに応じてredact可能にする

既存AuthentikはTailscale限定なので、Tailscale外ユーザーにはLocal Userを使うか、Authentik自体を安全に外部公開する必要がある。

## Migration sequence

1. `021_auth.sql`をdev/testへ適用
2. `AUTH_MODE=disabled`で認証コードを投入
3. TTYからbreak-glass Adminを作成
4. Local/OIDC login、Role、API keyを検証
5. Registry additive migrationとstrict OpenLineage ingestを投入
6. Mado logical/version graphとReact Flowを投入
7. TLSを有効化
8. `AUTH_MODE=required`へ変更
9. Mado統合後、Registry/Marquez直接公開を停止

## Test

- session expiry/revoke/rotation、user disable、local lockout
- OIDC state/nonce/PKCE、issuer/sub mapping
- RBAC matrixとconnection capabilityのAND
- API key scope/namespace/expiry/revoke、secret/payload audit redaction
- ingestion dedupとcanonical/outbox atomicity
- START→COMPLETE、terminal-only backfill、out-of-order lifecycle
- StorageSystemが異なる同一S3 URIのreplica
- merge/branchを含むupstream/downstream graph
- Marquez timeout時のRegistry fallback
- React Flow empty/loading/error/truncated、logical/version toggle、deep link
- Service key発行からMado→Registry→outbox→Marquez→Mado graphまでのE2E
