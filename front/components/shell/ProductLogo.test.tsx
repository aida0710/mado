import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { PRODUCT_FULL_NAME, ProductLogo } from './ProductLogo'

describe('ProductLogo', () => {
  it('窓の印に続けて、mado と太字の S3 Data Catalog を表示する', () => {
    const { container } = render(<p><ProductLogo /></p>)
    expect(container.textContent).toBe(PRODUCT_FULL_NAME)
    expect(container.querySelector('strong')?.textContent).toBe('S3 Data Catalog')
    expect(container.querySelector('.product-prefix')?.textContent).toBe('mado')
  })

  it('印は読み上げない', () => {
    const { container } = render(<ProductLogo />)
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })
})
