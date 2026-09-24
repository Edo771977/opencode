export function parseSessionTitle(title: string) {
  const separator = title.indexOf("|")
  if (separator === -1) return { displayTitle: title }

  const group = title.slice(0, separator).trim()
  const displayTitle = title.slice(separator + 1).trim()
  if (!group) return { displayTitle: displayTitle || title }
  if (!displayTitle) return { displayTitle: title }

  return { group: group.charAt(0).toUpperCase() + group.slice(1), displayTitle }
}
