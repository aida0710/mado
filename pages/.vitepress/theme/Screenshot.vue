<script setup>
import { ref } from 'vue'
import { withBase } from 'vitepress'

defineProps({
  src: { type: String, required: true },
  alt: { type: String, required: true },
  caption: { type: String, required: true },
  eager: { type: Boolean, default: false },
})

const dialog = ref(null)

function closeOnBackdrop(event) {
  if (event.target === dialog.value) dialog.value.close()
}
</script>

<template>
  <figure class="screenshot">
    <button class="screenshot-open" :aria-label="`${alt}を拡大`" @click="dialog.showModal()">
      <img :src="withBase(src)" :alt="alt" width="1440" height="1000" :loading="eager ? 'eager' : 'lazy'">
      <span class="screenshot-enlarge" aria-hidden="true">↗</span>
    </button>
    <figcaption>{{ caption }}</figcaption>
    <dialog ref="dialog" class="screenshot-dialog" :aria-label="alt" @click="closeOnBackdrop">
      <button class="screenshot-close" aria-label="画像を閉じる" @click="dialog.close()">✕</button>
      <img :src="withBase(src)" :alt="alt" width="1440" height="1000">
      <p>{{ caption }}</p>
    </dialog>
  </figure>
</template>
