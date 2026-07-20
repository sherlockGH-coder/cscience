export function walk(node, cb, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (node.type) cb(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child)
        if (item?.type) walk(item, cb, node);
    } else if (child?.type) walk(child, cb, node);
  }
}

export function sourceOf(node, code) {
  return code.slice(node.start, node.end);
}

export function findProperty(objExpr, name) {
  if (objExpr?.type !== 'ObjectExpression') return null;
  return objExpr.properties.find(p =>
    (p.key?.type === 'Identifier' && p.key.name === name) ||
    (p.key?.type === 'Literal' && p.key.value === name)
  ) ?? null;
}

export function hasLiteral(node, value) {
  let found = false;
  walk(node, (n) => {
    if (found) return;
    if (n.type === 'Literal' && n.value === value) found = true;
  });
  return found;
}

export function hasLiteralMatching(node, predicate) {
  let found = false;
  walk(node, (n) => {
    if (found) return;
    if (n.type === 'Literal' && predicate(n)) found = true;
  });
  return found;
}

export function hasRegexLiteral(node, patternSubstr) {
  let found = false;
  walk(node, (n) => {
    if (found) return;
    if (n.type === 'Literal' && n.regex && n.regex.pattern?.includes(patternSubstr))
      found = true;
  });
  return found;
}

export function findEnclosingFunction(node, code, nodeStart) {
  let result = null;
  walk(node, (n) => {
    if (n.type === 'FunctionDeclaration' && n.start <= nodeStart && n.end >= nodeStart) {
      if (!result || n.start > result.start) result = n;
    }
  });
  return result;
}

export function extractStringFromExpr(expr) {
  if (!expr) return null;
  if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value;
  if (expr.type === 'TemplateLiteral')
    return expr.quasis.map(q => q.value.cooked ?? q.value.raw).join('');
  if (expr.type === 'NewExpression' || expr.type === 'CallExpression') {
    for (const arg of expr.arguments ?? []) {
      const s = extractStringFromExpr(arg);
      if (s) return s;
    }
  }
  if (expr.type === 'BinaryExpression' && expr.operator === '+') {
    const l = extractStringFromExpr(expr.left);
    const r = extractStringFromExpr(expr.right);
    if (l && r) return l + r;
    return l || r;
  }
  return null;
}

export function throwContainsMessage(node, substr) {
  if (node.type !== 'ThrowStatement') return false;
  const msg = extractStringFromExpr(node.argument);
  return msg !== null && msg.includes(substr);
}

export function ifThrowContainsMessage(node, substr) {
  if (node.type !== 'IfStatement') return false;
  const cons = node.consequent;
  if (!cons) return false;
  if (throwContainsMessage(cons, substr)) return true;
  if (cons.type === 'BlockStatement')
    return cons.body.some(s => throwContainsMessage(s, substr));
  return false;
}
