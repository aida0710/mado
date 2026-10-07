import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/public-sans/wght.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/noto-sans-jp/japanese-400.css'
import '@fontsource/noto-sans-jp/japanese-500.css'
import '@fontsource/noto-sans-jp/japanese-700.css'
import Screenshot from './Screenshot.vue'
import Home from './Home.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Screenshot', Screenshot)
    app.component('MadoHome', Home)
  },
} satisfies Theme
