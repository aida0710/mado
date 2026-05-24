// ビルド時に vite.config.ts の define で実値へ置換される。define が無い環境
// (vitest など) では各 typeof ガードでフォールバックし、未定義参照を避ける。
declare const __APP_VERSION__: string
declare const __GIT_COMMIT__: string
declare const __GIT_DATE__: string

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

// 'dev' = git も env も無い環境 (dev コンテナ等)。About 側でリンクにしない判定に使う。
export const GIT_COMMIT: string =
  typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'dev'

export const GIT_DATE: string =
  typeof __GIT_DATE__ !== 'undefined' ? __GIT_DATE__ : ''

export const REPO_URL = 'https://github.com/aida0710/web-dashboard'

export const commitUrl = (hash: string): string => `${REPO_URL}/commit/${hash}`
