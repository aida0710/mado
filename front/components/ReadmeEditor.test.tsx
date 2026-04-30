import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadmeEditor } from './ReadmeEditor'

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReadmeEditor', () => {
  it('saves textarea content with editor name and triggers onSaved', async () => {
    const onSaved = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, size_bytes: 3 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const user = userEvent.setup()
    render(
      <ReadmeEditor
        bucket="b"
        prefix="x/"
        initialBody="old"
        initialEditor=""
        onClose={() => {}}
        onSaved={onSaved}
      />,
    )
    await user.clear(screen.getByLabelText('README'))
    await user.type(screen.getByLabelText('README'), 'new')
    await user.type(screen.getByLabelText(/Your name/i), 'tanaka')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/s3/readme',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          bucket: 'b',
          prefix: 'x/',
          body: 'new',
          editor: 'tanaka',
        }),
      }),
    )
    expect(onSaved).toHaveBeenCalled()
    expect(localStorage.getItem('dashboard.lastEditor')).toBe('tanaka')
  })

  it('does not call onSaved on fetch failure', async () => {
    const onSaved = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    )
    const user = userEvent.setup()
    render(
      <ReadmeEditor
        bucket="b"
        prefix="x/"
        initialBody="hello"
        initialEditor="tanaka"
        onClose={() => {}}
        onSaved={onSaved}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSaved).not.toHaveBeenCalled()
    expect(await screen.findByText(/boom/)).toBeTruthy()
  })

  it('prefills editor from localStorage when initialEditor is empty', async () => {
    localStorage.setItem('dashboard.lastEditor', 'sato')
    render(
      <ReadmeEditor
        bucket="b"
        prefix="x/"
        initialBody=""
        initialEditor=""
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    expect(
      (screen.getByLabelText(/Your name/i) as HTMLInputElement).value,
    ).toBe('sato')
  })
})
