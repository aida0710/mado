import { describe, expect, it } from 'vitest'
import { renderPrometheusText } from './prometheus-exposition.js'

describe('renderPrometheusText', () => {
  it('familyごとにHELPとTYPEを書き、sampleを続ける', () => {
    const body = renderPrometheusText([{
      name: 'mado_example', help: 'Example value.', type: 'gauge',
      samples: [{ labels: { bucket: 'dataset' }, value: '9007199254740993' }],
    }])
    expect(body).toBe([
      '# HELP mado_example Example value.',
      '# TYPE mado_example gauge',
      'mado_example{bucket="dataset"} 9007199254740993',
      '',
    ].join('\n'))
  })

  it('label値のバックスラッシュ・改行・二重引用符をエスケープする', () => {
    const body = renderPrometheusText([{
      name: 'mado_example', help: 'Example.', type: 'gauge',
      samples: [{ labels: { bucket: 'new"\\\nbucket' }, value: 1 }],
    }])
    expect(body).toContain('mado_example{bucket="new\\"\\\\\\nbucket"} 1')
  })

  it('labelのないsampleは波括弧を付けない', () => {
    expect(renderPrometheusText([{
      name: 'mado_example', help: 'Example.', type: 'counter', samples: [{ labels: {}, value: 3 }],
    }])).toContain('\nmado_example 3\n')
  })

  it('sampleのないfamilyもHELPとTYPEだけを出して改行で終える', () => {
    const body = renderPrometheusText([{ name: 'mado_example', help: 'Example.', type: 'gauge', samples: [] }])
    expect(body).toBe('# HELP mado_example Example.\n# TYPE mado_example gauge\n')
  })
})
