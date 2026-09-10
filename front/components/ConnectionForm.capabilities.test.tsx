import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionForm } from './ConnectionForm'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'
import { PRICING_FIXTURE } from '../lib/api/fixtures'
import type { Connection } from '../lib/api/types'
import { api } from '../lib/api/client'

const conn: Connection = {
  id: 'c1', name: 'primary', endpoint: 'https://s3.example.com/', region: 'auto',
  accessKeyIdMasked: 'AKIA…2345', forcePathStyle: true, listObjectsVersion: 'v2',
  capabilities: ALL_CAPABILITIES_ON,
  scanEnabled: true,
  listCacheTtlSec: 86400,
  pricing: PRICING_FIXTURE,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
  visibility: { mode: 'public', allowedUsers: [] },
}

afterEach(() => vi.restoreAllMocks())

describe('ConnectionForm の権限トグル', () => {
  it('新規作成では全許可で送る', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ConnectionForm mode={{ kind: 'create', onSubmit }} onClose={() => {}} />)

    await userEvent.type(screen.getByPlaceholderText('例: production'), 'new')
    await userEvent.type(screen.getByPlaceholderText('https://s3.example.com'), 'https://s3.example.com')
    // アクセスキー ID は placeholder もアクセシブル名も無い最後の textbox。
    const inputs = screen.getAllByRole('textbox')
    await userEvent.type(inputs[inputs.length - 1], 'AKIAEXAMPLE12345')
    await userEvent.type(document.querySelector('input[type="password"]')!, 'secret-value')

    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].capabilities).toEqual(ALL_CAPABILITIES_ON)
  })

  it('編集では変えたトグルだけを差分で送る', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ConnectionForm mode={{ kind: 'edit', current: conn, onSubmit }} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'ファイルのダウンロード' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ capabilities: { download: false } })
  })

  it('README 読み込みを切ると編集も一緒に落ちて操作できなくなる', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ConnectionForm mode={{ kind: 'edit', current: conn, onSubmit }} onClose={() => {}} />)

    const write = screen.getByRole('checkbox', { name: 'README の編集' })
    expect(write).not.toBeDisabled()

    await userEvent.click(screen.getByRole('checkbox', { name: 'README の読み込み' }))
    expect(write).toBeDisabled()
    expect(write).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    // API 側の「編集には読み込みが必要」(400) を踏まない組み合わせで送る。
    expect(onSubmit.mock.calls[0][0]).toEqual({
      capabilities: { readmeRead: false, readmeWrite: false },
    })
  })

  it('制限のある接続を開くと外したトグルが反映されている', () => {
    const restricted: Connection = {
      ...conn, capabilities: { ...ALL_CAPABILITIES_ON, download: false, archive: false },
    }
    render(
      <ConnectionForm
        mode={{ kind: 'edit', current: restricted, onSubmit: vi.fn() }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('checkbox', { name: 'ファイルのダウンロード' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '圧縮ファイル (tar / tar.gz / tar.xz) を開く' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'バケット / オブジェクトの一覧' })).toBeChecked()
  })

  it('ホワイトリストで選んだユーザーIDだけを送る', async () => {
    vi.spyOn(api, 'listConnectionAccessUsers').mockResolvedValue({
      users: [{
        id: '11111111-1111-4111-8111-111111111111',
        displayName: '許可ユーザー', username: null, email: 'allowed@example.com', status: 'active',
      }],
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ConnectionForm mode={{ kind: 'edit', current: conn, onSubmit }} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('radio', { name: 'ホワイトリスト' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: '許可ユーザーを許可' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      visibility: {
        mode: 'whitelist',
        allowedUserIds: ['11111111-1111-4111-8111-111111111111'],
      },
    }))
  })

  it('容量の周期をconnection設定として保存する', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ConnectionForm mode={{ kind: 'edit', current: conn, onSubmit }} onClose={() => {}} />)

    const interval = screen.getByRole('combobox', { name: '容量の計測周期' })
    expect(interval).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: '全バケットの容量を定期計測する' }))
    await userEvent.selectOptions(interval, '43200')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      capacityTracking: { enabled: true, intervalSeconds: 43200 },
    }))
  })

  it('走査ページサイズをconnection設定として保存する', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ConnectionForm mode={{ kind: 'edit', current: conn, onSubmit }} onClose={() => {}} />)

    const pageSize = screen.getByRole('combobox', { name: '走査のページサイズ' })
    expect(pageSize).toHaveValue('1000')
    await userEvent.selectOptions(pageSize, '100')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ scanPageSize: 100 }))
  })

  it('メトリクス集計を無効にすると定期計測と周期をグレーアウトする', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const tracked: Connection = {
      ...conn, capacityTracking: { enabled: true, intervalSeconds: 86400 },
    }
    render(<ConnectionForm mode={{ kind: 'edit', current: tracked, onSubmit }} onClose={() => {}} />)

    const allow = screen.getByRole('checkbox', { name: 'バケットのメトリクス集計を許可する' })
    expect(allow).toBeChecked()
    await userEvent.click(allow)
    expect(screen.getByRole('checkbox', { name: '全バケットの容量を定期計測する' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '容量の計測周期' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      capacityMetricsEnabled: false,
      capacityTracking: { enabled: false, intervalSeconds: 86400 },
    }))
  })

  it('走査を無効にすると容量の定期計測も無効にする', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const tracked: Connection = {
      ...conn, capacityTracking: { enabled: true, intervalSeconds: 86400 },
    }
    render(<ConnectionForm mode={{ kind: 'edit', current: tracked, onSubmit }} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('checkbox', { name: '配下の走査を許可する' }))
    expect(screen.getByRole('checkbox', { name: '全バケットの容量を定期計測する' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      scanEnabled: false,
      capacityTracking: { enabled: false, intervalSeconds: 86400 },
    }))
  })
})
