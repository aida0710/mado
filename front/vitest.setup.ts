import '@testing-library/jest-dom'

// jsdom には matchMedia が無い。テストはすべて desktop (>= sm) 想定で書かれて
// いるので、どのクエリに対しても matches=true を返す no-op を入れる。
// 個別テストで mobile 表示が要るときは spyOn して上書きする。
;(globalThis as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
  ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia

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

// jsdom には ResizeObserver も無い。ReadmeView の折りたたみ判定などが生成するので
// 観測を受け流す no-op を入れる。サイズ変化に応じた再判定が要るテストでは
// spyOn して上書きする想定。
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  MockResizeObserver as unknown as typeof ResizeObserver
