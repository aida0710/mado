import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionForm } from './ConnectionForm'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'
import { PRICING_FIXTURE } from '../lib/api/fixtures'
import type { Connection } from '../lib/api/types'

const TIB = 1024 ** 4

const conn: Connection = {
  id: 'c1', name: 'mdx-s3', endpoint: 'https://mdx.lan:9000', region: 'auto',
  accessKeyIdMasked: 'AKIA…2345', forcePathStyle: true, listObjectsVersion: 'v2',
  capabilities: ALL_CAPABILITIES_ON,
  scanEnabled: true,
  listCacheTtlSec: 86400,
  pricing: PRICING_FIXTURE,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
}

const awsConn: Connection = {
  ...conn,
  name: 'aws-s3',
  endpoint: 'https://s3.ap-northeast-1.amazonaws.com',
  region: 'ap-northeast-1',
  pricing: {
    ...PRICING_FIXTURE,
    provider: 'aws',
    providerExplicit: false,
    region: 'ap-northeast-1',
    storageClass: 'STANDARD',
    storageClassLabel: 'Standard',
    effective: {
      ...PRICING_FIXTURE.effective,
      storagePerGbMonth: 0.025,
      putPer1000: 0.0047,
      getPer1000: 0.00037,
    },
  },
}

function renderEdit(current: Connection, onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(<ConnectionForm mode={{ kind: 'edit', current, onSubmit }} onClose={() => {}} />)
  return onSubmit
}

describe('ConnectionForm の見積もり設定', () => {
  it('新規作成では出さない (既定で見積もりは出るため)', () => {
    render(<ConnectionForm mode={{ kind: 'create', onSubmit: vi.fn() }} onClose={() => {}} />)
    expect(screen.queryByLabelText('プロバイダ')).toBeNull()
  })

  it('自動判定の結果をプロバイダの既定として見せる', () => {
    renderEdit(conn)
    const select = screen.getByLabelText('プロバイダ')
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: /自動判定 \(社内/ })).toBeInTheDocument()
  })

  it('社内ストレージではストレージクラスを出さない', () => {
    renderEdit(conn)
    expect(screen.queryByLabelText('ストレージクラス')).toBeNull()
  })

  it('AWS ならストレージクラスを出す', () => {
    renderEdit(awsConn)
    expect(screen.getByLabelText('ストレージクラス')).toHaveValue('STANDARD')
  })

  it('プロバイダを AWS に変えるとその場でストレージクラスが現れる', async () => {
    renderEdit(conn)
    expect(screen.queryByLabelText('ストレージクラス')).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('プロバイダ'), 'aws')
    expect(screen.getByLabelText('ストレージクラス')).toBeInTheDocument()
  })

  it('実効単価を出す', () => {
    renderEdit(awsConn)
    expect(screen.getByText(/\$0\.025\/GB-月/)).toBeInTheDocument()
  })

  it('費用のかからない接続はそう伝える', () => {
    renderEdit(conn)
    expect(screen.getByText('費用のかからない接続として計算します。')).toBeInTheDocument()
  })

  it('カタログに単価が無ければ「0 だが無料ではない」と伝える', () => {
    renderEdit({
      ...awsConn,
      pricing: { ...awsConn.pricing, ratesResolved: false, region: 'moon-base-1' },
    })
    expect(screen.getByText(/moon-base-1 の単価が料金カタログにありません/)).toBeInTheDocument()
    expect(screen.getByText(/無料という意味ではありません/)).toBeInTheDocument()
  })

  it('触らなければ何も送らない', async () => {
    const onSubmit = renderEdit(conn)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({})
  })

  it('変えた項目だけを差分で送る', async () => {
    const onSubmit = renderEdit(conn)
    const read = screen.getByLabelText('読み出し帯域 (MB/s)')
    await userEvent.clear(read)
    await userEvent.type(read, '840')

    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { readMbps: 840 } })
  })

  it('プロバイダを明示すると送る', async () => {
    const onSubmit = renderEdit(conn)
    await userEvent.selectOptions(screen.getByLabelText('プロバイダ'), 'wasabi')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { provider: 'wasabi' } })
  })

  it('自動判定に戻すと null を送る (設定行を消させる)', async () => {
    const explicit: Connection = {
      ...conn,
      pricing: { ...PRICING_FIXTURE, provider: 'wasabi', providerExplicit: true },
    }
    const onSubmit = renderEdit(explicit)
    await userEvent.selectOptions(screen.getByLabelText('プロバイダ'), '')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    // undefined (触らない) ではなく null (既定に戻す) であることが要点。
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { provider: null } })
  })

  it('容量は TB で入れてバイトで送る', async () => {
    const onSubmit = renderEdit(conn)
    await userEvent.type(screen.getByLabelText('容量 (TB)'), '320')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { capacityBytes: 320 * TIB } })
  })

  it('容量を空にすると null を送る (警告を止める)', async () => {
    const withCapacity: Connection = {
      ...conn,
      pricing: { ...PRICING_FIXTURE, capacityBytes: 320 * TIB },
    }
    const onSubmit = renderEdit(withCapacity)
    const cap = screen.getByLabelText('容量 (TB)')
    expect(cap).toHaveValue(320)
    await userEvent.clear(cap)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { capacityBytes: null } })
  })

  it('ストレージクラスの変更を送る', async () => {
    const onSubmit = renderEdit(awsConn)
    await userEvent.selectOptions(screen.getByLabelText('ストレージクラス'), 'DEEP_ARCHIVE')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { storageClass: 'DEEP_ARCHIVE' } })
  })

  it('ストレージ単価を上書きできる', async () => {
    const onSubmit = renderEdit(conn)
    await userEvent.type(screen.getByLabelText('ストレージ単価の上書き ($/GB-月)'), '0.004')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { storagePerGbMonth: 0.004 } })
  })

  it('単価の上書きを空にするとカタログに戻す', async () => {
    const overridden: Connection = {
      ...conn,
      pricing: { ...PRICING_FIXTURE, storagePerGbMonth: 0.004 },
    }
    const onSubmit = renderEdit(overridden)
    const input = screen.getByLabelText('ストレージ単価の上書き ($/GB-月)')
    expect(input).toHaveValue(0.004)
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { storagePerGbMonth: null } })
  })

  it('手入力の単価は「更新では変わらない」と伝える', () => {
    // Wasabi のように料金 API が無いプロバイダ。
    renderEdit({
      ...conn,
      pricing: {
        ...PRICING_FIXTURE,
        provider: 'wasabi',
        providerExplicit: true,
        effective: {
          ...PRICING_FIXTURE.effective,
          storagePerGbMonth: 0.0078,
          minDurationDays: 90,
          storageRateSource: 'manual',
        },
      },
    })
    expect(screen.getByText(/単価は手入力。「単価を更新」では変わりません/)).toBeInTheDocument()
  })

  it('上書き済みならそう表示する', () => {
    renderEdit({
      ...awsConn,
      pricing: {
        ...awsConn.pricing,
        storagePerGbMonth: 0.004,
        effective: { ...awsConn.pricing.effective, storageRateSource: 'override' },
      },
    })
    expect(screen.getByText(/単価はこの接続で上書き済み/)).toBeInTheDocument()
  })

  it('不安定さは 0 も送れる (上振れ無しは意味のある設定)', async () => {
    const onSubmit = renderEdit(conn)
    const inst = screen.getByLabelText('不安定さ')
    await userEvent.clear(inst)
    await userEvent.type(inst, '0')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({ pricing: { instability: 0 } })
  })
})
