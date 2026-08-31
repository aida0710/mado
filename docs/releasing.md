# OSS release手順

MadoのOSS releaseと社内・private環境へのdeployは別工程である。release workflowはGitHubとGHCRだけを操作し、MDXを含むdeployment hostへ接続しない。

## 成果物

tagが指す同一commitから、Linux amd64/arm64対応のOCI imageを3つ作る。

- `mado-api`: compiled internal APIとOpenLineage API
- `mado-media-worker`: compiled workerとffmpeg
- `mado-web`: static Web UIと用途別nginx listener

workflowは各imageへSBOMとprovenanceを付け、digest固定の`compose.yaml`、全migration、設定例、licenseをrelease bundleへ収録する。GitHub Release本文は`docs/releases/<tag>.md`が正本。

## 公開条件

1. tag作成helperの実行時点で`main`がcleanかつ`origin/main`と同じcommitである。workflow再実行時は、そのtag commitが`main`の履歴上に残っていることを確認する。
2. そのcommitに対するCI全体が成功している。
3. `VERSION`、API/Frontのpackage・lock version、tagが一致する。
4. `docs/releases/<tag>.md`が存在する。
5. release contract、全test、production build、OCI image buildが成功する。

準備状況だけを確認する場合:

```bash
scripts/release/publish.sh --verify-only v1.0.0
```

実際に公開するときだけ、次を実行する。annotated tagをoriginへpushした時点でrelease workflowが開始する。

```bash
scripts/release/publish.sh v1.0.0
```

scriptは既存tagを移動・削除せず、dirty tree、remote mainとの差、同一SHAの成功CI不足を拒否する。workflowはまずtagとcommitで一意なstaging imageをbuildし、匿名でdigest pullできること、bundle、checksum、artifact attestationを検証してからversion tagへ昇格し、GitHub Releaseを最後に公開する。GHCRの3 package間にtransactionはないため、tag昇格途中の失敗は同じworkflowを再実行してroll-forwardする。再実行時は既存のimmutable staging digestを再buildせず再利用するため、artifact保持期限を過ぎてもpartial promotionを同じdigest群で再開できる。既存version tagが同じdigestなら再利用し、異なるdigestなら停止する。staging tagとversion tagは書き換えない。

手動で再開する場合は、workflow自体のrefも同じrelease tagへ固定する。`main`を選んだworkflow dispatchはsource provenanceが一致しないため拒否される。

```bash
gh workflow run release.yml --ref v1.0.0 -f tag=v1.0.0
```

再開時はGHCRをHTTP 404まで確認できた場合だけ新規buildへ進む。新規imageはまずtagなしdigestとしてpushし、attestation作成後にだけstaging tagを付けるため、build成功・attestation失敗でも再実行を妨げる未検証staging tagは残らない。既存staging digestはrelease workflow、release tag ref、source commitを指定してattestation検証し、検証済みdigestだけを再利用する。version tagの存在確認も200/404以外はfail-closeする。

bundleの真正性は次で確認できる。

```bash
gh attestation verify mado-v1.0.0.tar.gz --repo aida0710/mado
sha256sum -c mado-v1.0.0.tar.gz.sha256
```

## Repository設定

- `main`を保護し、CIをrequired checkにする。
- tag `v*`の作成・削除権限をrelease担当者へ限定する。
- GitHub environment `release`へrequired reviewerを設定する。
- GitHubのImmutable Releasesを有効にする。
- `mado-api`、`mado-media-worker`、`mado-web`のGHCR packageをpublicにする。workflowも公開直前に匿名digest pullを検証する。

これらはrepository側の管理設定であり、workflow追加だけでは自動的に有効にならない。
