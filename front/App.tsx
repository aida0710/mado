import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom'
import HomePage from './pages/HomePage'
import StoragePage from './pages/StoragePage'
import StorageLanding from './pages/StorageLanding'
import ConnectionsPage from './pages/ConnectionsPage'
import './App.css'

/* ── Tab — masthead 右側のナビ。
   editorial: 小キャップ + tracking。アクティブは細い下線で示す
   (背景塗りはやめて静謐さを優先)。                                     */
function Tab({ to, label }: { to: string; label: string }) {
  const { pathname } = useLocation()
  const active = to === '/' ? pathname === '/' : pathname.startsWith(to)
  return (
    <Link
      className={
        'inline-flex h-9 items-center px-1 ' +
        'text-[11px] font-semibold uppercase tracking-[0.22em] ' +
        'no-underline transition-colors duration-[160ms] ' +
        'border-b-[1.5px] ' +
        (active
          ? 'border-ink-12 text-ink-12'
          : 'border-transparent text-ink-7 hover:text-ink-11')
      }
      to={to}
    >
      {label}
    </Link>
  )
}

// connId が変わったときに StoragePage を再マウントしてインメモリ状態をすべてリセットする。
function StoragePageWithKey() {
  const { connId } = useParams<{ connId: string }>()
  return <StoragePage key={connId} connId={connId!} />
}

function Tabs() {
  return (
    <nav className="flex items-stretch gap-6">
      <Tab to="/"            label="Home" />
      <Tab to="/storage"     label="Storage" />
      <Tab to="/connections" label="Settings" />
    </nav>
  )
}

export default function App() {
  return (
    <div className="mx-auto max-w-[1180px] px-6">
      {/* ── Masthead ─────────────────────────────────────────────────
          newspaper の刊頭 (masthead) を意識:
          ・左 = upright serif で "mado." (ピリオドはタイポ的アクセント)
          ・右 = small-cap タブ
          ・下に hairline rule (border-color はトークンの --color-rule)
          を thin に置く。                                             */}
      <header
        className="flex items-center justify-between gap-4 pt-7 pb-4"
        style={{ borderBottom: '1px solid var(--rule)' }}
      >
        <Link
          to="/"
          className="group flex items-baseline gap-3 self-end text-ink-12 no-underline"
          aria-label="mado ホームへ"
        >
          <img
            src="/mado-icon.png"
            alt=""
            width={18}
            height={18}
            className="-mb-0.5 self-center opacity-80 transition-opacity group-hover:opacity-100"
          />
          <h1
            className="m-0 font-serif font-medium text-[26px] leading-none tracking-[-0.02em] text-ink-12"
            style={{ fontVariationSettings: "'opsz' 28" }}
          >
            <span>mado</span>
            <span className="text-ink-9">.</span>
          </h1>
        </Link>
        <Tabs />
      </header>

      <main className="mado-page-in pt-6 pb-12">
        <Routes>
          <Route path="/"                  element={<HomePage />} />
          <Route path="/connections"       element={<ConnectionsPage />} />
          <Route path="/storage"           element={<StorageLanding />} />
          <Route path="/storage/:connId/*" element={<StoragePageWithKey />} />
        </Routes>
      </main>

      {/* Colophon — 紙の出版物のように footer に静かなクレジット。 */}
      <footer
        className="mt-10 mb-8 pt-5 text-center text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-5"
        style={{ borderTop: '1px solid var(--rule)' }}
      >
        mado · LAN/VPN internal
      </footer>
    </div>
  )
}
