# MDXのTLS edge

`compose.mdx.yaml`の`edge` serviceがhost network上の`:80` / `:443`をlistenし、
TLSを終端します。Browser hostnameはapplication nginxの`127.0.0.1:8080`へ、
公開API hostnameはOpenLineage専用`127.0.0.1:8081`へ転送します。Apacheは使いません。

## 前提

- `MADO_HOSTNAME`がMDX private IPv4へ到達すること
- `MADO_API_HOSTNAME`のpublic A recordがMDX global IPv4へ到達すること
- hostの`/etc/letsencrypt/live/$MADO_HOSTNAME/`と`/etc/letsencrypt/live/$MADO_API_HOSTNAME/`に証明書があること
- ACME webrootがhostの`/var/www/letsencrypt`であること
- UFWは外部から`80/tcp`（ACMEとredirect）、`443/tcp`（公開OpenLineage API）、鍵認証SSHを許可すること
- Browser hostnameはUFWではなくTLS edgeのCIDR ACLでintranetだけに限定すること。UFWはSNI/Hostを判別できない

MDXでは次のhost firewallを基準にします。`edge`はhost networkを使うため、DockerのDNATでUFWを迂回しません。

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw default deny routed
sudo ufw limit 22/tcp comment 'SSH public key only'
sudo ufw allow 80/tcp comment 'ACME HTTP-01 and HTTPS redirect'
sudo ufw allow proto tcp from 0.0.0.0/0 to any port 443 comment 'Public Mado OpenLineage API'
sudo ufw allow in on ens160 from 10.15.0.0/16 comment 'MDX service network'
sudo ufw allow in on ens192 from 10.143.0.0/16 comment 'MDX secondary network'
sudo ufw allow in on ens192 from 172.17.8.0/24 comment 'MDX routed internal network'
sudo ufw allow from 163.220.179.117 to any port 443 proto tcp comment 'Mado HTTPS allowlist'
sudo ufw --force enable
```

`:443`自体は公開APIのためInternetへ開きます。`nginx/edge.conf.template`はSNI/Hostで分離し、
Browser hostnameだけへCIDR ACLを適用します。公開API hostnameは完全一致する
`POST /api/openlineage/v1/lineage`だけをloopbackの専用listenerへ転送します。
AAAA recordを公開していない場合は、UFWのIPv6 `443/tcp`を開けません。

## 初回証明書

HTTP-01 challengeを一時的なweb serverまたは既存edgeで公開してから取得します。

```bash
sudo certbot certonly \
  --webroot --webroot-path /var/www/letsencrypt \
  --domain "$MADO_API_HOSTNAME"
```

Browser hostnameをpublic DNSでprivate IPv4へ向ける場合、Let's EncryptのHTTP-01 validatorは
到達できないため、その証明書はDNS-01へ切り替えます。既存HTTP-01証明書をそのままにすると、
有効期限前の自動更新に失敗します。公開API hostnameはpublic IPv4へ向くためHTTP-01を利用できます。

`.env`はHTTPS originとSecure cookieへ切り替えます。

```dotenv
MADO_HOSTNAME=mado.internal.example
MADO_API_HOSTNAME=mado-api.internal.example
ALLOWED_ORIGINS=https://mado.internal.example
AUTH_COOKIE_SECURE=true
```

## 起動と更新hook

```bash
docker compose -f compose.mdx.yaml up -d edge
sudo ln -sfn \
  "$PWD/scripts/certbot-deploy-hook.sh" \
  /etc/letsencrypt/renewal-hooks/deploy/mado-edge
sudo certbot renew --dry-run
```

deploy hookは更新後にedgeの設定を検証し、成功時だけnginxをreloadします。

## 確認

```bash
docker compose -f compose.mdx.yaml ps edge
docker compose -f compose.mdx.yaml exec -T edge nginx -t
curl -I "https://$MADO_HOSTNAME/"
curl -I "http://$MADO_HOSTNAME/"
curl -I "https://$MADO_API_HOSTNAME/"
curl -X POST "https://$MADO_API_HOSTNAME/api/openlineage/v1/lineage"
sudo ufw status verbose
systemctl status certbot.timer
```

Browser hostnameはHTTPS 200、HTTP 308、HSTSありです。公開API hostnameは対象POSTが
Service Account keyなしで401、その他のpath/methodが404、HTTPは同じhostnameのHTTPSへ308です。
未知Hostは421とし、`/.well-known/acme-challenge/`以外のHTTP本文を配信しません。
