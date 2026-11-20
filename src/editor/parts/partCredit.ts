// Who made a part, as the editor shows it (core/parts/partPackage.ts PartCredit): under the Inspector's header and in a
// Parts dock card's tooltip. A copy from a part library carries its credit. A part the app ships, and one made in
// this project, carry none.

import { PROJECT_CREDIT_URL } from '../../core/parts/partLibrary'
import type { PartPackage } from '../../core/parts/partPackage'

/** Who made `pkg`, in words, and a link to them when it is one the app knows: a GitHub page or the project's site. */
export function partCreditLine(pkg: Pick<PartPackage, 'id' | 'credit'> | undefined): { by?: string; from: string; url?: string } | null {
  if (!pkg) return null
  const c = pkg.credit
  if (c) {
    // a credit can come from any part file, so only links to where publishers live are followed
    const url = c.url && (/^https:\/\/github\.com\/[A-Za-z0-9-]+$/.test(c.url) || c.url === PROJECT_CREDIT_URL) ? c.url : undefined
    return { ...(c.by ? { by: c.by } : {}), from: c.library, ...(url ? { url } : {}) }
  }
  return null
}

/** The credit as one line of text, for a tooltip: "by jdoe, from Community". */
export function partCreditText(pkg: Pick<PartPackage, 'id' | 'credit'> | undefined): string {
  const line = partCreditLine(pkg)
  if (!line) return ''
  return line.by ? `by ${line.by}, from ${line.from}` : `from ${line.from}`
}
