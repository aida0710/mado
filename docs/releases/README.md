# Release notes

GitHub Release本文の正本を`docs/releases/<tag>.md`としてversion controlする。
tagをpushするとrelease workflowが同名fileを必須検査し、生成文ではなくこの本文を使う。

- 見出しにversionを重ねない（GitHub Release titleがversionを示す）。
- 利用者に影響する変更、互換性、migration、security、upgrade手順を書く。
- 未公開版のfileを置くこと自体はreleaseではない。tag pushだけが公開を開始する。
