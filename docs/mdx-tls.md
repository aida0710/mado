# MDXのTLS edge

`compose.mdx.yaml`の`edge` serviceがhost network上の`:80` / `:443`をlistenし、
TLSを終端してapplication nginxの`127.0.0.1:8080`へ転送します。Apacheは使いません。
OpenLineage専用`127.0.0.1:8081`はこのbrowser hostnameへ載せず、外部公開時に別hostnameで扱います。

## 前提

- `MADO_HOSTNAME`のA/AAAA recordがMDX VMへ到達すること
- hostの`/etc/letsencrypt/live/$MADO_HOSTNAME/`に証明書があること
- ACME webrootがhostの`/var/www/letsencrypt`であること
- UFWは外部から`80/tcp`（ACMEとredirect）と鍵認証SSHだけを許可し、`443/tcp`はintranetと明示した固定送信元だけに許可すること

MDXでは次のhost firewallを基準にします。`edge`はhost networkを使うため、DockerのDNATでUFWを迂回しません。

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw default deny routed
sudo ufw limit 22/tcp comment 'SSH public key only'
sudo ufw allow 80/tcp comment 'ACME HTTP-01 and HTTPS redirect'
sudo ufw allow in on ens160 from 10.15.0.0/16 comment 'MDX service network'
sudo ufw allow in on ens192 from 10.143.0.0/16 comment 'MDX secondary network'
sudo ufw allow in on ens192 from 172.17.8.0/24 comment 'MDX routed internal network'
sudo ufw allow from 163.220.179.117 to any port 443 proto tcp comment 'Mado HTTPS allowlist'
sudo ufw --force enable
```

UFWと`nginx/edge.conf.template`の両方で同じ送信元を許可します。片方だけを変更すると、
UFWを通過してもnginxが`403 Forbidden`を返します。

## 初回証明書

HTTP-01 challengeを一時的なweb serverまたは既存edgeで公開してから取得します。

```bash
sudo certbot certonly \
  --webroot --webroot-path /var/www/letsencrypt \
  --domain "$MADO_HOSTNAME"
```

`.env`はHTTPS originとSecure cookieへ切り替えます。

```dotenv
MADO_HOSTNAME=mado.internal.example
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
sudo ufw status verbose
systemctl status certbot.timer
```

期待値はHTTPS 200、HTTP 308、HSTSありです。intranetと明示した固定送信元以外からのHTTPSは拒否し、
`/.well-known/acme-challenge/`以外のHTTP本文を配信しません。
