import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }

// シェルを介さない execFile で git を呼ぶ (引数は固定リテラルのみ・注入余地なし)。
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

// バージョン / コミットをビルドへ焼き込む。優先順位:
//   1. 環境変数 (Docker prod は deploy.sh → build arg 経由で渡す)
//   2. git (ホストで直接ビルドする場合)
//   3. 'dev' / '' (git も env も無い dev コンテナ等)
const commit = process.env.VITE_GIT_COMMIT?.trim() || git(['rev-parse', '--short', 'HEAD']) || 'dev'
const commitDate = process.env.VITE_GIT_DATE?.trim() || git(['log', '-1', '--format=%cI']) || ''

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(commit),
    __GIT_DATE__: JSON.stringify(commitDate),
  },
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    proxy: {
      '/api/internal': 'http://api-internal:3000',
    },
  },
})
