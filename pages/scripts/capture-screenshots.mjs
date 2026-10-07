import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { fulfillSampleApi, SAMPLE_BUCKET, SAMPLE_PREFIX } from './screenshot-fixtures.mjs'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const outputDirectory = join(projectRoot, 'pages/public/screenshots')
const captureDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date())
const artifactDirectory = join(projectRoot, 'artifacts/docs', captureDate)
const appUrl = process.env.MADO_SCREENSHOT_URL ?? 'http://127.0.0.1:15378'
const selectedScreenshots = new Set((process.env.MADO_SCREENSHOT_FILTER ?? '').split(',').filter(Boolean))
// プレビュー・容量・Settingsの小さな文字まで読める幅で、すべての画像を揃える。
const viewport = { width: 1440, height: 1000 }
const SAMPLE_RATE = 48000 // よく使う48kHzで、音声情報の読み方を示す。
const DURATION_SECONDS = 12 // 解析と再生の撮影を短時間で繰り返せる長さ。
const PEAK_COUNT = 480 // 1秒40区間で、12秒の波形を画面幅に収める。

async function prepareSampleMedia() {
  await mkdir(artifactDirectory, { recursive: true })
  const sampleCount = SAMPLE_RATE * DURATION_SECONDS
  const audio = Buffer.alloc(44 + sampleCount * 2)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(SAMPLE_RATE, 24)
  audio.writeUInt32LE(SAMPLE_RATE * 2, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(sampleCount * 2, 40)
  const peaks = []
  for (let index = 0; index < sampleCount; index++) {
    const seconds = index / SAMPLE_RATE
    const envelope = (0.08 + 0.62 * Math.abs(Math.sin(seconds * 1.7) * Math.sin(seconds * 4.1)))
    const sample = envelope * (0.7 * Math.sin(2 * Math.PI * 220 * seconds) + 0.3 * Math.sin(2 * Math.PI * 660 * seconds))
    audio.writeInt16LE(Math.round(sample * 32767), 44 + index * 2)
    const peakIndex = Math.floor(index / (sampleCount / PEAK_COUNT))
    const peak = peaks[peakIndex] ?? (peaks[peakIndex] = [0, 0])
    peak[0] = Math.min(peak[0], sample)
    peak[1] = Math.max(peak[1], sample)
  }
  const audioPath = join(artifactDirectory, 'sample.wav')
  const spectrogramPath = join(artifactDirectory, 'sample-spectrogram.png')
  const videoPath = join(artifactDirectory, 'sample.mp4')
  await writeFile(audioPath, audio)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', audioPath, '-lavfi', 'showspectrumpic=s=960x320:legend=0:color=intensity', '-frames:v', '1', spectrogramPath])
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "color=c=0xfaf9f5:s=960x540:r=24,drawgrid=w=80:h=80:t=1:c=0xddd9d0,drawtext=text='mado.':fontcolor=0x2e2c25:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2-30,drawtext=text='Sample video / 12 seconds':fontcolor=0x5e5a4f:fontsize=20:x=(w-text_w)/2:y=(h-text_h)/2+60", '-t', String(DURATION_SECONDS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath])
  return { audio, peaks, spectrogram: await readFile(spectrogramPath), video: await readFile(videoPath) }
}

const media = await prepareSampleMedia()
await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
const screenshots = []
const unhandled = []
const pageErrors = []
const directoryPath = `/storage/demo/${SAMPLE_BUCKET}/${SAMPLE_PREFIX}`
const previewPath = filename => `${directoryPath}?preview=${encodeURIComponent(SAMPLE_PREFIX + filename)}`

async function openSamplePage({ path, login = false }) {
  const context = await browser.newContext({ viewport, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce' })
  await context.route(url => url.pathname.startsWith('/api/'), route => fulfillSampleApi({ route, media, login, unhandled }))
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(new URL(path, appUrl).href)
  await page.locator('h1').filter({ visible: true }).first().waitFor()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  return page
}

async function saveScreenshot({ page, name }) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(outputDirectory, `${name}.png`), animations: 'disabled' })
  screenshots.push({ name, path: page.url(), viewport })
  console.log(`Captured ${name}`)
}

async function capturePage({ name, path, login = false, prepare }) {
  if (selectedScreenshots.size && !selectedScreenshots.has(name)) return
  const page = await openSamplePage({ path, login })
  try {
    if (prepare) await prepare(page)
    await saveScreenshot({ page, name })
  } finally {
    await page.context().close()
  }
}

async function captureAudioDeck() {
  if (selectedScreenshots.size && !selectedScreenshots.has('audio-deck')) return
  const page = await openSamplePage({ path: previewPath('original.wav') })
  try {
    // 同じ画面操作を使い、トラックごとの状態を実装から作る。
    for (const filename of ['original.wav', 'processed.wav']) {
      const row = page.locator('tr').filter({ hasText: filename })
      await row.getByRole('button', { name: 'アクション' }).click()
      await page.getByRole('menuitem', { name: 'デッキに追加' }).click()
    }
    await page.getByText(/同期プレイヤー \(2\)/).waitFor()
    await saveScreenshot({ page, name: 'audio-deck' })
  } finally {
    await page.context().close()
  }
}

try {
  await capturePage({ name: 'login', path: '/', login: true })
  await capturePage({ name: 'home', path: '/' })
  await capturePage({ name: 'connections', path: '/settings/connections' })
  await capturePage({ name: 'connection-edit', path: '/settings/connections/demo' })
  await capturePage({ name: 'connection-capabilities', path: '/settings/connections/demo', prepare: async page => {
    await page.getByText('この接続で許可する操作', { exact: true }).scrollIntoViewIfNeeded()
  } })
  await capturePage({ name: 'storage-buckets', path: '/storage/demo/' })
  await capturePage({ name: 'storage-directory', path: directoryPath })
  await capturePage({ name: 'text-preview', path: previewPath('metadata.json') })
  await capturePage({ name: 'image-preview', path: previewPath('spectrogram.png') })
  await capturePage({ name: 'pinned-preview', path: previewPath('metadata.json'), prepare: async page => {
    await page.getByRole('button', { name: 'ピン留め', exact: true }).click()
    await page.locator('tr').filter({ hasText: 'spectrogram.png' }).click()
  } })
  await capturePage({ name: 'video-preview', path: previewPath('sample.mp4'), prepare: async page => {
    await page.locator('video').evaluate(async video => { await video.play(); video.pause() })
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
  } })
  await capturePage({ name: 'audio-preview', path: previewPath('original.wav'), prepare: async page => {
    await page.getByAltText('スペクトログラム').waitFor()
  } })
  await capturePage({ name: 'tar-list', path: previewPath('dataset-00001.tar') })
  await capturePage({ name: 'tar-entry', path: `${previewPath('dataset-00001.tar')}&entry=sample-001.json` })
  await capturePage({ name: 'capacity', path: '/storage/demo/?view=capacity', prepare: async page => {
    await page.locator('.recharts-line-curve').first().waitFor()
  } })
  await capturePage({ name: 'lineage', path: '/lineage?mode=logical&namespace=sample-audio&name=raw-audio&depth=3', prepare: async page => {
    await page.locator('.react-flow__node').first().waitFor()
  } })
  await capturePage({ name: 'access-users', path: '/settings/access/users' })
  await capturePage({ name: 'service-accounts', path: '/settings/access/service-accounts' })
  await capturePage({ name: 'readme-edit', path: `/storage/demo/edit-readme/${SAMPLE_BUCKET}/${SAMPLE_PREFIX}`, prepare: async page => {
    await page.locator('.monaco-editor').first().waitFor()
  } })
  await capturePage({ name: 'readme-history', path: directoryPath, prepare: async page => {
    await page.getByRole('button', { name: /履歴/ }).first().click()
    await page.getByText('Sample team', { exact: true }).last().waitFor()
  } })
  await capturePage({ name: 'scan', path: directoryPath, prepare: async page => {
    await page.getByRole('button', { name: '内訳', exact: true }).click()
    await page.getByText('12,408', { exact: true }).first().waitFor()
  } })
  await capturePage({ name: 'estimate', path: directoryPath, prepare: async page => {
    await page.getByRole('button', { name: '内訳', exact: true }).click()
    await page.getByRole('tab', { name: '移送の見積もり' }).click()
    await page.getByRole('button', { name: /Archive storage/ }).click()
  } })

  await captureAudioDeck()
} finally {
  await browser.close()
  await writeFile(join(artifactDirectory, 'screenshot-manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), screenshots, unhandled, pageErrors }, null, 2))
}

if (unhandled.length || pageErrors.length) {
  console.error({ unhandled, pageErrors })
  process.exitCode = 1
}
