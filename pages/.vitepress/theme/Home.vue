<script setup lang="ts">
import { withBase } from 'vitepress'
import Screenshot from './Screenshot.vue'
import { entries, features } from './homeContent'
</script>

<template>
  <div class="mado-home">
    <section class="home-hero">
      <div class="home-hero-copy">
        <p class="home-eyebrow">S3互換ストレージのデータカタログ</p>
        <h1>S3を見て、データを辿る。</h1>
        <p class="home-lead">複数のS3互換ストレージを、ひとつの画面から。ファイルの中身、音声、容量、データの来歴を確認するWebツールです。</p>
        <div class="home-actions">
          <a class="home-button primary" :href="withBase('/guide/getting-started')">使い方を見る<span aria-hidden="true">→</span></a>
          <a class="home-button" :href="withBase('/setup/install')">導入する</a>
        </div>
      </div>
      <Screenshot src="/screenshots/storage-directory.png" alt="Storageの画面。ディレクトリのREADMEとファイル一覧" caption="接続を切り替え、バケットとディレクトリを辿る。画面は公開用サンプルデータです。" eager />
    </section>

    <nav class="home-entries" aria-label="目的から探す">
      <a v-for="entry in entries" :key="entry.link" class="home-entry" :href="withBase(entry.link)">
        <span class="home-entry-label">{{ entry.label }}</span>
        <strong>{{ entry.title }}</strong>
        <span class="home-entry-description">{{ entry.description }}</span>
        <span class="home-entry-arrow" aria-hidden="true">→</span>
      </a>
    </nav>

    <section class="home-features" aria-labelledby="features-heading">
      <h2 id="features-heading">画面で見る、madoの使い方</h2>
      <article v-for="(feature, index) in features" :key="feature.image" class="home-feature" :class="{ reverse: index % 2 === 1 }">
        <div class="home-feature-copy">
          <p class="home-eyebrow">{{ feature.label }}</p>
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
          <a :href="withBase(feature.link)">{{ feature.action }} →</a>
        </div>
        <Screenshot :src="`/screenshots/${feature.image}.png`" :alt="feature.alt" :caption="feature.alt" />
      </article>
    </section>

    <footer class="home-footer">
      <span>mado S3 Data Catalog</span>
      <a href="https://github.com/aida0710/mado">GitHub</a>
      <a href="https://github.com/aida0710/mado/blob/main/LICENSE">Apache License 2.0</a>
    </footer>
  </div>
</template>
