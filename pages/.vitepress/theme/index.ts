import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import '@fontsource/noto-sans-jp/japanese-400.css'
import '@fontsource/noto-sans-jp/japanese-500.css'
import '@fontsource/noto-sans-jp/japanese-700.css'
import '@mado/design-system/fonts.css'
import '@mado/design-system/tokens.css'
import Screenshot from './Screenshot.vue'
import Home from './Home.vue'
import ProductLogo from './ProductLogo.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  // 上部バーの名前は、アプリと同じ窓の印と「mado S3 Data Catalog」で組む (config の siteTitle は false)。
  Layout: () => h(DefaultTheme.Layout, null, { 'nav-bar-title-before': () => h(ProductLogo) }),
  enhanceApp({ app }) {
    app.component('Screenshot', Screenshot)
    app.component('MadoHome', Home)
  },
} satisfies Theme
