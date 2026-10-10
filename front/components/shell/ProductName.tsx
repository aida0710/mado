/**
 * 製品名「mado S3 Data Catalog」。IBM の製品名と同じく、前の mado を通常の太さ、
 * 製品の部分を太字にする。上部バー・ドロワー・ログイン画面で同じ表記にそろえる。
 */
export const PRODUCT_PREFIX = 'mado'
export const PRODUCT_NAME = 'S3 Data Catalog'
/** 読み上げやタブの題名など、太さを付けられない場所で使う表記。 */
export const PRODUCT_FULL_NAME = `${PRODUCT_PREFIX} ${PRODUCT_NAME}`

export function ProductName() {
  return (
    <>
      <span className="product-prefix">{PRODUCT_PREFIX}</span> <strong>{PRODUCT_NAME}</strong>
    </>
  )
}
