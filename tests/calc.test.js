'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../js/calc.js');

test('calc: operaciones básicas con precedencia', () => {
  assert.equal(evaluate('2+3'), 5);
  assert.equal(evaluate('10-4-3'), 3);
  assert.equal(evaluate('2+3*4'), 14);
  assert.equal(evaluate('(2+3)*4'), 20);
  assert.equal(evaluate('21/4'), 5.25);
  assert.equal(evaluate('9+13+15+21'), 58);
  assert.equal(evaluate('(9+13+15+21)/4'), 14.5);
});

test('calc: unario, decimales con coma o punto, símbolos × ÷ y espacios', () => {
  assert.equal(evaluate('-3+5'), 2);
  assert.equal(evaluate('2*-3'), -6);
  assert.equal(evaluate('-(2+3)'), -5);
  assert.equal(evaluate('1,5+1.5'), 3);
  assert.equal(evaluate(' 8 × 2 ÷ 4 '), 4);
});

test('calc: errores devuelven null, nunca tiran ni ejecutan código', () => {
  assert.equal(evaluate(''), null);
  assert.equal(evaluate('2+'), null);
  assert.equal(evaluate('(2+3'), null);
  assert.equal(evaluate('2+3)'), null);
  assert.equal(evaluate('abc'), null);
  assert.equal(evaluate('alert(1)'), null);
  assert.equal(evaluate('1/0'), null);
  assert.equal(evaluate('2 3'), null);
});

test('calc: redondeo de coma flotante', () => {
  assert.equal(evaluate('0.1+0.2'), 0.3);
  assert.equal(evaluate('10/3'), 3.3333333333);
});
