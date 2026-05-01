# metrics push サンプル

このディレクトリの `push.sh` を任意のホスト（メトリクス送信元）に配置し、
ユーザの crontab で定期実行する想定です。

## 1. インストール

```sh
scp push.sh you@example.host:~/dashboard-push.sh
ssh you@example.host chmod +x ~/dashboard-push.sh
```

## 2. 環境変数

```sh
DASHBOARD_URL=http://dashboard.lan:3000   # ダッシュボードのオリジン
WRITE_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxx  # `.env` の WRITE_TOKEN
```

## 3. 単発実行

```sh
DASHBOARD_URL=http://dashboard.lan:3000 \
WRITE_TOKEN=xxx \
  ./dashboard-push.sh example uptime -- uptime
```

成功すると `{"ok":true}` が返ります。

## 4. crontab に登録

5 分おきに `uptime`、1 時間おきに `df`:

```cron
*/5 * * * * DASHBOARD_URL=http://dashboard.lan:3000 WRITE_TOKEN=xxx /home/me/dashboard-push.sh example uptime -- uptime
0   * * * * DASHBOARD_URL=http://dashboard.lan:3000 WRITE_TOKEN=xxx /home/me/dashboard-push.sh example df     -- df -h /
```

複数のホストで動かす場合は HOST ラベルを変えて同じ要領で増やしてください。

## 注意

- `WRITE_TOKEN` は ダッシュボードを破壊できる強い権限を持ちます。crontab はパーミッション 600 で保管してください。
- スクリプトは `set -e` で動くので、`curl --fail` が non-2xx を返した場合は cron がエラー通知します（`MAILTO` を crontab で設定推奨）。
- 標準出力は最大 1 MB まで。`uptime` のような出力で 1 MB を超えるケースはまずありませんが、超えると 413 が返ります。
