# Authentik連携

MadoはOIDC Authorization Code Flow + PKCEを使います。MFA、password policy、recovery、
login flowはAuthentikを正本とし、MadoはUser、Role、browser session、操作監査を管理します。

## Authentikに登録する値

`https://mado.example`は実際のHTTPS URLへ置き換えます。

| 項目 | 値 |
|---|---|
| Redirect URI | `https://mado.example/api/auth/oidc/callback` |
| Post logout redirect URI | `https://mado.example/` |
| Front-channel logout URI | `https://mado.example/api/auth/oidc/frontchannel-logout` |
| Back-channel logout URI | `https://mado.example/api/auth/oidc/backchannel-logout` |

AuthentikではApplicationとOAuth2/OIDC Providerを作り、issuerにはapplication単位のURL
（例: `https://auth.example/application/o/mado/`）を使います。Scopeは`openid email profile`です。
`profile` scopeに`preferred_username`、`name`、`groups`を含め、emailを既存Userとの連携に
使う場合は信頼できる`email_verified` claimも返します。

Back-channel logoutを有効にすると、AuthentikでUserやsessionを無効化した時点でMadoの
server-side sessionも失効します。Madoは署名、issuer、audience、発行時刻、event、jtiを検証し、
同じlogout tokenの再利用を拒否します。

## Madoの設定例

導入時はLocal Adminを緊急経路として残すため`hybrid`を推奨します。SSOの確認後、必要なら
`oidc`へ変更します。本番ではHTTPSとSecure Cookieが必須です。

```dotenv
AUTH_MODE=hybrid
AUTH_COOKIE_SECURE=true
OIDC_ISSUER_URL=https://auth.example/application/o/mado/
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=https://mado.example/api/auth/oidc/callback
OIDC_POST_LOGOUT_REDIRECT_URI=https://mado.example/
OIDC_LABEL=Authentik
OIDC_SCOPES=openid email profile
OIDC_AUTO_LINK_VERIFIED_EMAIL=false
OIDC_ALLOWED_GROUPS=mado-users,mado-admins,mado-curators,mado-operators
OIDC_ROLE_MAPPING_JSON={"mado-admins":"admin","mado-curators":"curator","mado-operators":"operator","mado-users":"viewer"}
OIDC_DEFAULT_ROLE=viewer
```

## UserとRoleの同期規則

- 初回SSOでUserをJIT作成します。self-signup用のMado画面はありません。
- 既存Local Userへのemail自動連携は既定で無効です。有効化した場合も`email_verified=true`かつemail一致が必要で、Admin等の特権Local Userは自動連携しません。
- 未検証emailはUserのemailにも既存Userとの連携にも使いません。
- `OIDC_ALLOWED_GROUPS`は必須です。いずれかのgroupに所属しないUserを拒否し、空の設定ではMadoが起動しません。
- role mappingが設定されている場合、SSOログインのたびにMado RoleをAuthentik groupへ同期します。
- 複数groupから複数Roleを付与できます。該当groupが無い場合は`OIDC_DEFAULT_ROLE`になります。
- SSO由来の表示名と検証済みemailはログイン時に更新します。Madoの署名は上書きしません。
- Local UserのユーザーIDは連携後も維持します。JIT Userは`preferred_username`が未使用なら採用します。

Role同期を使う環境では、SSO UserのRoleをMado画面から一時的に変えても次回ログインで
Authentik側の状態へ戻ります。恒久変更はAuthentik groupで行います。

groupの判定とRoleの同期はログインのときにだけ行います。Authentik側でgroupから外しても、
Madoにログイン中のsessionは期限（`AUTH_SESSION_ABSOLUTE_SECONDS`、既定7日）まで元の権限のままです。
すぐに止めたいときは、MadoのSettings > Access > UsersでそのUserを無効にしてください。
無効にするとsessionはその場で失効します。

## Login transactionの防御

MadoはAuthorization Code Flowの`state`とPKCEに加え、OIDC開始時に短命のHttpOnly cookieを発行します。callbackは同じbrowser cookieを提示した場合だけ受理するため、別browserで開始した認証transactionや古いtransactionを流用できません。`returnTo`もMado内の相対pathだけを許可します。

Local loginとOIDC開始には、送信元IPごとの回数制限があります。Local loginとパスワード変更には、
同時に行うArgon2の処理数の制限もあります。パスワード変更の「現在のパスワード」の確認には、
User単位の回数制限（15分に10回）もあります。
上限時は`429`を返すため、reverse proxyで追加制限する場合もこの応答を維持してください。

## SSOで入れないときの切り分け

callbackで断ったときは、利用者には理由を区別せず`401`を返し、api-internalのlogに
`oidc login failed`と理由（`reason`）を残します。tokenやcodeは出しません。

| `reason` | 意味 | 直し方 |
| --- | --- | --- |
| `group_not_allowed` | `OIDC_ALLOWED_GROUPS`のどのgroupにも入っていない | Authentikでgroupに入れる |
| `user_disabled` | MadoでそのUserが無効になっている、または削除されている | 無効ならSettings > Access > Usersで有効にする。削除したUserは有効に戻せず、そのSSOのUserは今は入れ直せない（SSOとの結び付きを外す機能は無い） |
| `last_admin` | groupの同期で、最後のactiveなAdminを降格しようとした | 別のAdminを先に用意する |
| `privileged_link_required` | 検証済みemailが、特権を持つLocal Userと一致した | 乗っ取りを防ぐため自動では連携しない。連携するなら、`OIDC_AUTO_LINK_VERIFIED_EMAIL`が有効な状態で、そのLocal UserのRoleを一時的にviewerだけにしてSSOで1度入ってもらい、Roleを戻す |
| `deleted_user_email` | 検証済みemailが、削除したUserと一致した | 別のemailにするか、管理者が対応する |

これ以外の`reason`（IdPに届かない、stateが古い、開始したbrowserと違う、など）は、
IdPとの通信やbrowser側の問題です。
