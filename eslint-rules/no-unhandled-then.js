// A promise chain whose result is thrown away (`p.then(f)` as a statement, or `void p.then(f)`) must end in a
// rejection handler. Without one a rejection is lost: a later step that waited on the chain never runs, and nothing
// is logged. typescript-eslint's no-floating-promises accepts `void` as "handled", so it misses these.
//
// The rule reads syntax only (no type information), so it stays fast and stays narrow: it looks only at a discarded
// call chain (an expression statement, or the operand of `void` anywhere) whose last link is `.then(...)` with fewer than two arguments, or `.finally(...)`. Such a chain is fine
// when a `.catch(...)` or a two-argument `.then(a, b)` comes after its last one-argument `.then`, with only
// `.finally(...)` links after that. A chain that is awaited, returned, assigned or passed on is someone else's to
// handle, and is not checked.

/** the method name and call of a `x.name(...)` or `x?.name(...)` call, else null */
function methodCall(node) {
  if (node?.type === 'ChainExpression') node = node.expression
  if (node?.type !== 'CallExpression') return null
  const callee = node.callee
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return null
  return { name: callee.property.name, call: node, object: callee.object }
}

/** true when the link handles a rejection of what came before it */
const handles = (link) => link.name === 'catch' || (link.name === 'then' && link.call.arguments.length >= 2)

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require a rejection handler on a discarded .then / .finally chain' },
    schema: [],
    messages: {
      unhandled:
        'This promise chain is discarded and has no rejection handler. Add .catch(...) after the last .then, or await / return it.',
    },
  },
  create(context) {
    function check(expr) {
      let link = methodCall(expr)
      if (!link || !(link.name === 'finally' || (link.name === 'then' && link.call.arguments.length < 2))) return
      // Walk from the outer end inward. Only `.finally` links may sit between the end and a handler.
      while (link) {
        if (handles(link)) return
        if (link.name !== 'finally') break
        link = methodCall(link.object)
      }
      context.report({ node: expr, messageId: 'unhandled' })
    }
    return {
      ExpressionStatement(node) {
        check(node.expression)
      },
      // `void` discards its operand wherever it stands: a statement, an arrow's body, a `return void ...`
      'UnaryExpression[operator="void"]'(node) {
        check(node.argument)
      },
    }
  },
}
