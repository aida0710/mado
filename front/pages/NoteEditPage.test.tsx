import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NoteEditPage from './NoteEditPage'

vi.mock('../lib/api/client', () => ({
  api: { note: vi.fn(), putNote: vi.fn() },
}))

// Monaco は jsdom で動かないので、本文を見られる textarea に差し替える。
vi.mock('../components/MonacoMarkdownEditor', () => ({
  MonacoMarkdownEditor: ({ value, onChange, ariaLabel }: {
    value: string; onChange: (value: string) => void; ariaLabel: string
  }) => <textarea aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} />,
}))

import { api } from '../lib/api/client'

const noteMock = api.note as ReturnType<typeof vi.fn>

afterEach(() => { vi.resetAllMocks() })

// EditorShell の useBlocker は data router を要求する。
function renderNoteEditPage() {
  const router = createMemoryRouter([{ path: '*', element: <NoteEditPage /> }], { initialEntries: ['/edit-note'] })
  return render(<RouterProvider router={router} />)
}

describe('NoteEditPage — 取得の失敗', () => {
  it('ノートを読み込めないと、空のエディタを開かず、理由と再試行を出す', async () => {
    noteMock.mockRejectedValue(new Error('Internal Server Error'))
    renderNoteEditPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Team noteを読み込めませんでした（Internal Server Error）')
    expect(screen.getByText('既存の本文を上書きしないよう、読み込めるまで編集できません。')).toBeInTheDocument()
    expect(screen.queryByLabelText('ノート本文 (Markdown)')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  it('再試行して読み込めれば、既存の本文でエディタを開く', async () => {
    noteMock
      .mockRejectedValueOnce(new Error('Internal Server Error'))
      .mockResolvedValueOnce({ exists: true, body: '既存の本文', last_editor: 'aida', last_edited_at: '2026-09-29T01:00:00Z' })
    const user = userEvent.setup()
    renderNoteEditPage()

    await user.click(await screen.findByRole('button', { name: '再試行' }))

    expect(await screen.findByLabelText('ノート本文 (Markdown)')).toHaveValue('既存の本文')
  })
})
