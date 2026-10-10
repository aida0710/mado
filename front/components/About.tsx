import { APP_VERSION, GIT_COMMIT, GIT_DATE, REPO_URL, commitUrl } from '../lib/buildInfo'
import { SettingsSectionHeader } from './SettingsSectionHeader'

export function About() {
  // コミット日時は YYYY-MM-DD だけ見せる (ISO の先頭 10 文字)。
  const date = GIT_DATE ? GIT_DATE.slice(0, 10) : ''
  // 'dev' (git/env 無し) のときはリンクにしない。
  const hasCommit = GIT_COMMIT !== 'dev' && GIT_COMMIT !== ''

  return (
    <section className="settings-column">
      <SettingsSectionHeader title="アプリケーション情報" />

      <dl className="details-list">
        <div>
          <dt>Version</dt>
          <dd className="mono">v{APP_VERSION}</dd>
        </div>
        <div>
          <dt>Commit</dt>
          <dd className="mono">
            {hasCommit ? (
              <a href={commitUrl(GIT_COMMIT)} target="_blank" rel="noreferrer">
                {GIT_COMMIT.slice(0, 7)}
              </a>
            ) : (
              <span className="muted">dev</span>
            )}
            {date && <span className="muted">{' · '}{date}</span>}
          </dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd className="mono">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              {REPO_URL.replace(/^https?:\/\//, '')}
            </a>
          </dd>
        </div>
      </dl>
    </section>
  )
}
