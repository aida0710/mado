<!--
  製品のロゴ。アプリの front/components/shell/ProductLogo.tsx と同じ、重なった2つの窓の印と
  「mado S3 Data Catalog」(mado は通常の太さ、S3 Data Catalog は太字)。
-->
<template>
  <span class="product-logo">
    <svg class="product-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path class="product-mark-back" d="M8 2.75H21.25V16" />
      <rect class="product-mark-front" x="2.75" y="7" width="13.5" height="14.25" />
    </svg>
    <span><span class="product-prefix">mado</span> <strong>S3 Data Catalog</strong></span>
  </span>
</template>
