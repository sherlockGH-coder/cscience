import {
  walk, sourceOf, findProperty, hasLiteral, hasLiteralMatching,
  hasRegexLiteral, findEnclosingFunction, ifThrowContainsMessage,
  throwContainsMessage, extractStringFromExpr,
} from './util/walk.mjs';

const BYOK_AUTH_RESPONSE = [
  'authenticated:!0',
  'account_uuid:"byok-local"',
  'email:"byok@local"',
  'provider:"api_key"',
  'org_uuid:null',
  'org_name:null',
  'org_slug:null',
  'subscription_type:"pro"',
  'rate_limit_tier:"scale"',
  'billing_type:null',
  'billing_resolved:true',
  'tier_unmappable:false',
  'allow_safety_feedback:null',
  'restart_pending:x',
  'reauth_required:false',
  'oauth_stale:false',
  'dangerously_skip_approvals:Y',
].join(',');

const GROWTHBOOK_FLAGS = [
  'operon_keepalive_enabled:true',
  'operon_rolling_compact_enabled:true',
  'operon_delegation_enabled:true',
  'operon_provenance_auto_extract:true',
  'operon_routines_enabled:true',
  'operon_memory_enabled:true',
  'hcls_bundled_visible:true',
  'copper_meridian_gate:true',
  'copper_meridian_path:"/"',
  'copper_meridian_rollout:100',
  'copper_meridian_cross_org_import:true',
  'operon_onboarding_perms_variant:"default"',
  'operon_sentry_error_reporting:false',
].join(',');

const OPERON_MODELS_INJECT = [
  'let _cm=process.env.OPERON_MODELS?.trim();',
  'if(_cm){try{return JSON.parse(_cm)}',
  'catch{return _cm.split(",").map(m=>{',
  'let p=m.trim().split(":");',
  'return{id:p[0],name:p[1]||p[0]}})}}',
].join('');

const ENV_CRED_FALLBACK = [
  '{let _k=process.env.ANTHROPIC_API_KEY?.trim(),',
  '_t=process.env.ANTHROPIC_AUTH_TOKEN?.trim();',
  'if(_k||_t)return{api_key:_k||null,auth_token:_t||null,source:"env"};',
  'throw Error("No credentials. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.")}',
].join('');

export const PATCHES = [
  {
    id: 'P1',
    name: 'oauth-gate-bypass',
    description: 'Allow API key when OAuth token is absent',
    match(node, code, parent) {
      return ifThrowContainsMessage(node, 'This build requires signing in');
    },
    replace(node, code, ast) {
      const fn = findEnclosingFunction(ast, code, node.start);
      const apiKeyArg = fn?.params?.[0]?.name ?? 'z';
      const authTokenArg = fn?.params?.[1]?.name ?? 'O';
      return {
        start: node.start,
        end: node.end,
        code: `if(!${authTokenArg}&&!${apiKeyArg}){let _k=process.env.ANTHROPIC_API_KEY?.trim();if(_k)${apiKeyArg}=_k}`,
      };
    },
    matchApplied(node) {
      if (node.type !== 'IfStatement') return false;
      return hasLiteral(node, 'ANTHROPIC_API_KEY');
    },
  },
  {
    id: 'P2',
    name: 'credential-resolver-env',
    description: 'Fallback to env vars when OAuth credential resolver fails',
    match(node, code) {
      return throwContainsMessage(node, 'No credentials available for Anthropic API');
    },
    replace(node) {
      return { start: node.start, end: node.end, code: ENV_CRED_FALLBACK };
    },
    matchApplied(node) {
      if (node.type !== 'ThrowStatement') return false;
      const msg = extractStringFromExpr(node.argument);
      return msg !== null && msg.includes('Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN');
    },
  },
  {
    id: 'P3',
    name: 'https-enforcement-relaxed',
    description: 'Allow HTTP base URL for custom proxies',
    match(node, code) {
      return ifThrowContainsMessage(node, 'ANTHROPIC_BASE_URL must be https');
    },
    replace(node, code) {
      const testExpr = sourceOf(node.test, code);
      return {
        start: node.start,
        end: node.end,
        code: `if(${testExpr})console.warn("[BYOK] ANTHROPIC_BASE_URL is plain http to non-loopback");`,
      };
    },
    matchApplied(node) {
      if (node.type !== 'IfStatement') return false;
      return hasLiteral(node, '[BYOK] ANTHROPIC_BASE_URL is plain http to non-loopback');
    },
  },
  {
    id: 'P4',
    name: 'auth-status-bypass',
    description: 'Return authenticated:true when no OAuth session',
    match(node) {
      if (node.type !== 'IfStatement') return false;
      const cons = node.consequent;
      const ret = cons?.type === 'ReturnStatement' ? cons :
                  cons?.type === 'BlockStatement' ? cons.body?.find(s => s.type === 'ReturnStatement') : null;
      if (!ret?.argument || ret.argument.type !== 'ObjectExpression') return false;
      const props = ret.argument.properties;
      const authProp = findProperty(ret.argument, 'authenticated');
      if (!authProp) return false;
      const val = authProp.value;
      if (!(val?.type === 'UnaryExpression' && val.operator === '!' && val.argument?.value === 1)) return false;
      return !!findProperty(ret.argument, 'subscription_type') && props.length <= 6;
    },
    replace(node, code) {
      const testExpr = sourceOf(node.test, code);
      return { start: node.start, end: node.end, code: `if(${testExpr})return{${BYOK_AUTH_RESPONSE}};` };
    },
    matchApplied(node) {
      if (node.type !== 'IfStatement') return false;
      if (node.consequent?.type !== 'ReturnStatement') return false;
      const arg = node.consequent.argument;
      return arg?.type === 'ObjectExpression' && !!findProperty(arg, 'account_uuid');
    },
  },
  {
    id: 'P5',
    name: 'growthbook-flags-hardcode',
    description: 'Hardcode feature flags as enabled',
    _target: null,
    preScan(ast) {
      walk(ast, (fn) => {
        if (fn.type !== 'FunctionDeclaration') return;
        if (!hasLiteralMatching(fn, n => typeof n.value === 'string' && n.value.includes('growthbook'))) return;
        walk(fn, (inner) => {
          if (inner.type === 'CallExpression' && inner.arguments?.length === 1 &&
              inner.arguments[0]?.type === 'ObjectExpression' && inner.arguments[0].properties.length === 0 &&
              inner.callee?.type === 'Identifier')
            this._target = inner;
        });
      });
    },
    match(node) {
      return this._target !== null && node === this._target;
    },
    replace(node) {
      const emptyObj = node.arguments[0];
      return { start: emptyObj.start, end: emptyObj.end, code: `{${GROWTHBOOK_FLAGS}}` };
    },
    matchApplied(node) {
      if (node.type !== 'ObjectExpression') return false;
      return !!findProperty(node, 'operon_keepalive_enabled');
    },
  },
  {
    id: 'P6',
    name: 'models-error-downgrade',
    description: 'Show fallback models instead of auth error',
    match(node) {
      return node.type === 'Literal' && typeof node.value === 'string' &&
             node.value.includes('Not signed in, or your session has expired');
    },
    replace(node) {
      return { start: node.start, end: node.end, code: '"Using API key auth - showing default models."' };
    },
    matchApplied(node) {
      return node.type === 'Literal' && node.value === 'Using API key auth - showing default models.';
    },
  },
  {
    id: 'P7',
    name: 'provider-restriction-remove',
    description: 'Remove anthropic-only provider check',
    match(node) {
      if (node.type !== 'IfStatement') return false;
      if (node.consequent?.type !== 'ThrowStatement') return false;
      let hasProviderNotFound = false, hasAnthropicArray = false;
      walk(node, (n) => {
        if (n.type === 'TemplateLiteral') {
          const raw = n.quasis.map(q => q.value.raw).join('');
          if (raw.includes('Provider') && raw.includes('not found')) hasProviderNotFound = true;
        }
        if (n.type === 'Literal' && typeof n.value === 'string' &&
            n.value.includes('Provider') && n.value.includes('not found'))
          hasProviderNotFound = true;
        if (n.type === 'ArrayExpression')
          n.elements?.forEach(e => { if (e?.type === 'Literal' && e.value === 'anthropic') hasAnthropicArray = true; });
      });
      return hasProviderNotFound && hasAnthropicArray;
    },
    replace(node) {
      return { start: node.start, end: node.end, code: 'if(false);' };
    },
    matchApplied(node) {
      if (node.type !== 'IfStatement') return false;
      return node.test?.type === 'Literal' && node.test.value === false;
    },
  },
  {
    id: 'P8',
    name: 'operon-models-env',
    description: 'Support OPERON_MODELS env var for custom model list',
    match(node) {
      if (node.type !== 'FunctionDeclaration' || !node.async) return false;
      return hasLiteral(node, '(rejected-base-url)') &&
             hasLiteralMatching(node, n => typeof n.value === 'string' && n.value.includes('models'));
    },
    replace(node) {
      const bodyStart = node.body.start + 1;
      return { start: bodyStart, end: bodyStart, code: OPERON_MODELS_INJECT };
    },
    matchApplied(node) {
      if (node.type !== 'FunctionDeclaration' || !node.async) return false;
      let found = false;
      walk(node, (n) => {
        if (n.type === 'MemberExpression' && n.property?.type === 'Identifier' && n.property.name === 'OPERON_MODELS')
          found = true;
      });
      return found;
    },
  },
  {
    id: 'P9',
    name: 'model-filter-disable',
    description: 'Remove claude- prefix requirement for model IDs',
    match(node) {
      if (node.type !== 'FunctionDeclaration') return false;
      if (node.params.length !== 1) return false;
      return hasLiteralMatching(node, n =>
        n.type === 'Literal' && n.regex?.pattern === '^claude-' && n.regex?.flags === 'i'
      );
    },
    replace(node) {
      const name = node.id?.name ?? '_';
      const param = node.params[0]?.name ?? 'z';
      return { start: node.start, end: node.end, code: `function ${name}(${param}){return/* cscience:P9 */!1}` };
    },
    matchApplied(node, _parent, code) {
      if (node.type !== 'FunctionDeclaration' || node.params.length !== 1) return false;
      return code.slice(node.start, node.end).includes('cscience:P9');
    },
  },
  {
    id: 'P10',
    name: 'fable-filter-disable',
    description: 'Remove fable/mythos model series block',
    match(node) {
      if (node.type !== 'FunctionDeclaration') return false;
      if (node.params.length !== 1) return false;
      return hasRegexLiteral(node, 'fable');
    },
    replace(node) {
      const name = node.id?.name ?? '_';
      const param = node.params[0]?.name ?? 'z';
      return { start: node.start, end: node.end, code: `function ${name}(${param}){return/* cscience:P10 */!1}` };
    },
    matchApplied(node, _parent, code) {
      if (node.type !== 'FunctionDeclaration' || node.params.length !== 1) return false;
      return code.slice(node.start, node.end).includes('cscience:P10');
    },
  },
  {
    id: 'P11',
    name: 'pid-daemon-recognition',
    description: 'Recognize .js/.ts extensions in daemon process detection',
    match(node) {
      if (node.type !== 'Literal' || !node.regex) return false;
      return node.regex.pattern?.includes('operon|claude-bioscience|claude-science') &&
             node.regex.pattern?.includes('(\\s|$)') &&
             !node.regex.pattern?.includes('\\.js|\\.ts');
    },
    replace(node) {
      const newPattern = node.regex.pattern.replace(
        '(operon|claude-bioscience|claude-science)(\\s|$)',
        '(operon|claude-bioscience|claude-science)(\\.js|\\.ts)?(\\s|$)'
      );
      return { start: node.start, end: node.end, code: `/${newPattern}/${node.regex.flags}` };
    },
    matchApplied(node) {
      if (node.type !== 'Literal' || !node.regex) return false;
      return node.regex.pattern?.includes('operon|claude-bioscience|claude-science') &&
             node.regex.pattern?.includes('\\.js|\\.ts');
    },
  },
  {
    id: 'P12',
    name: 'disable-require-token',
    description: 'Disable require_token enforcement to allow tokenless local access',
    match(node) {
      if (node.type !== 'IfStatement') return false;
      let found = false;
      walk(node, (n) => {
        if (found) return;
        if (n.type === 'TemplateLiteral') {
          const raw = n.quasis.map(q => q.value.raw).join('');
          if (raw.includes('disabling login auth')) found = true;
        }
        if (n.type === 'Literal' && typeof n.value === 'string' && n.value.includes('disabling login auth'))
          found = true;
      });
      return found;
    },
    replace(node) {
      return { start: node.start, end: node.end, code: '{}' };
    },
    matchApplied(node, parent, code) {
      if (node.type !== 'IfStatement') return false;
      const src = code.slice(node.start, node.end);
      return src === '{}';
    },
  },
  {
    id: 'P13',
    name: 'require-token-default-false',
    description: 'Change require_token default from true to false',
    match(node, code) {
      if (node.type !== 'Property') return false;
      const keyName = node.key?.name ?? node.key?.value;
      if (keyName !== 'require_token') return false;
      const valSrc = sourceOf(node.value, code);
      return valSrc.includes('.default(!0)');
    },
    replace(node, code) {
      const valSrc = sourceOf(node.value, code);
      const patched = valSrc.replace('.default(!0)', '.default(!1)');
      return { start: node.value.start, end: node.value.end, code: patched };
    },
    matchApplied(node, parent, code) {
      if (node.type !== 'Property') return false;
      const keyName = node.key?.name ?? node.key?.value;
      if (keyName !== 'require_token') return false;
      if (!code) return false;
      const valSrc = code.slice(node.value.start, node.value.end);
      return valSrc.includes('.default(!1)');
    },
  },
  {
    id: 'P14',
    required: true,
    name: 'custom-model-name-filter-disable',
    description: 'Keep custom provider models whose display names look like slugs',
    match(node) {
      if (node.type !== 'FunctionDeclaration') return false;
      if (node.params.length !== 1) return false;
      return hasRegexLiteral(node, 'Extended_Pictographic') &&
             hasRegexLiteral(node, '^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$');
    },
    replace(node) {
      const name = node.id?.name ?? '_';
      const param = node.params[0]?.name ?? 'z';
      return {
        start: node.start,
        end: node.end,
        code: `function ${name}(${param}){return/* cscience:P14 */!1}`,
      };
    },
    matchApplied(node, _parent, code) {
      if (node.type !== 'FunctionDeclaration' || node.params.length !== 1) return false;
      return code.slice(node.start, node.end).includes('cscience:P14');
    },
  },
];
