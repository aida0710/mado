// 背景の相対輝度 (WCAG 近似) から文字色を白/黒に自動判定する。
// #RRGGBB 形式のみを想定 (storage-tags API がこの形式のみ許可するため)。
function contrastTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#000000' : '#ffffff'
}

interface Props {
  tag: { name: string; color: string }
}

export function TagBadge({ tag }: Props) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium leading-none"
      style={{
        backgroundColor: tag.color,
        color: contrastTextColor(tag.color),
        letterSpacing: '0.01em',
      }}
    >
      {tag.name}
    </span>
  )
}
