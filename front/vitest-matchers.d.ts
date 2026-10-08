import 'vitest'
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

// jest-domの型拡張が旧Assertionを使うため、Vitest 5のMatchersにも同じ型を渡す。
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 宣言マージにはinterfaceが必要。
  interface Matchers<R extends void | Promise<void>, T> extends TestingLibraryMatchers<T, R> {}
}
