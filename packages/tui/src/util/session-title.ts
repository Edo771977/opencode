/**
 * A title written as "group | title" files the session under that group in the session list. Only the
 * first bar separates, so a title may still contain one; a side left empty means there is no group.
 */
export function parseSessionTitle(title: string) {
  const separator = title.indexOf("|")
  if (separator === -1) return { displayTitle: title }

  const group = title.slice(0, separator).trim()
  const displayTitle = title.slice(separator + 1).trim()
  if (!group || !displayTitle) return { displayTitle: title }

  return { group: group.charAt(0).toUpperCase() + group.slice(1), displayTitle }
}
