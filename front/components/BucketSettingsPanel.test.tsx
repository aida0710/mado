import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BucketSettingsPanel } from './BucketSettingsPanel'
import { api } from '../lib/api/client'

vi.mock('../lib/api/client', () => ({
  api: { bucketSettings: vi.fn(), setBucketSetting: vi.fn() },
}))
const mock = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mock(api.bucketSettings).mockResolvedValue({ scanEnabled: true, listCacheTtlSec: 86400 })
  mock(api.setBucketSetting).mockResolvedValue(undefined)
})

describe('BucketSettingsPanel', () => {
  it('現在の設定を反映する', async () => {
    render(<BucketSettingsPanel connId="c1" bucket="b1" />)
    expect(await screen.findByRole('checkbox', { name: /走査を許可/ })).toBeChecked()
  })

  it('トグルすると保存する', async () => {
    const user = userEvent.setup()
    render(<BucketSettingsPanel connId="c1" bucket="b1" />)
    await user.click(await screen.findByRole('checkbox', { name: /走査を許可/ }))
    await waitFor(() =>
      expect(api.setBucketSetting).toHaveBeenCalledWith('c1', 'b1', 'scan_enabled', 'false'))
  })

  it('無効なバケットではチェックが外れている', async () => {
    mock(api.bucketSettings).mockResolvedValue({ scanEnabled: false, listCacheTtlSec: 300 })
    render(<BucketSettingsPanel connId="c1" bucket="b1" />)
    expect(await screen.findByRole('checkbox', { name: /走査を許可/ })).not.toBeChecked()
  })
})
