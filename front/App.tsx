import { lazy, Suspense, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import HomePage from './pages/HomePage'
import StoragePage from './pages/StoragePage'
import StorageLanding from './pages/StorageLanding'
import SettingsPage from './pages/SettingsPage'
import { PlayerDeckProvider, usePlayerDeck } from './lib/playerDeck'
import { PinnedPreviewsProvider, usePinnedPreviews } from './lib/pinnedPreviews'
import { BottomDock } from './components/BottomDock'
import './App.css'

// NoteEditPage は Monaco エディタを抱える重量級ページ (~1MB)。
// ホーム閲覧だけのユーザに Monaco をロードさせないよう、別チャンクに切り出す。
const NoteEditPage = lazy(() => import('./pages/NoteEditPage'))
const LineagePage = lazy(() => import('./pages/LineagePage'))
const LineageRegisterPage = lazy(() => import('./pages/LineageRegisterPage'))

/* ── Tab — 上部バーの画面の切り替え。Mado Model Tracking と同じく、
   選んでいる画面は下線と明るい文字で示す (aria-current="page")。      */
function Tab({ to, label }: { to: string; label: string }) {
  const { pathname } = useLocation()
  const active = to === '/' ? pathname === '/' : pathname.startsWith(to)
  return (
    <Link className="mado-tab" to={to} aria-current={active ? 'page' : undefined}>
      {label}
    </Link>
  )
}

// connectionId が変わったときに StoragePage を再マウントしてインメモリ状態をすべてリセットする。
function StoragePageWithKey() {
  const { connectionId } = useParams<{ connectionId: string }>()
  return <StoragePage key={connectionId} connectionId={connectionId!} />
}

function Tabs() {
  return (
    <nav className="mado-tabs" aria-label="メインナビゲーション">
      <Tab to="/"            label="Home" />
      <Tab to="/storage"     label="Storage" />
      <Tab to="/lineage"     label="DataLineage" />
      <Tab to="/settings"    label="Settings" />
    </nav>
  )
}

function LegacyAccessRedirect() {
  const tail = useParams()['*'] || 'users'
  return <Navigate to={`/settings/access/${tail}`} replace />
}

// BottomDock (同期プレイヤー + ピン留め) は画面下部に fixed でドックされるため、
// デッキにトラックがある / ピンがある間は本文の下端がドックに隠れないよう pb を
// 広げる。usePlayerDeck()/usePinnedPreviews() は各 Provider の内側でしか使えない
// ので、Provider に包まれるこの小さなラッパーで読む。
function MainContent({ children }: { children: ReactNode }) {
  const { tracks } = usePlayerDeck()
  const { pins } = usePinnedPreviews()
  const docked = tracks.length > 0 || pins.length > 0
  return (
    <main className={`mado-page-in pt-6 ${docked ? 'pb-64' : 'pb-12'}`}>
      {children}
    </main>
  )
}

export default function App() {
  return (
    <PlayerDeckProvider>
      <PinnedPreviewsProvider>
        {/* ── 上部バー ─────────────────────────────────────────────────
            Mado Model Tracking と同じ暗い帯。幅いっぱいに置き、本文だけを
            これまでどおり中央の 1180px に収める。                        */}
        <header className="mado-topbar">
          <Link to="/" className="mado-brand" aria-label="mado ホームへ">
            Mado
          </Link>
          <Tabs />
        </header>
        <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
          <MainContent>
            <Suspense fallback={<p className="text-[13px] text-ink-7">読み込み中…</p>}>
              <Routes>
                <Route path="/"                  element={<HomePage />} />
                <Route path="/edit-note"         element={<NoteEditPage />} />
                <Route path="/settings/*"        element={<SettingsPage />} />
                <Route path="/storage"           element={<StorageLanding />} />
                <Route path="/storage/:connectionId/*" element={<StoragePageWithKey />} />
                <Route path="/lineage"            element={<LineagePage />} />
                <Route path="/lineage/register"   element={<LineageRegisterPage />} />
                <Route path="/access/*"           element={<LegacyAccessRedirect />} />
              </Routes>
            </Suspense>
          </MainContent>
          <BottomDock />
        </div>
      </PinnedPreviewsProvider>
    </PlayerDeckProvider>
  )
}
