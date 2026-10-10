import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, Link, Pin } from 'lucide-react'
import { api } from '../lib/api/client'
import { classifyEntry } from '../lib/api/mime'
import { fmtSize, prettyPrintJson } from '../lib/format'
import { absoluteUrl, tarEntryWebUrl } from '../lib/route'
import { copyToClipboard } from '../lib/clipboard'
import { usePinnedPreviews } from '../lib/pinnedPreviews'
import { TEXT_HEAD_BYTES } from '../lib/textSniff'
import { useCodeLanguage } from '../lib/useCodeLanguage'
import { useSniffedText } from '../lib/useSniffedText'
import { CodeFormatSelect, CodeView } from './CodeView'
import { CopyMenu, type MenuItem } from './CopyMenu'
import { Dialog } from './Dialog'
import { PreviewAudio } from './PreviewAudio'
import { CopyContentButton } from './PreviewText'
import { PreviewVideo } from './PreviewVideo'
import { UnsupportedPreview } from './UnsupportedPreview'

interface Props {
  connectionId: string
  bucket: string
  archiveKey: string
  // size / type は任意。共有 URL (?entry=) から直接開いたエントリは、ページングされた
  // 一覧の今のページに載っているとは限らず、そのときサイズを引く手段がない。
  // 本文は name から自前でフェッチするので、開くのに必要なのは name だけ。
  entry: { name: string; size?: number; type?: string }
  onClose: () => void
}

/**
 * tar の中の 1 エントリのプレビュー。プレビューのドロワーやピン留めの上に重ねるダイアログ。
 * 見出しはエントリ名、その下にどのアーカイブの中か (とサイズ) を出す。
 *
 * document.body に portal する。ドロワー (sticky) や画面下のドック (fixed) の中に置くと
 * それらの重なりの中に閉じ込められ、ドックがダイアログの上に出てしまうため。
 */
export function TarEntryModal({ connectionId, bucket, archiveKey, entry, onClose }: Props) {
  const kind = classifyEntry(entry.name)
  // <img src> / DL / 生データ URL は本体を全部要る。
  const url = api.tarEntryUrl({ connectionId, bucket, key: archiveKey, entry: entry.name })
  // テキスト判定は先頭だけで足りる。head モードでサーバーに 100MB を解凍させない。
  const headUrl = api.tarEntryUrl({ connectionId, bucket, key: archiveKey, entry: entry.name, maxBytes: TEXT_HEAD_BYTES })
  const { addPin } = usePinnedPreviews()
  // 人に送る用 (このエントリを開いた状態で復元される) と、curl / VLC 用の生データ。
  // どちらもクリップボードに載せるので絶対 URL にする (相対のままだと受け取った
  // 側でホストが分からない)。
  const copyItems: MenuItem[] = [
    {
      kind: 'copy',
      label: 'Web URL をコピー',
      value: absoluteUrl(tarEntryWebUrl({ connectionId, bucket, tarKey: archiveKey, entryPath: entry.name })),
    },
    { kind: 'copy', label: '生データ URL をコピー', value: absoluteUrl(url) },
  ]
  // エントリの操作。本文の種別によらず、本文の上の帯の右端に並べる。
  const actions = (
    <>
      <button
        type="button"
        className="icon-button"
        onClick={() => addPin({ connectionId, bucket, key: archiveKey, entryPath: entry.name })}
        aria-label="ピン留め"
        title="ピン留め"
      >
        <Pin size={16} aria-hidden="true" />
      </button>
      <CopyMenu items={copyItems} trigger={<Link size={16} aria-hidden="true" />} ariaLabel="URL をコピー" />
      <a
        className="icon-button"
        href={url}
        download={entry.name.split('/').pop()}
        aria-label={`${entry.name} をダウンロード`}
        title="ダウンロード"
      >
        <Download size={16} aria-hidden="true" />
      </a>
    </>
  )

  return createPortal(
    <Dialog
      titleId="tar-entry-title"
      title={entry.name}
      subtitle={
        <>
          {archiveKey}
          {entry.size != null && <>{' · '}<span>{fmtSize(entry.size)}</span></>}
        </>
      }
      onClose={onClose}
      closeLabel="Close entry"
      size="extra-wide"
      nested
    >
      <div className="dialog-body preview-stack">
        {/* 画像 / 音声 / 動画以外はすべてテキストとして開こうとする。
            中身がバイナリなら TextBody が「プレビュー非対応」を出す。 */}
        {kind !== 'image' && kind !== 'audio' && kind !== 'video' ? (
          <TextBody url={headUrl} name={entry.name} actions={actions} />
        ) : (
          <>
            <EntryToolbar>{actions}</EntryToolbar>
            {kind === 'image' && <img className="preview-image" src={url} alt={entry.name} />}
            {kind === 'audio' && (
              <PreviewAudio
                key={`${connectionId}|${bucket}|${archiveKey}|${entry.name}`}
                connectionId={connectionId}
                bucket={bucket}
                k={archiveKey}
                entryPath={entry.name}
              />
            )}
            {kind === 'video' && (
              <PreviewVideo
                key={`${connectionId}|${bucket}|${archiveKey}|${entry.name}`}
                connectionId={connectionId}
                bucket={bucket}
                k={archiveKey}
                entryPath={entry.name}
              />
            )}
          </>
        )}
      </div>
    </Dialog>,
    document.body,
  )
}

/** 本文の上の帯。左に行数などの情報と表示形式、右に操作。 */
function EntryToolbar({ info, children }: { info?: ReactNode; children: ReactNode }) {
  return (
    <div className="preview-toolbar">
      {info != null && <div className="preview-info">{info}</div>}
      <div className="preview-actions">{children}</div>
    </div>
  )
}

function TextBody({ url, name, actions }: { url: string; name: string; actions: ReactNode }) {
  const sniffed = useSniffedText(url)

  // 読み込み中・失敗・バイナリでも、ピン留めとダウンロードは使えるよう帯は出す。
  if (sniffed.status !== 'text') {
    return (
      <>
        <EntryToolbar>{actions}</EntryToolbar>
        {sniffed.status === 'error' && <p className="notice error">{sniffed.message}</p>}
        {sniffed.status === 'loading' && <p className="muted">読み込み中…</p>}
        {sniffed.status === 'binary' && <UnsupportedPreview />}
      </>
    )
  }
  return <LoadedText name={name} text={prettyPrintJson(name, sniffed.text)} actions={actions} />
}

/** 読み込んだテキスト。形式を推測して色を付け、帯の選択欄で形式を選び直せる。 */
function LoadedText({ name, text, actions }: { name: string; text: string; actions: ReactNode }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  const code = useCodeLanguage(name, text)

  // 末尾の改行で行数が余分に増えないようにする。
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = trimmed.length === 0 ? 0 : trimmed.split('\n').length

  const handleCopy = async () => {
    setCopied(await copyToClipboard(text))
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <>
      <EntryToolbar
        info={
          <>
            <span className="muted mono">{`${lines} 行`}</span>
            <CodeFormatSelect code={code} />
          </>
        }
      >
        <CopyContentButton copied={copied} onCopy={handleCopy} />
        {actions}
      </EntryToolbar>
      <CodeView text={text} language={code.language} className="preview-code" />
    </>
  )
}
