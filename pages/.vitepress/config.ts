import { defineConfig } from 'vitepress'

const repository = 'https://github.com/aida0710/mado-s3-datacatalog'
const base = '/mado-s3-datacatalog/'

export default defineConfig({
  title: 'mado S3 Data Catalog',
  titleTemplate: ':title · mado S3 Data Catalog',
  description: '複数のS3互換ストレージを横断して、ファイルの中身・容量・データの来歴を確認するWebツール。',
  lang: 'ja',
  base,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: 'https://aida0710.github.io/mado-s3-datacatalog/' },
  head: [
    ['link', { rel: 'icon', href: `${base}mado-icon.svg`, type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#151515' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'ja_JP' }],
    ['meta', { property: 'og:image', content: 'https://aida0710.github.io/mado-s3-datacatalog/screenshots/storage-directory.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  themeConfig: {
    // 名前はテーマの ProductLogo.vue で、印と太さを付けて組む。
    siteTitle: false,
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Setup', link: '/setup/install', activeMatch: '/setup/' },
      { text: 'Reference', link: '/reference/troubleshooting', activeMatch: '/reference/' },
    ],
    sidebar: [
      { text: 'はじめる', items: [
        { text: 'madoの使い方', link: '/guide/getting-started' },
        { text: 'バケットとファイルを探す', link: '/guide/storage' },
      ] },
      { text: 'ファイルの中身を見る', items: [
        { text: 'テキスト・画像・動画', link: '/guide/preview' },
        { text: 'tarの中身を開く', link: '/guide/archives' },
        { text: '音声と同期プレイヤー', link: '/guide/audio' },
      ] },
      { text: 'データを整理する', items: [
        { text: 'READMEとTeam note', link: '/guide/notes' },
        { text: '容量と移送の見積もり', link: '/guide/capacity' },
        { text: 'Dataset Lineage', link: '/guide/lineage' },
      ] },
      { text: '管理者向け', items: [
        { text: '導入と起動', link: '/setup/install' },
        { text: 'ストレージ接続の設定', link: '/setup/connections' },
        { text: '認証とアクセス権限', link: '/setup/auth' },
      ] },
      { text: 'リファレンス', items: [
        { text: 'Service AccountとAPI', link: '/reference/api' },
        { text: '困ったときは', link: '/reference/troubleshooting' },
        { text: '構成と開発', link: '/reference/development' },
      ] },
    ],
    search: {
      provider: 'local',
      options: { locales: { root: { translations: {
        button: { buttonText: '検索', buttonAriaLabel: 'ドキュメントを検索' },
        modal: { displayDetails: '詳細を表示', resetButtonTitle: '検索をクリア', backButtonTitle: '閉じる', noResultsText: '見つかりませんでした', footer: { selectText: '選択', navigateText: '移動', closeText: '閉じる' } },
      } } } },
    },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: { pattern: `${repository}/edit/main/pages/:path`, text: 'このページを編集' },
    outline: { level: [2, 3], label: 'このページの内容' },
    lastUpdated: { text: '最終更新', formatOptions: { dateStyle: 'medium' } },
    docFooter: { prev: '前のページ', next: '次のページ' },
    darkModeSwitchLabel: 'テーマ',
    sidebarMenuLabel: '目次',
    returnToTopLabel: 'ページの先頭へ',
    footer: {
      message: 'Apache License 2.0',
      copyright: 'mado S3 Data Catalog',
    },
  },
  appearance: false,
  srcExclude: ['README.md'],
})
