import { render } from '@testing-library/react'
import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'
import { describe, expect, it } from 'vitest'

// rehype-sanitize を passing したときに、危険な HTML 要素 (XSS 経路) が
// 描画 DOM に残らないことを確認する。ReadmeView.tsx と HomePage.tsx で
// 実際に使っているのと同じ呼び出し形 (rehypePlugins=[[rehypeSanitize]])。

describe('MDEditor.Markdown + rehype-sanitize はストアド XSS 要素を剥がす', () => {
  function renderSanitized(source: string) {
    return render(
      <MDEditor.Markdown source={source} rehypePlugins={[[rehypeSanitize]]} />,
    )
  }

  it.each<[string, string]>([
    ['iframe srcdoc',  '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['style block',    '<style>body{display:none}</style>'],
    ['base href',      '<base href="//attacker.example.com">'],
    ['embed',          '<embed src="data:text/html,<script>alert(1)</script>">'],
    ['object',         '<object data="data:text/html,x"></object>'],
    ['form',           '<form action="//attacker"><input name="x"></form>'],
    ['inline script',  '<script>alert(1)</script>'],
  ])('%s が DOM に出ない', (_label, body) => {
    const { container } = renderSanitized(body)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('style')).toBeNull()
    expect(container.querySelector('base')).toBeNull()
    expect(container.querySelector('embed')).toBeNull()
    expect(container.querySelector('object')).toBeNull()
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('通常 markdown は引き続きレンダリングされる', () => {
    const { container } = renderSanitized('# Hello\n\n[link](https://example.com)')
    // h1 (見出しアンカーが内側に挿入されるため textContent ではなく includes で見る)
    expect(container.querySelector('h1')?.textContent).toContain('Hello')
    // markdown 由来の link が href 付きで存在する (heading の自己アンカーではなく)
    expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull()
  })
})
