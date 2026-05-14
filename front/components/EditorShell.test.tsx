import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { EditorShell } from './EditorShell'

// Monaco を出さず、テスト用の小さな textarea で body を編集できるようにする。
// EditorShell は children render-prop で body/setBody を受け取る設計なので、
// テストでは textarea を差し込むだけで dirty 管理や save フローを検証できる。
// useBlocker は data router (createMemoryRouter + RouterProvider) を要求するので
// MemoryRouter ではなく createMemoryRouter で wrap する。
function shellWith(props: {
  initialBody?: string
  initialEditor?: string
  onSave?: (b: string, e: string) => Promise<void>
  onSaved?: () => void
  onCancel?: () => void
  leftPane?: ReactNode
}) {
  const {
    initialBody = '',
    initialEditor = '',
    onSave = async () => {},
    onSaved = () => {},
    onCancel = () => {},
    leftPane,
  } = props

  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <EditorShell
          title="Edit"
          initialBody={initialBody}
          initialEditor={initialEditor}
          onSave={onSave}
          onSaved={onSaved}
          onCancel={onCancel}
          leftPane={leftPane}
        >
          {({ body, setBody }) => (
            <textarea
              aria-label="Markdown body"
              value={body}
              onChange={e => setBody(e.target.value)}
            />
          )}
        </EditorShell>
      ),
    },
  ])
  return <RouterProvider router={router} />
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('EditorShell — saving', () => {
  it('passes current body and editor name to onSave, persists name, calls onSaved', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(shellWith({ initialBody: 'hello', initialEditor: '', onSave, onSaved }))

    await user.type(screen.getByLabelText('編集者名'), 'tanaka')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(onSave).toHaveBeenCalledWith('hello', 'tanaka')
    expect(onSaved).toHaveBeenCalled()
    expect(localStorage.getItem('dashboard.lastEditor')).toBe('tanaka')
  })

  it('does not call onSaved on save failure and surfaces the error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'))
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(shellWith({ initialBody: 'hello', initialEditor: 'tanaka', onSave, onSaved }))

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(onSaved).not.toHaveBeenCalled()
    expect(await screen.findByText(/boom/)).toBeTruthy()
  })

  it('prefills editor name from localStorage when initialEditor is empty', () => {
    localStorage.setItem('dashboard.lastEditor', 'sato')
    render(shellWith({ initialBody: '', initialEditor: '' }))
    expect((screen.getByLabelText('編集者名') as HTMLInputElement).value).toBe('sato')
  })

  it('disables 保存 until the editor name is provided', () => {
    render(shellWith({ initialBody: 'hello', initialEditor: '' }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })
})

describe('EditorShell — leave warning', () => {
  it('cancels without confirm when nothing has changed', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(shellWith({ initialBody: 'hello', initialEditor: 'tanaka', onCancel }))
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))

    // dirty=false なので confirm は呼ばれない
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('asks for confirm on cancel when the body is dirty, and skips onCancel if the user declines', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(shellWith({ initialBody: 'hello', initialEditor: 'tanaka', onCancel }))
    // body を編集 → dirty
    const ta = screen.getByLabelText('Markdown body')
    await user.click(ta)
    await user.type(ta, ' world')

    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('proceeds with cancel when the user confirms the dirty leave', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(shellWith({ initialBody: 'hello', initialEditor: 'tanaka', onCancel }))
    const ta = screen.getByLabelText('Markdown body')
    await user.click(ta)
    await user.type(ta, '!')

    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('registers a beforeunload listener while dirty and removes it when clean', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const user = userEvent.setup()

    render(shellWith({ initialBody: 'hello', initialEditor: 'tanaka' }))
    // 初期は dirty=false → beforeunload は登録されていない
    expect(
      addSpy.mock.calls.some(([type]) => type === 'beforeunload'),
    ).toBe(false)

    // 編集 → dirty=true → 登録される
    const ta = screen.getByLabelText('Markdown body')
    await user.click(ta)
    await user.type(ta, 'x')
    expect(
      addSpy.mock.calls.some(([type]) => type === 'beforeunload'),
    ).toBe(true)

    // 入力を元に戻す → dirty=false → 登録解除される
    await user.clear(ta)
    await user.type(ta, 'hello')
    expect(
      removeSpy.mock.calls.some(([type]) => type === 'beforeunload'),
    ).toBe(true)
  })
})

describe('EditorShell — layout', () => {
  it('renders 1-pane when leftPane is omitted', () => {
    const { container } = render(shellWith({ initialBody: '', initialEditor: '' }))
    const section = container.querySelector('.editpage')!
    expect(section.classList.contains('editpage--two-pane')).toBe(false)
    expect(container.querySelector('.editpage__sidebar')).toBeNull()
  })

  it('renders 2-pane when leftPane is provided', () => {
    const { container } = render(
      shellWith({
        initialBody: '',
        initialEditor: '',
        leftPane: <div data-testid="left-pane">sidebar</div>,
      }),
    )
    const section = container.querySelector('.editpage')!
    expect(section.classList.contains('editpage--two-pane')).toBe(true)
    expect(screen.getByTestId('left-pane')).toBeInTheDocument()
  })

  it('does not render the sidebar toggle button when leftPane is omitted', () => {
    render(shellWith({ initialBody: '', initialEditor: '' }))
    expect(screen.queryByRole('button', { name: /ファイル参照/ })).toBeNull()
  })

  it('toggles the mobile-open data attribute on the sidebar when the toggle is clicked', async () => {
    const user = userEvent.setup()
    const { container } = render(
      shellWith({
        initialBody: '',
        initialEditor: '',
        leftPane: <div data-testid="left-pane">sidebar</div>,
      }),
    )

    const sidebar = container.querySelector('.editpage__sidebar')!
    // 初期: 閉じている (= data-mobile-open="false")。デスクトップでは CSS により
    // 常時表示されるが、この属性自体はモバイル時の表示判定に使う。
    expect(sidebar.getAttribute('data-mobile-open')).toBe('false')

    const toggle = screen.getByRole('button', { name: /ファイル参照/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await user.click(toggle)
    expect(sidebar.getAttribute('data-mobile-open')).toBe('true')
    expect(screen.getByRole('button', { name: /閉じる/ })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /閉じる/ }).getAttribute('aria-expanded'),
    ).toBe('true')

    // もう一度押すと閉じる
    await user.click(screen.getByRole('button', { name: /閉じる/ }))
    expect(sidebar.getAttribute('data-mobile-open')).toBe('false')
  })
})
