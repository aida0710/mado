/** 名前の頭文字 (2 文字まで)。上部バーの丸い印に出す。二語以上なら各語の頭、一語なら先頭の二文字。 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1
    ? words.slice(0, 2).map(word => [...word][0])
    : [...(words[0] ?? '')].slice(0, 2)
  return letters.join('').toUpperCase()
}
