import { lazy, Suspense, type CSSProperties, type ReactNode } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import HomePage from './pages/HomePage'
import StoragePage from './pages/StoragePage'
import StorageLanding from './pages/StorageLanding'
import SettingsPage from './pages/SettingsPage'
import { PlayerDeckProvider, usePlayerDeck } from './lib/playerDeck'
import { PinnedPreviewsProvider, usePinnedPreviews } from './lib/pinnedPreviews'
import { useNavigation } from './lib/useNavigation'
import { BottomDock } from './components/BottomDock'
import { NavigationSidebar } from './components/shell/NavigationSidebar'
import { TopBar } from './components/shell/TopBar'
import './App.css'

// NoteEditPage は Monaco エディタを抱える重量級ページ (~1MB)。
// ホーム閲覧だけのユーザに Monaco をロードさせないよう、別チャンクに切り出す。
const NoteEditPage = lazy(() => import('./pages/NoteEditPage'))
const LineagePage = lazy(() => import('./pages/LineagePage'))
const LineageRegisterPage = lazy(() => import('./pages/LineageRegisterPage'))

// connectionId が変わったときに StoragePage を再マウントしてインメモリ状態をすべてリセットする。
function StoragePageWithKey() {
  const { connectionId } = useParams<{ connectionId: string }>()
  return <StoragePage key={connectionId} connectionId={connectionId!} />
}

function LegacyAccessRedirect() {
  const tail = useParams()['*'] || 'users'
  return <Navigate to={`/settings/access/${tail}`} replace />
}

// BottomDock (同期プレイヤー + ピン留め) は画面下部に fixed でドックされるため、
// デッキにトラックがある / ピンがある間は本文の下端がドックに隠れないよう下の余白を
// 広げる。usePlayerDeck()/usePinnedPreviews() は各 Provider の内側でしか使えない
// ので、Provider に包まれるこの小さなラッパーで読む。
function MainContent({ children }: { children: ReactNode }) {
  const { tracks } = usePlayerDeck()
  const { pins } = usePinnedPreviews()
  const docked = tracks.length > 0 || pins.length > 0
  return (
    <main id="content" className="page" data-docked={docked ? 'true' : undefined}>
      {children}
    </main>
  )
}

/**
 * 画面の枠。Mado Model Tracking と同じ形 (@mado/design-system の shell.css):
 * 上部バー、左のサイドバー (1200px 以上は名前つき、900px 以上はアイコンだけ、
 * それ未満は上部バーのメニューボタンから開くドロワー)、その右に画面。
 */
export default function App() {
  const navigation = useNavigation()
  return (
    <PlayerDeckProvider>
      <PinnedPreviewsProvider>
        <div
          className="app-shell"
          data-navigation={navigation.mode}
          style={{ '--navigation-width': `${navigation.width}px` } as CSSProperties}
        >
          <TopBar navigation={navigation} />
          <div className="app-body">
            {navigation.mode !== 'drawer' && <NavigationSidebar navigation={navigation} />}
            <div className="app-content">
              <MainContent>
                <Suspense fallback={<p className="state-message">読み込み中…</p>}>
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
            </div>
          </div>
          <BottomDock />
        </div>
      </PinnedPreviewsProvider>
    </PlayerDeckProvider>
  )
}
