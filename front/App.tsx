import { Link, Route, Routes, useLocation } from 'react-router-dom'
import HpcPage from './pages/HpcPage'
import S3Page from './pages/S3Page'
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

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">web-dashboard</h1>
        <nav className="tabs">
          <Tab to="/"   label="スパコン" />
          <Tab to="/s3" label="mdx S3"   />
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/"     element={<HpcPage />} />
          <Route path="/s3/*" element={<S3Page  />} />
        </Routes>
      </main>
    </div>
  )
}
