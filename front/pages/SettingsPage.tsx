import { lazy, Suspense } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { About } from '../components/About'
import { FeatureSettings } from '../components/FeatureSettings'
import { SignatureSettings } from '../components/SignatureSettings'
import { TagsSettings } from '../components/TagsSettings'
import { useTagsEnabled } from '../lib/useFeatureEnabled'
import { useAuth } from '../lib/auth-context'
import ConnectionEditorPage from './ConnectionEditorPage'
import ConnectionsPage from './ConnectionsPage'

const AdminPage = lazy(() => import('./AdminPage'))

const NAV_ITEMS = [
  { to: '/settings/account', label: 'Account' },
  { to: '/settings/connections', label: 'Connections' },
  { to: '/settings/features', label: 'Features' },
] as const

function SettingsNav() {
  const { user } = useAuth()
  const canAccess = user?.permissions.some(permission =>
    permission === 'users:manage' || permission === 'service_accounts:manage' || permission === 'audit:read'
  ) ?? false
  return (
    <nav className="section-nav" aria-label="Settings">
      {NAV_ITEMS.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => `section-nav__link${isActive ? ' is-active' : ''}`}
        >
          {item.label}
        </NavLink>
      ))}
      {canAccess && (
        <NavLink
          to="/settings/access"
          className={({ isActive }) => `section-nav__link${isActive ? ' is-active' : ''}`}
        >
          Access
        </NavLink>
      )}
      <NavLink
        to="/settings/about"
        className={({ isActive }) => `section-nav__link${isActive ? ' is-active' : ''}`}
      >
        About
      </NavLink>
    </nav>
  )
}

function FeaturesPage() {
  const tagsEnabled = useTagsEnabled()
  return (
    <div className="settings-section-stack">
      {tagsEnabled && <TagsSettings />}
      <FeatureSettings />
    </div>
  )
}

export default function SettingsPage() {
  return (
    <section>
      <header className="page-head"><h2>Settings</h2></header>
      <div className="section-shell">
        <SettingsNav />
        <div className="section-shell__content">
          <Routes>
            <Route index element={<Navigate to="connections" replace />} />
            <Route path="account" element={<SignatureSettings />} />
            <Route path="connections" element={<ConnectionsPage />} />
            <Route path="connections/new" element={<ConnectionEditorPage />} />
            <Route path="connections/:connectionId" element={<ConnectionEditorPage />} />
            <Route path="features" element={<FeaturesPage />} />
            <Route path="access/*" element={
              <Suspense fallback={<p className="text-[13px] text-ink-7">読み込み中…</p>}>
                <AdminPage />
              </Suspense>
            } />
            <Route path="about" element={<About />} />
            <Route path="*" element={<Navigate to="connections" replace />} />
          </Routes>
        </div>
      </div>
    </section>
  )
}
