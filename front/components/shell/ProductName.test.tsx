import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { PRODUCT_FULL_NAME, ProductName } from './ProductName'

describe('ProductName', () => {
  it('mado に続けて S3 Data Catalog を太字で表示する', () => {
    const { container } = render(<p><ProductName /></p>)
    expect(container.textContent).toBe(PRODUCT_FULL_NAME)
    expect(container.querySelector('strong')?.textContent).toBe('S3 Data Catalog')
    expect(container.querySelector('.product-prefix')?.textContent).toBe('mado')
  })
})
