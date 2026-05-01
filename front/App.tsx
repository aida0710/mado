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

// Re-mount StoragePage when connId changes so all in-memory state resets.
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
          <h1 className="m-0 text-lg font-semibold tracking-tight">web-dashboard</h1>
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
