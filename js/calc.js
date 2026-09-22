/*
 * rplanif — evaluador aritmético de la minicalculadora.
 *
 * Acepta + - * / (también × ÷), paréntesis, signo unario y decimales con punto o
 * coma. No usa eval(): tokeniza y aplica precedencia (shunting-yard). Cualquier
 * entrada inválida devuelve null.
 */
(function (root) {
  'use strict';

  var PREC = { '+': 1, '-': 1, '*': 2, '/': 2, 'neg': 3 };

  function tokenize(text) {
    var src = String(text).replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
    var tokens = [];
    var i = 0;
    while (i < src.length) {
      var ch = src[i];
      if (ch === ' ' || ch === '\t') { i++; continue; }
      if (/[0-9.]/.test(ch)) {
        var j = i;
        while (j < src.length && /[0-9.]/.test(src[j])) j++;
        var num = src.slice(i, j);
        if (!/^(\d+\.?\d*|\.\d+)$/.test(num)) return null;
        tokens.push({ t: 'num', v: parseFloat(num) });
        i = j;
        continue;
      }
      if ('+-*/()'.indexOf(ch) >= 0) { tokens.push({ t: ch }); i++; continue; }
      return null;
    }
    return tokens;
  }

  // Infijo → postfijo, distinguiendo el menos unario del binario.
  function toPostfix(tokens) {
    var out = [], ops = [];
    var prev = null; // último token emitido, para saber si un '-' es unario
    for (var k = 0; k < tokens.length; k++) {
      var tk = tokens[k];
      if (tk.t === 'num') {
        if (prev && (prev.t === 'num' || prev.t === ')')) return null; // "2 3"
        out.push(tk);
      } else if (tk.t === '(') {
        if (prev && (prev.t === 'num' || prev.t === ')')) return null;
        ops.push(tk);
      } else if (tk.t === ')') {
        if (!prev || prev.t === '(' || isOp(prev)) return null;
        while (ops.length && ops[ops.length - 1].t !== '(') out.push(ops.pop());
        if (!ops.length) return null;
        ops.pop();
      } else {
        var op = tk.t;
        var unary = !prev || prev.t === '(' || isOp(prev);
        if (unary) {
          if (op === '-') op = 'neg';
          else if (op === '+') { prev = tk; continue; } // "+3" → 3
          else return null;
        }
        while (ops.length) {
          var top = ops[ops.length - 1];
          if (top.t === '(') break;
          // 'neg' es asociativo a derecha: no desapila otro 'neg'
          if (PREC[top.t] > PREC[op] || (PREC[top.t] === PREC[op] && op !== 'neg')) out.push(ops.pop());
          else break;
        }
        ops.push({ t: op });
      }
      prev = tk;
    }
    if (!prev || prev.t === '(' || isOp(prev)) return null;
    while (ops.length) {
      var o = ops.pop();
      if (o.t === '(') return null;
      out.push(o);
    }
    return out;
  }

  function isOp(tk) { return tk.t === '+' || tk.t === '-' || tk.t === '*' || tk.t === '/' || tk.t === 'neg'; }

  function run(postfix) {
    var st = [];
    for (var k = 0; k < postfix.length; k++) {
      var tk = postfix[k];
      if (tk.t === 'num') { st.push(tk.v); continue; }
      if (tk.t === 'neg') { if (!st.length) return null; st.push(-st.pop()); continue; }
      if (st.length < 2) return null;
      var b = st.pop(), a = st.pop();
      switch (tk.t) {
        case '+': st.push(a + b); break;
        case '-': st.push(a - b); break;
        case '*': st.push(a * b); break;
        case '/': if (b === 0) return null; st.push(a / b); break;
      }
    }
    if (st.length !== 1 || !isFinite(st[0])) return null;
    return st[0];
  }

  function evaluate(text) {
    if (!String(text || '').trim()) return null;
    var tokens = tokenize(text);
    if (!tokens || !tokens.length) return null;
    var postfix = toPostfix(tokens);
    if (!postfix) return null;
    var value = run(postfix);
    if (value === null) return null;
    return Math.round(value * 1e10) / 1e10; // evita 0.30000000000000004
  }

  var api = { evaluate: evaluate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RPlanif = Object.assign(root.RPlanif || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
