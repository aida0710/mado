interface Props {
  tag: { name: string; color: string }
}

// タグの色をそのまま面に塗ると、インク調 + ヘアライン罫のこの UI の中で
// 彩度の高いユーザー指定色 (#00ff00 等) が主役になってしまう。
// 色は面に 12% / 罫に 32% だけ乗せ、文字はインク色に固定する。
// 色による識別はできるまま、行の重さを一定に保つ狙い。
//
// #RRGGBB 形式のみを想定 (storage-tags API がこの形式のみ許可する)。
export function TagBadge({ tag }: Props) {
  return (
    <span
      className="inline-flex items-center rounded-1 px-1.5 py-px text-[10.5px] font-medium leading-[1.35] text-ink-11"
      style={{
        backgroundColor: `color-mix(in srgb, ${tag.color} 12%, var(--paper))`,
        border: `1px solid color-mix(in srgb, ${tag.color} 32%, var(--rule))`,
        letterSpacing: '0.01em',
      }}
    >
      {tag.name}
    </span>
  )
}
