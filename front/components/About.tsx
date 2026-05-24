import { APP_VERSION, GIT_COMMIT, GIT_DATE, REPO_URL, commitUrl } from '../lib/buildInfo'

const sectionTitleClass =
  'm-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'
const dtClass = 'text-ink-7'
const ddClass = 'm-0 text-ink-11'

export function About() {
  // コミット日時は YYYY-MM-DD だけ見せる (ISO の先頭 10 文字)。
  const date = GIT_DATE ? GIT_DATE.slice(0, 10) : ''
  // 'dev' (git/env 無し) のときはリンクにしない。
  const hasCommit = GIT_COMMIT !== 'dev' && GIT_COMMIT !== ''

  return (
    <section className="mt-10">
      <div className="mb-3 pb-2" style={{ borderBottom: '1px solid var(--rule)' }}>
        <h3 className={sectionTitleClass}>About</h3>
      </div>

      <p className="m-0 mb-4 max-w-[64ch] text-[13px] leading-relaxed text-ink-9">
        オブジェクトストレージを横断的にブラウズ、プレビューし、バケット内のディレクトリを適切に管理する社内向けダッシュボード
      </p>

      <dl className="m-0 grid w-fit grid-cols-[auto_1fr] gap-x-5 gap-y-2 font-mono text-[12px]">
        <dt className={dtClass}>Version</dt>
        <dd className={`${ddClass} tabular-nums`}>v{APP_VERSION}</dd>

        <dt className={dtClass}>Commit</dt>
        <dd className={ddClass}>
          {hasCommit ? (
            <a className="about-link" href={commitUrl(GIT_COMMIT)} target="_blank" rel="noreferrer">
              {GIT_COMMIT}
            </a>
          ) : (
            <span className="text-ink-7">dev</span>
          )}
          {date && <span className="text-ink-7">{' · '}{date}</span>}
        </dd>

        <dt className={dtClass}>Repository</dt>
        <dd className={ddClass}>
          <a className="about-link" href={REPO_URL} target="_blank" rel="noreferrer">
            github.com/aida0710/web-dashboard
          </a>
        </dd>
      </dl>
    </section>
  )
}
