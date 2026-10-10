// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { BREAKPOINT_PX } from '../lib/breakpoints'

// 色・余白の値は @mado/design-tokens の変数を使い、画面幅の切り替え点も Mado Model Tracking と
// 揃える、という決まりを styles/ と App.css に対して確かめる。
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const stylesDirectory = new URL('./', import.meta.url)
const appStylesheets = [
  ...readdirSync(stylesDirectory)
    .filter(name => name.endsWith('.css'))
    .map(name => ({ name: `styles/${name}`, css: withoutComments(readFileSync(new URL(name, stylesDirectory), 'utf8')) })),
  { name: 'App.css', css: withoutComments(readFileSync(new URL('../App.css', import.meta.url), 'utf8')) },
]
const resolvePackageFile = createRequire(import.meta.url).resolve
const packageCss = ['tokens.css', 'base.css', 'components.css', 'shell.css', 'code.css']
  .map(name => withoutComments(readFileSync(resolvePackageFile(`@mado/design-tokens/${name}`), 'utf8')))
  .join('\n')

// 画面の部品が style 属性で書く変数: ドックの高さ (BottomDock)、プレビューのドロワーの幅 (useDrawerResize)。
const PROPERTIES_SET_FROM_COMPONENTS = ['--bottom-dock-height', '--drawer-track', '--drawer-w', '--drawer-ml']
const LITERAL_COLOR =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![\w-])(?:white|black)(?![\w-])/i

const declarations = (css: string) =>
  [...css.matchAll(/((?:--)?[a-z][\w-]*)\s*:\s*([^;{}]+);/gi)].map(match => ({
    property: match[1]!,
    value: match[2]!.trim(),
  }))
const definedProperties = (css: string) =>
  declarations(css).map(({ property }) => property).filter(property => property.startsWith('--'))
const ruleBodies = (css: string, selector: string) =>
  [...css.matchAll(new RegExp(`${selector.replace(/[[\]().'=]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))]
    .map(match => match[1]!)
    .join('\n')

describe('design tokens (mado)', () => {
  it('色は値で書かず変数を使う。値を持つのは :root で決める色の変数だけ', () => {
    const offending = appStylesheets.flatMap(({ name, css }) =>
      declarations(css)
        .filter(({ property, value }) => !property.startsWith('--') && LITERAL_COLOR.test(value))
        .map(({ property, value }) => `${name}: ${property}: ${value}`),
    )
    expect(offending).toEqual([])
  })

  it('自前で値を決めた色の変数は、ダークテーマの値も決めている', () => {
    const offending = appStylesheets.flatMap(({ name, css }) => {
      const light = definedProperties(ruleBodies(css, ':root')).filter(property =>
        declarations(ruleBodies(css, ':root')).some(item => item.property === property && LITERAL_COLOR.test(item.value)))
      const dark = new Set(definedProperties(ruleBodies(css, ":root[data-theme='dark']")))
      return light.filter(property => !dark.has(property)).map(property => `${name}: ${property}`)
    })
    expect(offending).toEqual([])
  })

  it('参照する変数はどれも定義されている', () => {
    const defined = new Set([
      ...definedProperties(packageCss),
      ...appStylesheets.flatMap(({ css }) => definedProperties(css)),
      ...PROPERTIES_SET_FROM_COMPONENTS,
    ])
    const undefinedReferences = appStylesheets.flatMap(({ name, css }) =>
      [...css.matchAll(/var\((--[\w-]+)/g)]
        .map(match => match[1]!)
        .filter(property => !defined.has(property))
        .map(property => `${name}: ${property}`),
    )
    expect(undefinedReferences).toEqual([])
  })

  it('メディアクエリは Mado Model Tracking と同じ 3 つの切り替え点だけを使う', () => {
    const allowed = new Set(Object.values(BREAKPOINT_PX).map(px => `(width < ${px}px)`))
    const offending = appStylesheets.flatMap(({ name, css }) =>
      [...css.matchAll(/@media\s+([^{]*?)\s*\{/g)]
        .map(match => match[1]!)
        .filter(query => !query.startsWith('(prefers-') && !allowed.has(query))
        .map(query => `${name}: ${query}`),
    )
    expect(offending).toEqual([])
  })
})
