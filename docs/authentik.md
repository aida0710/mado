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

## Login transactionの防御

MadoはAuthorization Code Flowの`state`とPKCEに加え、OIDC開始時に短命のHttpOnly cookieを発行します。callbackは同じbrowser cookieを提示した場合だけ受理するため、別browserで開始した認証transactionや古いtransactionを流用できません。`returnTo`もMado内の相対pathだけを許可します。

Local loginとOIDC開始には送信元・identifier・同時Argon2処理数の制限があります。上限時は`429`を返すため、reverse proxyで追加制限する場合もこの応答を維持してください。
