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
    <Link className={`tab ${active ? 'active' : ''}`} to={to}>
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
    <nav className="tabs">
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
      <div className="app">
        <header className="topbar">
          <h1 className="brand">web-dashboard</h1>
          <Tabs />
        </header>
        <main className="main">
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
