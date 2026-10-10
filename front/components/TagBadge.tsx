interface Props {
  tag: { name: string; color: string }
}

// タグは共通の小さなラベル (.status-badge) に、利用者が決めた色の点を添えて出す。
// 地と文字は共通の色に固定し、彩度の高い色 (#00ff00 など) でも読みやすさと行の重さを
// 一定に保つ。色を使うのは点だけなので、ダークテーマでも同じように読める。
//
// #RRGGBB 形式のみを想定 (storage-tags API がこの形式のみ許可する)。
export function TagBadge({ tag }: Props) {
  return (
    <span className="status-badge tag-badge">
      <TagColorDot color={tag.color} />
      {tag.name}
    </span>
  )
}

/** タグの色の点。名前が同じことを伝えるので読み上げない。 */
export function TagColorDot({ color }: { color: string }) {
  return <span className="tag-color-dot" style={{ backgroundColor: color }} aria-hidden="true" />
}
