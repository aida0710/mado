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

  // 危険要素タグそのものが DOM に出ないこと。default schema が許可してない。
  it.each<[string, string]>([
    ['iframe srcdoc',          '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['style block',            '<style>body{display:none}</style>'],
    ['base href',              '<base href="//attacker.example.com">'],
    ['embed',                  '<embed src="data:text/html,<script>alert(1)</script>">'],
    ['object',                 '<object data="data:text/html,x"></object>'],
    ['form',                   '<form action="//attacker"><input name="x"></form>'],
    ['inline script',          '<script>alert(1)</script>'],
    ['svg with onload',        '<svg onload="alert(1)"><circle r="5"/></svg>'],
    ['link rel stylesheet',    '<link rel="stylesheet" href="//attacker/css">'],
    ['meta refresh',           '<meta http-equiv="refresh" content="0;url=//attacker">'],
    ['math (MathML)',          '<math><mtext><script>alert(1)</script></mtext></math>'],
    ['HTML comment with tag',  '<!--><script>alert(1)</script><!-->'],
  ])('%s が DOM に出ない', (_label, body) => {
    const { container } = renderSanitized(body)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('style')).toBeNull()
    expect(container.querySelector('base')).toBeNull()
    expect(container.querySelector('embed')).toBeNull()
    expect(container.querySelector('object')).toBeNull()
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('link')).toBeNull()
    expect(container.querySelector('meta')).toBeNull()
    expect(container.querySelector('math')).toBeNull()
  })

  // イベントハンドラ属性は通常タグでも剥がれること。
  it.each<[string, string]>([
    ['img onerror',     '<img src="x" onerror="alert(1)">'],
    ['a onclick',       '<a href="https://example.com" onclick="alert(1)">x</a>'],
    ['p onmouseover',   '<p onmouseover="alert(1)">x</p>'],
    ['details ontoggle','<details ontoggle="alert(1)"><summary>x</summary>y</details>'],
  ])('%s のイベントハンドラ属性が剥がれる', (_label, body) => {
    const { container } = renderSanitized(body)
    const all = container.querySelectorAll('*')
    for (const el of all) {
      for (const attr of el.getAttributeNames()) {
        // on* 属性は一切残ってはならない
        expect(attr.startsWith('on')).toBe(false)
      }
    }
  })

  // href / src の javascript: スキームが無害化されること (anchor の場合は属性ごと削除、
  // または href 自体が無害な値に書き換わる)。
  it('a href="javascript:..." が実行可能 URL として残らない', () => {
    const { container } = renderSanitized('<a href="javascript:alert(1)">x</a>')
    const a = container.querySelector('a')
    if (a) {
      const href = a.getAttribute('href') ?? ''
      expect(href.toLowerCase().startsWith('javascript:')).toBe(false)
    }
  })

  it('img src="javascript:..." が実行可能 URL として残らない', () => {
    const { container } = renderSanitized('<img src="javascript:alert(1)">')
    const img = container.querySelector('img')
    if (img) {
      const src = img.getAttribute('src') ?? ''
      expect(src.toLowerCase().startsWith('javascript:')).toBe(false)
    }
  })

  it('markdown link の javascript: スキームも無害化される', () => {
    const { container } = renderSanitized('[click me](javascript:alert(1))')
    const a = container.querySelector('a')
    if (a) {
      const href = a.getAttribute('href') ?? ''
      expect(href.toLowerCase().startsWith('javascript:')).toBe(false)
    }
  })

  // style 属性のインライン CSS で外部 URL を読み込ませる試み。default schema が style 属性を
  // 許可していないので残らない。
  it('style 属性 (background:url(...)) が剥がれる', () => {
    const { container } = renderSanitized('<p style="background:url(javascript:alert(1))">x</p>')
    expect(container.querySelector('p')?.getAttribute('style')).toBeFalsy()
  })

  it('通常 markdown は引き続きレンダリングされる', () => {
    const { container } = renderSanitized('# Hello\n\n[link](https://example.com)')
    // h1 (見出しアンカーが内側に挿入されるため textContent ではなく includes で見る)
    expect(container.querySelector('h1')?.textContent).toContain('Hello')
    // markdown 由来の link が href 付きで存在する (heading の自己アンカーではなく)
    expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull()
  })
})
