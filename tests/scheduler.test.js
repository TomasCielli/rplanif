'use strict';
// Ejecutar con:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, serialize, burstsToString, validateName } = require('../js/parser.js');
const { simulate } = require('../js/scheduler.js');

const EJEMPLO_1 = `
#Ejemplo 1
TAREA ''1'' PRIORIDAD=3
INICIO=0 [CPU,9]
TAREA ''2'' PRIORIDAD=2
INICIO=1 [CPU,5]
TAREA ''3'' PRIORIDAD=1
INICIO=2 [CPU,3]
TAREA ''4'' PRIORIDAD=2
INICIO=3 [CPU,7]
`;

const EJEMPLO_2 = `
#Ejemplo 2
RECURSO ''R1''
RECURSO ''R2''
RECURSO ''R3''
TAREA ''1'' INICIO=0
[CPU,3] [1,2] [CPU,2]
TAREA ''2'' INICIO=1
[CPU,2] [2,2] [CPU,2]
TAREA ''3'' INICIO=2
[CPU,2] [3,3] [CPU,1]
`;

const EJEMPLO_3 = `
#Ejemplo 3
RECURSO ''R1''
RECURSO ''R2''
TAREA ''1'' INICIO=0
[CPU,3] [1,3] [CPU,2]
TAREA ''2'' INICIO=1
[CPU,1] [1,2] [CPU,3]
TAREA ''3'' INICIO=2
[CPU,2] [2,3] [CPU,1]
`;

function run(text, cfg) {
  const def = parse(text);
  assert.deepEqual(def.errors, []);
  return simulate(def, cfg);
}

// Secuencia de CPU como string: quién ocupa la CPU en cada instante ('-' = ociosa)
function cpuString(res) {
  return res.cpuTimeline.map((pid) => (pid == null ? '-' : String(pid))).join('');
}

function cell(res, name, t) {
  const p = res.procs.find((p) => p.name === name);
  return p.timeline[t];
}

test('parser: ejemplo 1 (solo CPU, con prioridades)', () => {
  const def = parse(EJEMPLO_1);
  assert.deepEqual(def.errors, []);
  assert.equal(def.tasks.length, 4);
  assert.deepEqual(def.tasks[0], { name: '1', priority: 3, arrival: 0, bursts: [{ type: 'cpu', dur: 9 }] });
  assert.deepEqual(def.tasks[3], { name: '4', priority: 2, arrival: 3, bursts: [{ type: 'cpu', dur: 7 }] });
});

test('parser: ejemplo 2 resuelve recursos por índice', () => {
  const def = parse(EJEMPLO_2);
  assert.deepEqual(def.errors, []);
  assert.deepEqual(def.resources, ['R1', 'R2', 'R3']);
  assert.deepEqual(def.tasks[2].bursts, [
    { type: 'cpu', dur: 2 },
    { type: 'io', resource: 'R3', dur: 3 },
    { type: 'cpu', dur: 1 },
  ]);
});

test('parser: errores claros', () => {
  const def = parse(`TAREA ''X'' INICIO=0 [7,3]`);
  assert.ok(def.errors.some((e) => /recurso "7" no definido/.test(e)));
  assert.ok(parse('[CPU,3]').errors.some((e) => /fuera de una TAREA/.test(e)));
});

test('parser: nombres vacíos o con comillas dan un error explicativo', () => {
  assert.ok(parse(`TAREA '''' INICIO=0 [CPU,1]`).errors.some((e) => /nombre.*vac/i.test(e)));
  assert.ok(parse(`RECURSO ''''`).errors.some((e) => /nombre.*vac/i.test(e)));
  const withQuote = parse(`TAREA ''A'B'' INICIO=0 [CPU,1]`);
  assert.ok(withQuote.errors.some((e) => /comillas/.test(e)), withQuote.errors.join(' | '));
  assert.equal(validateName('A'), null);
  assert.equal(validateName(' '), 'El nombre no puede estar vacío');
  assert.match(validateName("A'B"), /comillas/);
  assert.match(validateName('A"B'), /comillas/);
});

test('una definición sin procesos es un estado vacío válido, no un error', () => {
  const def = parse('');
  assert.deepEqual(def, { resources: [], tasks: [], errors: [] });
  const withRes = parse(`RECURSO ''R1''`);
  assert.deepEqual(withRes.errors, []);
  assert.deepEqual(withRes.resources, ['R1']);
  const res = simulate(withRes, { algorithm: 'RR', quantum: 2 });
  assert.equal(res.totalTime, 0);
  assert.deepEqual(res.procs, []);
  assert.deepEqual(res.metrics, { tpr: 0, tpe: 0 });
});

test('serialize: código → tabla → código es idempotente (round trip)', () => {
  const def = parse(EJEMPLO_3);
  const code = serialize(def);
  assert.equal(code.split('\n').slice(0, 4).join('\n'),
    "RECURSO ''R1''\nRECURSO ''R2''\nTAREA ''1'' PRIORIDAD=0 INICIO=0\n[CPU,3] [R1,3] [CPU,2]");
  const again = parse(code);
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again, def);
  // el modelo de la tabla guarda las ráfagas como string
  assert.equal(burstsToString(def.tasks[1].bursts), '[CPU,1] [R1,2] [CPU,3]');
  assert.equal(serialize({ resources: ['R1'], tasks: [{ name: 'X', arrival: 2, priority: 1, bursts: '[CPU,4] [1,1]' }] }),
    "RECURSO ''R1''\nTAREA ''X'' PRIORIDAD=1 INICIO=2\n[CPU,4] [1,1]\n");
});

test('FIFO ejemplo 1', () => {
  const res = run(EJEMPLO_1, { algorithm: 'FIFO' });
  assert.equal(cpuString(res), '111111111222223334444444');
  assert.deepEqual(res.procs.map((p) => [p.tr, p.te]), [[9, 0], [13, 8], [15, 12], [21, 14]]);
  assert.equal(res.totalTime, 24);
  assert.equal(res.metrics.tpr, (9 + 13 + 15 + 21) / 4);
  assert.equal(res.metrics.tpe, (0 + 8 + 12 + 14) / 4);
});

test('SJF ejemplo 1 (no apropiativo)', () => {
  const res = run(EJEMPLO_1, { algorithm: 'SJF' });
  assert.equal(cpuString(res), '111111111333222224444444');
  assert.deepEqual(res.procs.map((p) => p.tr), [9, 16, 10, 21]);
});

test('SRTF ejemplo 1 (apropiativo)', () => {
  const res = run(EJEMPLO_1, { algorithm: 'SRTF' });
  // P1 0-1, P2 1-2, P3 2-5, P2 5-9, P4 9-16, P1 16-24
  assert.equal(cpuString(res), '123332222444444411111111');
  assert.deepEqual(res.procs.map((p) => p.tr), [24, 8, 3, 13]);
});

test('RR q=2 ejemplo 1 (default): el expulsado se ordena por desempate (llegada, PID) con los que entran en ese instante', () => {
  const res = run(EJEMPLO_1, { algorithm: 'RR', quantum: 2 });
  // t=2: P2 ya estaba en cola; entran P3 (llega en 2) y P1 expulsado (llegó en 0) → P1 antes que P3 → cola: P2,P1,P3
  assert.equal(cpuString(res), '112211334422113442114414');
  assert.deepEqual(res.procs.map((p) => p.tcpu), [9, 5, 3, 7]);
  assert.equal(res.totalTime, 24);
});

test('RR q=2 ejemplo 1 (preemptedOrder=last): el expulsado va DETRÁS de los que llegan en ese instante', () => {
  const res = run(EJEMPLO_1, { algorithm: 'RR', quantum: 2, preemptedOrder: 'last' });
  // t=2: llegó P2 (t=1) y llega P3 (t=2); P1 expulsado va al final → cola: P2,P3,P1
  assert.equal(cpuString(res), '112233114422311442114414');
});

test('RR q=2 ejemplo 1 (preemptedOrder=first): el expulsado va ANTES de los que llegan en ese instante', () => {
  const res = run(EJEMPLO_1, { algorithm: 'RR', quantum: 2, preemptedOrder: 'first' });
  // igual que tiebreak en este ejemplo porque el expulsado siempre es el más viejo
  assert.equal(cpuString(res), '112211334422113442114414');
});

test('RR tiebreak vs first: un proceso que vuelve de E/S con llegada más vieja pasa antes que el expulsado', () => {
  const src = `
RECURSO ''R1''
TAREA ''1'' INICIO=0 [CPU,1] [1,2] [CPU,1]
TAREA ''2'' INICIO=1 [CPU,4]
`;
  // P1 0-1, E/S 1-3. P2 1-3 agota quantum al final de t=2. En t=3 entran P1 (vuelve, llegó en 0) y P2 (expulsado, llegó en 1).
  assert.equal(cpuString(run(src, { algorithm: 'RR', quantum: 2, preemptedOrder: 'tiebreak' })), '122122');
  assert.equal(cpuString(run(src, { algorithm: 'RR', quantum: 2, preemptedOrder: 'first' })), '122221');
});

test('RR: si la cola está vacía el proceso sigue con un nuevo quantum', () => {
  const res = run(`TAREA ''1'' INICIO=0 [CPU,5]`, { algorithm: 'RR', quantum: 2 });
  assert.equal(cpuString(res), '11111');
});

test('Prioridades no apropiativo ejemplo 1 (menor valor = mayor prioridad, empate por llegada)', () => {
  const res = run(EJEMPLO_1, { algorithm: 'PRIORITY', preemptive: false });
  assert.equal(cpuString(res), '111111111333222224444444');
});

test('Prioridades apropiativo ejemplo 1', () => {
  const res = run(EJEMPLO_1, { algorithm: 'PRIORITY', preemptive: true });
  // P1 0-1, P2 1-2, P3 2-5, P2 5-9 (empata con P4 → llegó antes), P4 9-16, P1 16-24
  assert.equal(cpuString(res), '123332222444444411111111');
});

test('FIFO ejemplo 2: E/S en paralelo, un recurso por proceso', () => {
  const res = run(EJEMPLO_2, { algorithm: 'FIFO' });
  assert.equal(cpuString(res), '111223311223');
  // P1 hace E/S en R1 durante [3,5)
  assert.deepEqual(cell(res, '1', 3), { s: 'io', r: 'R1' });
  assert.deepEqual(cell(res, '1', 4), { s: 'io', r: 'R1' });
  assert.deepEqual(cell(res, '1', 5), { s: 'ready' });
  // P3 vuelve de E/S en t=10 y espera hasta que P2 termine
  assert.deepEqual(cell(res, '3', 10), { s: 'ready' });
  assert.deepEqual(cell(res, '3', 11), { s: 'cpu' });
  assert.deepEqual(res.procs.map((p) => [p.tr, p.te]), [[9, 4], [10, 6], [10, 7]]);
});

test('FIFO ejemplo 3: recurso compartido → el segundo espera bloqueado', () => {
  const res = run(EJEMPLO_3, { algorithm: 'FIFO' });
  assert.equal(cpuString(res), '111233112223');
  // P2 pide R1 en t=4 pero P1 lo tiene hasta t=6 → espera (bloqueado) en [4,6)
  assert.deepEqual(cell(res, '2', 4), { s: 'wait', r: 'R1' });
  assert.deepEqual(cell(res, '2', 5), { s: 'wait', r: 'R1' });
  assert.deepEqual(cell(res, '2', 6), { s: 'io', r: 'R1' });
  assert.deepEqual(cell(res, '2', 7), { s: 'io', r: 'R1' });
  assert.deepEqual(res.procs.map((p) => p.finish), [8, 11, 12]);
  const r1 = res.resources.find((r) => r.name === 'R1');
  assert.deepEqual(r1.timeline.slice(0, 8), [null, null, null, 1, 1, 1, 2, 2]);
});

test('SRTF con E/S: al volver de E/S con ráfaga corta expulsa', () => {
  const src = `
RECURSO ''R1''
TAREA ''1'' INICIO=0 [CPU,1] [1,2] [CPU,1]
TAREA ''2'' INICIO=0 [CPU,10]
`;
  const res = run(src, { algorithm: 'SRTF' });
  // P1 0-1, R1 1-3, vuelve en t=3 con 1 < 8 restantes de P2 → expulsa
  assert.equal(cpuString(res), '122122222222');
});

test('MLFQ: Q0 RR q=2, Q1 RR q=4, Q2 FCFS; baja de cola al agotar quantum', () => {
  const src = `
TAREA ''1'' INICIO=0 [CPU,10]
TAREA ''2'' INICIO=1 [CPU,3]
`;
  const res = run(src, { algorithm: 'MLFQ', queues: [{ quantum: 2 }, { quantum: 4 }, { quantum: null }] });
  // t=0-2 P1 (Q0) agota → Q1. t=2: P2 (Q0) 2-4 agota → Q1, cola Q1: P1, P2.
  // P1 4-8 (Q1) agota → Q2. P2 8-9 termina. P1 9-13 (Q2, FCFS).
  assert.equal(cpuString(res), '1122111121111');
  assert.equal(res.procs[0].level, 2);
});

test('MLFQ: un proceso que llega a Q0 expulsa a uno de Q1', () => {
  const src = `
TAREA ''1'' INICIO=0 [CPU,6]
TAREA ''2'' INICIO=3 [CPU,1]
`;
  const res = run(src, { algorithm: 'MLFQ', queues: [{ quantum: 2 }, { quantum: null }] });
  // P1 0-2 en Q0 → Q1; P1 2-3 en Q1; t=3 llega P2 a Q0 → expulsa; P2 3-4; P1 4-7
  assert.equal(cpuString(res), '1112111');
});

test('la simulación no cuelga con lotes vacíos de CPU ociosa entre llegadas', () => {
  const res = run("TAREA ''1'' INICIO=0 [CPU,1]\nTAREA ''2'' INICIO=5 [CPU,1]", { algorithm: 'FIFO' });
  assert.equal(cpuString(res), '1----2');
});
