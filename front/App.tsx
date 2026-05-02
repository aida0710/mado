import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom'
import HomePage from './pages/HomePage'
import MetricsPage from './pages/MetricsPage'
import StoragePage from './pages/StoragePage'
import StorageLanding from './pages/StorageLanding'
import ConnectionsPage from './pages/ConnectionsPage'
import { FlagsProvider, isEnabled, useFlags } from './lib/flagsContext'
import './App.css'

function Tab({ to, label }: { to: string; label: string }) {
  const { pathname } = useLocation()
  const active = to === '/' ? pathname === '/' : pathname.startsWith(to)
  return (
    <Link
      className={
        'inline-flex h-8 items-center rounded-2 px-3 font-medium leading-none ' +
        'no-underline transition-colors duration-[120ms] ' +
        (active
          ? 'bg-ink-12 text-paper'
          : 'text-ink-9 hover:bg-ink-1 hover:text-ink-11')
      }
      to={to}
    >
      {label}
    </Link>
  )
}

// 「窓」のロゴマーク。外枠を太め、内分割線 (mullion) を細めにして
// ただの 4 分割グリッドより窓らしいバランスにする。currentColor 継承で
// 親のテキスト色に追従。
function MadoMark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="4" x2="12" y2="20" stroke="currentColor" strokeWidth="1.25" />
      <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

// connId が変わったときに StoragePage を再マウントしてインメモリ状態をすべてリセットする。
function StoragePageWithKey() {
  const { connId } = useParams<{ connId: string }>()
  return <StoragePage key={connId} connId={connId!} />
}

function Tabs() {
  const { flags } = useFlags()
  return (
    <nav className="flex items-stretch gap-1">
      <Tab to="/"            label="Home" />
      <Tab to="/storage"     label="Storage" />
      {isEnabled(flags, 'metrics') && (
        <Tab to="/metrics"   label="Metrics" />
      )}
      <Tab to="/connections" label="Settings" />
    </nav>
  )
}

export default function App() {
  return (
    <FlagsProvider>
      <div className="mx-auto max-w-[1100px] px-4">
        <header className="flex items-baseline gap-4 border-b border-ink-2 py-4">
          <Link
            to="/"
            className="flex items-center gap-2 self-center text-ink-11 no-underline hover:text-ink-12"
            aria-label="mado ホームへ"
          >
            <MadoMark />
            <h1 className="m-0 text-lg font-semibold tracking-tight">mado</h1>
          </Link>
          <Tabs />
        </header>
        <main className="pb-8 pt-4">
          <Routes>
            <Route path="/"                  element={<HomePage />} />
            <Route path="/metrics"           element={<MetricsPage />} />
            <Route path="/connections"       element={<ConnectionsPage />} />
            <Route path="/storage"           element={<StorageLanding />} />
            <Route path="/storage/:connId/*" element={<StoragePageWithKey />} />
          </Routes>
        </main>
      </div>
    </FlagsProvider>
  )
}
