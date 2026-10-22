import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rodarRotinas } from './rotinas.mjs';

test('falha de uma rotina nao impede a seguinte', () => {
  const feitas = [];
  const erros = [];
  const resultados = rodarRotinas([
    () => { throw new Error('expirar'); },
    () => { feitas.push('fila'); },
  ], (error) => erros.push(error.message));
  assert.deepEqual(resultados, [false, true]);
  assert.deepEqual(feitas, ['fila']);
  assert.deepEqual(erros, ['expirar']);
});
