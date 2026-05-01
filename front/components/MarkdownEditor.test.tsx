import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor'

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('MarkdownEditor', () => {
  it('passes current body and editor name to onSave, persists name, calls onSaved', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(
      <MarkdownEditor
        title="Edit"
        initialBody="hello"
        initialEditor=""
        onSave={onSave}
        onSaved={onSaved}
        onClose={() => {}}
      />,
    )
    await user.type(screen.getByLabelText(/Your name/i), 'tanaka')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSave).toHaveBeenCalledWith('hello', 'tanaka')
    expect(onSaved).toHaveBeenCalled()
    expect(localStorage.getItem('dashboard.lastEditor')).toBe('tanaka')
  })

  it('does not call onSaved on save failure and surfaces the error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'))
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(
      <MarkdownEditor
        title="Edit"
        initialBody="hello"
        initialEditor="tanaka"
        onSave={onSave}
        onSaved={onSaved}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSaved).not.toHaveBeenCalled()
    expect(await screen.findByText(/boom/)).toBeTruthy()
  })

  it('prefills editor name from localStorage when initialEditor is empty', () => {
    localStorage.setItem('dashboard.lastEditor', 'sato')
    render(
      <MarkdownEditor
        title="Edit"
        initialBody=""
        initialEditor=""
        onSave={async () => {}}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    )
    expect(
      (screen.getByLabelText(/Your name/i) as HTMLInputElement).value,
    ).toBe('sato')
  })

  it('disables Save until the editor name is provided', () => {
    render(
      <MarkdownEditor
        title="Edit"
        initialBody="hello"
        initialEditor=""
        onSave={async () => {}}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    )
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })
})
