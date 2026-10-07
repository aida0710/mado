<script setup>
import { withBase } from 'vitepress'
import Screenshot from './Screenshot.vue'

const features = [
  {
    number: '01',
    title: 'ファイルの中身を見る',
    label: 'Preview',
    description: 'テキスト、画像、動画、音声をその場で確認。tarの中にあるファイルも個別に開けます。プレビューをピン留めして、別のファイルと並べることもできます。',
    image: 'text-preview',
    alt: 'S3のファイル一覧とJSONのプレビュー',
    caption: '一覧を見ながら、右側でファイルの中身を確認。',
    link: '/guide/preview',
    action: 'プレビューの使い方',
  },
  {
    number: '02',
    title: '音声を聴き比べる',
    label: 'Audio',
    description: '波形とスペクトログラムで音声を確認。同期プレイヤーに複数の音声を並べ、同じ位置から再生できます。',
    image: 'audio-deck',
    alt: '波形と複数トラックを並べた同期プレイヤー',
    caption: '元の音声と処理後の音声を、同じ位置で聴き比べる。',
    link: '/guide/audio',
    action: '音声と同期プレイヤー',
  },
  {
    number: '03',
    title: '容量の変化を追う',
    label: 'Capacity',
    description: '接続内のバケットの容量と件数を定期計測。ディレクトリ別の内訳や推移を見て、移送先の費用と時間を比較できます。',
    image: 'capacity',
    alt: 'バケットの容量推移とディレクトリ別の内訳',
    caption: 'バケットごとの推移と、容量を占めるディレクトリ。',
    link: '/guide/capacity',
    action: '容量と移送の見積もり',
  },
  {
    number: '04',
    title: 'データの来歴を辿る',
    label: 'Dataset lineage',
    description: 'どのデータから、どの処理を経て作られたか。Dataset、Job、バージョン、Runをグラフで確認し、保存先のS3へ行き来できます。',
    image: 'lineage',
    alt: '元データから処理後のデータへつながるDataset Lineageのグラフ',
    caption: 'データと処理のつながりを、一枚のグラフで。',
    link: '/guide/lineage',
    action: 'Dataset Lineageを見る',
  },
]
</script>

<template>
  <div class="mado-home">
    <section class="home-intro">
      <p class="eyebrow">S3 browser &amp; dataset lineage</p>
      <h1>mado<span>.</span></h1>
      <h2>S3を見て、データを辿る。</h2>
      <p class="home-lead">複数のS3互換ストレージを、ひとつの画面から。<br>ファイルの中身、音声、容量、データの来歴を確認するWebツールです。</p>
      <div class="home-actions">
        <a class="home-button primary" :href="withBase('/guide/getting-started')">使い方を見る <span>→</span></a>
        <a class="home-button" :href="withBase('/setup/install')">導入する <span>↗</span></a>
      </div>
    </section>

    <section class="home-overview" aria-label="Storageの画面">
      <div class="figure-heading"><span class="eyebrow">Storage</span><span>S3互換ストレージを横断して閲覧</span></div>
      <Screenshot src="/screenshots/storage-directory.png" alt="madoのStorage画面。ディレクトリのREADMEとファイル一覧" caption="接続を切り替え、バケットとディレクトリを辿る。画面は公開用サンプルデータです。" eager />
    </section>

    <nav class="home-start" aria-label="目的から探す">
      <a :href="withBase('/guide/getting-started')"><span class="eyebrow">Get started</span><strong>初めて使う</strong><span>ログインから、最初のプレビューまで <b>→</b></span></a>
      <a :href="withBase('/setup/connections')"><span class="eyebrow">Connections</span><strong>ストレージを登録する</strong><span>エンドポイントと操作権限を設定 <b>→</b></span></a>
      <a :href="withBase('/reference/troubleshooting')"><span class="eyebrow">Reference</span><strong>困ったときは</strong><span>接続、プレビュー、権限を確認 <b>→</b></span></a>
    </nav>

    <section class="home-features" aria-labelledby="features-heading">
      <header class="home-section-heading"><span class="eyebrow">A closer look</span><h2 id="features-heading">画面で見る、madoの使い方</h2></header>
      <article v-for="feature in features" :key="feature.number" class="home-feature">
        <div class="home-feature-copy">
          <p class="eyebrow"><span class="feature-number">{{ feature.number }}</span>{{ feature.label }}</p>
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
          <a :href="withBase(feature.link)">{{ feature.action }} <span>→</span></a>
        </div>
        <Screenshot :src="`/screenshots/${feature.image}.png`" :alt="feature.alt" :caption="feature.caption" />
      </article>
    </section>

    <section class="home-note">
      <div><p class="eyebrow">Team note &amp; README</p><h2>データのそばに、説明を残す。</h2><p>ディレクトリごとのREADMEと、チーム全体の共有ノート。<br>Markdownで書いて、編集履歴から変更を確認できます。</p><a :href="withBase('/guide/notes')">READMEとTeam note <span>→</span></a></div>
      <Screenshot src="/screenshots/home.png" alt="Markdownで書かれたTeam note" caption="Homeは、チームでひとつの共有ノート。" />
    </section>

    <footer class="home-footer"><span>mado documentation</span><a href="https://github.com/aida0710/mado">GitHub ↗</a><a href="https://github.com/aida0710/mado/blob/main/LICENSE">Apache License 2.0</a><a href="https://icons8.com/icon/set/window/external-others-inmotus-design">Icon: Inmotus Design / Icons8</a></footer>
  </div>
</template>
