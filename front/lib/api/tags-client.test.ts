import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

afterEach(() => vi.restoreAllMocks())

describe('tags client', () => {
  it('tags() はレジストリ一覧を parse する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      { id: 't1', name: '重要', color: '#ff0000' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const list = await api.tags()
    expect(list).toEqual([{ id: 't1', name: '重要', color: '#ff0000' }])
  })

  it('createTag は POST /tags を叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 't1', name: 'A', color: '#111111' }), { status: 200 }))
    await api.createTag({ name: 'A', color: '#111111' })
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/tags')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'A', color: '#111111' })
  })

  it('updateTag は PUT /tags/:id を叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 't1', name: 'A', color: '#222222' }), { status: 200 }))
    await api.updateTag('t 1', { color: '#222222' })
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/tags/t%201')
    expect((init as RequestInit).method).toBe('PUT')
  })

  it('deleteTag は DELETE /tags/:id を叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await api.deleteTag('t1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/tags/t1')
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('tagAssignments は paths を繰り返しクエリで渡す', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ 'a/': ['t1'] }), { status: 200 }))
    const out = await api.tagAssignments('c1', 'bkt', 'prefix', ['a/', 'b/'])
    expect(out).toEqual({ 'a/': ['t1'] })
    const [url] = spy.mock.calls[0]
    const u = new URL(String(url), 'http://x')
    expect(u.pathname).toBe('/api/internal/storage/c1/tags')
    expect(u.searchParams.getAll('paths')).toEqual(['a/', 'b/'])
    expect(u.searchParams.get('kind')).toBe('prefix')
  })

  it('tagAssignments は paths が空なら fetch せず {} を返す', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const out = await api.tagAssignments('c1', 'bkt', 'file', [])
    expect(out).toEqual({})
    expect(spy).not.toHaveBeenCalled()
  })

  it('assignTag は PUT body で bucket/kind/path/tagId を送る', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await api.assignTag('c1', 'bkt', 'file', 'a/b.txt', 't1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/c1/tags')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      bucket: 'bkt', kind: 'file', path: 'a/b.txt', tagId: 't1',
    })
  })

  it('unassignTag は DELETE body で bucket/kind/path/tagId を送る', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await api.unassignTag('c1', 'bkt', 'prefix', 'a/', 't1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/c1/tags')
    expect((init as RequestInit).method).toBe('DELETE')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      bucket: 'bkt', kind: 'prefix', path: 'a/', tagId: 't1',
    })
  })

  it('tagSearch は tagId を繰り返しクエリで渡す', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ tagId: 't1', bucket: 'b', kind: 'bucket', path: '' }]), { status: 200 }))
    const out = await api.tagSearch('c1', ['t1', 't2'])
    expect(out).toEqual([{ tagId: 't1', bucket: 'b', kind: 'bucket', path: '' }])
    const [url] = spy.mock.calls[0]
    const u = new URL(String(url), 'http://x')
    expect(u.pathname).toBe('/api/internal/storage/c1/tags/search')
    expect(u.searchParams.getAll('tagId')).toEqual(['t1', 't2'])
  })
})
