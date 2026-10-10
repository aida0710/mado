import { lazy, Suspense, useLayoutEffect, useRef } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
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

// 見出しの下の横並びのタブ。左にはアプリのサイドバーがあるので、二本目の列は作らない。
// 選択中の見た目は NavLink が付ける aria-current="page" で共通の .tab が受け持つ。
function SettingsNav() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const navRef = useRef<HTMLElement>(null)
  const canAccess = user?.permissions.some(permission =>
    permission === 'users:manage' || permission === 'service_accounts:manage' || permission === 'audit:read'
  ) ?? false

  // 狭い画面でタブが横にはみ出すときは、選んでいるタブが見えるところまでタブの列を送る。
  // scrollIntoView はページごと動かすことがあるので、タブの列の scrollLeft だけを変える。
  useLayoutEffect(() => {
    const nav = navRef.current
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !current) return
    const navBox = nav.getBoundingClientRect()
    const tabBox = current.getBoundingClientRect()
    if (tabBox.right > navBox.right) nav.scrollLeft += tabBox.right - navBox.right
    else if (tabBox.left < navBox.left) nav.scrollLeft -= navBox.left - tabBox.left
  }, [pathname])

  return (
    <nav ref={navRef} className="tabs" aria-label="Settings">
      {NAV_ITEMS.map(item => (
        <NavLink key={item.to} to={item.to} className="tab">
          {item.label}
        </NavLink>
      ))}
      {canAccess && <NavLink to="/settings/access" className="tab">Access</NavLink>}
      <NavLink to="/settings/about" className="tab">About</NavLink>
    </nav>
  )
}

function FeaturesPage() {
  const tagsEnabled = useTagsEnabled()
  return (
    <div className="settings-stack">
      {tagsEnabled && <TagsSettings />}
      <FeatureSettings />
    </div>
  )
}

export default function SettingsPage() {
  return (
    <div className="settings-page">
      <header className="page-header">
        <div><h1>Settings</h1></div>
      </header>
      <SettingsNav />
      <Routes>
        <Route index element={<Navigate to="connections" replace />} />
        <Route path="account" element={<SignatureSettings />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="connections/new" element={<ConnectionEditorPage />} />
        <Route path="connections/:connectionId" element={<ConnectionEditorPage />} />
        <Route path="features" element={<FeaturesPage />} />
        <Route path="access/*" element={
          <Suspense fallback={<p className="state-message">読み込み中…</p>}>
            <AdminPage />
          </Suspense>
        } />
        <Route path="about" element={<About />} />
        <Route path="*" element={<Navigate to="connections" replace />} />
      </Routes>
    </div>
  )
}
