import '@testing-library/jest-dom'

// jsdom には IntersectionObserver が無いので、観測だけ受け流す no-op モックを
// 入れる。実際の交差判定が要るテストでは spyOn して上書きする想定。
class MockIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
  root = null
  rootMargin = ''
  thresholds: ReadonlyArray<number> = []
}
;(globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver
