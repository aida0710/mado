# metrics push サンプル

このディレクトリの `push.sh` を任意のホスト（メトリクス送信元）に配置し、
ユーザの crontab で定期実行する想定です。

## 1. インストール

```sh
scp push.sh you@example.host:~/mado-push.sh
ssh you@example.host chmod +x ~/mado-push.sh
```

## 2. 環境変数

```sh
# prod LAN 内 (10.15.0.0/16):  http://mado.lan        (nginx :80)
# prod LAN 外 (HPC ノード等):  http://<server>:81     (nginx :81、/api/external/ 専用)
# dev:                         http://mado.lan:5173   (vite dev server)
DASHBOARD_URL=http://mado.lan        # ダッシュボードのオリジン
WRITE_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxx  # `.env` の WRITE_TOKEN
```

prod の `:80` は LAN 内ホスト用 (UI と API)。Miyabi 等の **LAN 外** からは
`:81` を使う (同じ nginx の別 server ブロックで `/api/external/` のみ受ける
構成 — それ以外のパスは 404)。Bearer `WRITE_TOKEN` で防御。

## 3. 単発実行

```sh
DASHBOARD_URL=http://mado.lan \
WRITE_TOKEN=xxx \
  ./mado-push.sh example uptime -- uptime
```

成功すると `{"ok":true}` が返ります。

## 4. crontab に登録

5 分おきに `uptime`、1 時間おきに `df`:

```cron
*/5 * * * * DASHBOARD_URL=http://mado.lan WRITE_TOKEN=xxx /home/me/mado-push.sh example uptime -- uptime
0   * * * * DASHBOARD_URL=http://mado.lan WRITE_TOKEN=xxx /home/me/mado-push.sh example df     -- df -h /
```

複数のホストで動かす場合は HOST ラベルを変えて同じ要領で増やしてください。

## 注意

- `WRITE_TOKEN` は ダッシュボードを破壊できる強い権限を持ちます。crontab はパーミッション 600 で保管してください。
- スクリプトは `set -e` で動くので、`curl --fail` が non-2xx を返した場合は cron がエラー通知します（`MAILTO` を crontab で設定推奨）。
- 標準出力は最大 1 MB まで。`uptime` のような出力で 1 MB を超えるケースはまずありませんが、超えると 413 が返ります。
