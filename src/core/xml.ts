// A small XML reader, shared by the PLCopen import (plc/exchange/importXml.ts) and the URDF import (core/urdf.ts).
//
// Hand-written so core and plc carry no runtime dependency, and because the files read here use a narrow slice of
// XML. It handles namespace prefixes, comments, CDATA, self-closing tags, both quote styles and the five named
// entities plus numeric ones. DTDs and processing instructions are skipped.

export interface XmlNode {
  /** local name, any namespace prefix stripped: `<tc6:pou>` and `<pou>` are the same element */
  name: string
  /** the namespace prefix as written (`xacro` for `<xacro:if>`), absent without one. The xacro expander tells its own
   *  elements by it; readers of plain formats ignore it. */
  prefix?: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** character data directly inside this element, entities decoded */
  text: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)))
    return ENTITIES[body] ?? whole // an unknown entity stays as written rather than vanishing
  })
}

/** Parse a document into its root element. Throws on malformed input, each message starting with `what` (the
 *  reader the caller is, so the error names the import that failed). */
export function parseXml(src: string, what = 'XML'): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0

  const top = (): XmlNode => stack[stack.length - 1]!

  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break
    if (lt > i) top().text += decodeEntities(src.slice(i, lt))

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      top().text += src.slice(lt + 9, end < 0 ? src.length : end) // CDATA is literal, no decoding
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? src.length : end + 1
      continue
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt)
      if (end < 0) throw new Error(`${what}: unterminated closing tag`)
      if (stack.length > 1) stack.pop()
      i = end + 1
      continue
    }

    // an opening (possibly self-closing) tag
    const end = findTagEnd(src, lt)
    if (end < 0) throw new Error(`${what}: unterminated tag`)
    const raw = src.slice(lt + 1, end)
    const selfClosing = raw.endsWith('/')
    const inner = selfClosing ? raw.slice(0, -1) : raw
    const nameMatch = /^\s*([^\s/>]+)/.exec(inner)
    if (!nameMatch) throw new Error(`${what}: tag with no name`)
    const qname = nameMatch[1]!
    const colon = qname.indexOf(':')
    const node: XmlNode = {
      name: localName(qname),
      ...(colon > 0 ? { prefix: qname.slice(0, colon) } : {}),
      attrs: readAttrs(inner.slice(nameMatch[0].length)),
      children: [],
      text: '',
    }
    top().children.push(node)
    if (!selfClosing) stack.push(node)
    i = end + 1
  }

  const el = root.children.find((c) => !c.name.startsWith('#'))
  if (!el) throw new Error(`${what}: no root element - is this an XML file?`)
  return el
}

/** The `>` that closes a tag, skipping any inside a quoted attribute value. */
function findTagEnd(src: string, from: number): number {
  let quote = ''
  for (let i = from + 1; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i
  }
  return -1
}

function localName(qname: string): string {
  const colon = qname.indexOf(':')
  return colon < 0 ? qname : qname.slice(colon + 1)
}

function readAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  for (let m = re.exec(s); m; m = re.exec(s)) {
    attrs[localName(m[1]!)] = decodeEntities(m[3] ?? m[4] ?? '')
  }
  return attrs
}

/** The child elements of `n` named `name`. */
export const xmlKids = (n: XmlNode | undefined, name: string): XmlNode[] => (n?.children ?? []).filter((c) => c.name === name)

/** The first child element of `n` named `name`. */
export const xmlKid = (n: XmlNode | undefined, name: string): XmlNode | undefined => xmlKids(n, name)[0]
