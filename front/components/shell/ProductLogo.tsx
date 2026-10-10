/**
 * 製品のロゴ。重なった2つの窓の印と、製品名「mado S3 Data Catalog」を並べる。
 * 名前は IBM の製品名と同じく、前の mado を通常の太さ、製品の部分を太字にする。
 * 上部バー・ドロワー・ログイン画面で同じ組み方にそろえる。
 */
export const PRODUCT_PREFIX = 'mado'
export const PRODUCT_NAME = 'S3 Data Catalog'
/** 読み上げやタブの題名など、太さを付けられない場所で使う表記。 */
export const PRODUCT_FULL_NAME = `${PRODUCT_PREFIX} ${PRODUCT_NAME}`

/**
 * 重なった2つの窓の印。手前の窓は文字と同じ色、奥の窓は強調色で描く。
 * 形はブラウザのタブのアイコン (public/mado-icon.svg) と同じ。色は common.css の .product-mark。
 */
export function MadoMark() {
  return (
    <svg className="product-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="product-mark-back" d="M8 2.75H21.25V16" />
      <rect className="product-mark-front" x="2.75" y="7" width="13.5" height="14.25" />
    </svg>
  )
}

export function ProductLogo() {
  return (
    <span className="product-logo">
      <MadoMark />
      <span>
        <span className="product-prefix">{PRODUCT_PREFIX}</span> <strong>{PRODUCT_NAME}</strong>
      </span>
    </span>
  )
}
