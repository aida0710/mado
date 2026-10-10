// トップページで紹介する機能と、目的別の入口。

export interface Feature {
  label: string
  title: string
  description: string
  /** public/screenshots/ の画像名 (拡張子なし)。 */
  image: string
  alt: string
  link: string
  action: string
}

export interface Entry {
  label: string
  title: string
  description: string
  link: string
}

export const features: Feature[] = [
  { label: 'Preview', title: 'ファイルの中身を見る', description: 'テキスト、画像、動画、音声をその場で確認。tarの中のファイルも個別に開けます。テキストは形式に合わせて色が付きます。', image: 'text-preview', alt: 'ファイル一覧とJSONのプレビュー', link: '/guide/preview', action: 'プレビューの使い方' },
  { label: 'Audio', title: '音声を聴き比べる', description: '波形とスペクトログラムで音声を確認。同期プレイヤーに複数の音声を並べ、同じ位置から再生できます。', image: 'audio-deck', alt: '波形と複数トラックを並べた同期プレイヤー', link: '/guide/audio', action: '音声と同期プレイヤー' },
  { label: 'Capacity', title: '容量の変化を追う', description: 'バケットの容量と件数を定期計測。ディレクトリ別の内訳や推移を見て、移送先の費用と時間を比べられます。', image: 'capacity', alt: 'バケットの容量推移とディレクトリ別の内訳', link: '/guide/capacity', action: '容量と移送の見積もり' },
  { label: 'Dataset lineage', title: 'データの来歴を辿る', description: 'どのデータから、どの処理を経て作られたか。Dataset、Job、Runをグラフで確認し、保存先へ行き来できます。', image: 'lineage', alt: '元データから処理後のデータへつながるDataset Lineageのグラフ', link: '/guide/lineage', action: 'Dataset Lineageを見る' },
  { label: 'Team note & README', title: 'データのそばに説明を残す', description: 'ディレクトリごとのREADMEと、チーム全体の共有ノート。Markdownで書いて、編集履歴から変更を確認できます。', image: 'home', alt: 'Markdownで書かれたTeam note', link: '/guide/notes', action: 'READMEとTeam note' },
]

export const entries: Entry[] = [
  { label: 'Get started', title: '初めて使う', description: 'ログインから、最初のプレビューまで', link: '/guide/getting-started' },
  { label: 'Connections', title: 'ストレージを登録する', description: 'エンドポイントと操作権限を設定', link: '/setup/connections' },
  { label: 'Reference', title: '困ったときは', description: '接続、プレビュー、権限を確認', link: '/reference/troubleshooting' },
]
