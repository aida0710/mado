import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageBrowser } from './StorageBrowser'

vi.mock('../lib/api/client', () => ({
  api: {
    list: vi.fn(),
    invalidateList: vi.fn(),
    downloadUrl: vi.fn(() => 'http://x/dl'),
  },
}))

import { api } from '../lib/api/client'

afterEach(() => {
  vi.clearAllMocks()
})

function renderBrowser(prefix = 'voice/') {
  return render(
    <MemoryRouter>
      <StorageBrowser connId="c1" bucket="b1" prefix={prefix} />
    </MemoryRouter>,
  )
}

describe('StorageBrowser - directory row', () => {
  it('renders directory name inside an <a href> for native cmd+click support', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
    })

    renderBrowser('voice/')

    const link = await screen.findByRole('link', { name: /jp\// })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/storage/c1/b1/voice/jp/')
  })
})
