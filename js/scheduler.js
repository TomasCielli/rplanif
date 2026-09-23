/*
 * rplanif — motor de planificación de CPU (sin DOM, testeable en Node).
 *
 * Modelo (sigue la explicación de práctica de la cátedra):
 *  - Tiempo discreto. El instante t ocupa el intervalo [t, t+1).
 *  - Una sola CPU. La E/S corre en paralelo a la CPU; cada recurso tiene su
 *    propia cola FIFO y atiende de a un proceso.
 *  - Una ráfaga que termina al final del instante t deja al proceso listo
 *    (o pidiendo E/S) a partir del instante t+1.
 *  - Desempate: orden de llegada al sistema (INICIO) y luego PID (orden de
 *    declaración).
 *  - RR (timer variable): el contador se inicializa en Q cada vez que un
 *    proceso toma la CPU. Si el expulsado por quantum coincide con llegadas o
 *    retornos de E/S, se encola según cfg.preemptedOrder (ver PREEMPTED_ORDERS;
 *    por defecto "tiebreak": se ordena con ellos por llegada y PID).
 *  - Los algoritmos apropiativos (SRTF, Prioridades apropiativo, MLFQ) sólo
 *    expulsan si el candidato es ESTRICTAMENTE mejor (nunca por empate).
 *
 * Estados de la línea de tiempo por proceso e instante:
 *   {s:'cpu'} | {s:'io', r} | {s:'wait', r} (bloqueado esperando el recurso)
 *
 * readyTimeline[t] lista los PID que esperan la CPU en el instante t (sin el que la
 * está usando), en el orden en que los tomaría el planificador.
 *   | {s:'ready'} | {s:'none'} (todavía no llegó o ya terminó)
 */
(function (root) {
  'use strict';

  var ALGORITHMS = {
    FIFO:     { label: 'FIFO / FCFS',                          quantum: false, preemptive: false },
    SJF:      { label: 'SJF — Shortest Job First',             quantum: false, preemptive: false },
    SRTF:     { label: 'SRTF — Shortest Remaining Time First', quantum: false, preemptive: true },
    RR:       { label: 'Round Robin (timer variable)',         quantum: true,  preemptive: false },
    PRIORITY: { label: 'Prioridades',                          quantum: false, preemptive: 'optional' },
    // Colas multinivel: implementado y testeado, pero OCULTO en la interfaz porque la
    // práctica de la comisión no lo usa y confunde. Para habilitarlo: hidden: false.
    MLFQ:     { label: 'Colas multinivel con retroalimentación', quantum: 'queues', preemptive: true, hidden: true },
  };

  var DEFAULT_QUEUES = [{ quantum: 8 }, { quantum: 16 }, { quantum: null }];

  // Dónde se encola el proceso expulsado por quantum cuando en ese mismo instante
  // también entran a la cola de listos otros procesos (llegadas o retornos de E/S).
  var PREEMPTED_ORDERS = {
    tiebreak: 'Se ordena con ellos por desempate: llegada al sistema, luego PID',
    last:     'Al final, después de los que entran en ese instante',
    first:    'Primero, antes de los que entran en ese instante',
  };

  function byArrivalPid(a, b) { return a.arrival - b.arrival || a.pid - b.pid; }

  function normalizeQueues(queues) {
    if (!queues || !queues.length) return DEFAULT_QUEUES;
    return queues.map(function (q) {
      var v = q && q.quantum;
      return { quantum: (typeof v === 'number' && v > 0) ? Math.floor(v) : null };
    });
  }

  function snapshot(p) {
    switch (p.state) {
      case 'running': return { s: 'cpu' };
      case 'io':      return { s: 'io', r: p.bursts[p.idx].resource };
      case 'wait':    return { s: 'wait', r: p.bursts[p.idx].resource };
      case 'ready':   return { s: 'ready' };
      default:        return { s: 'none' };
    }
  }

  /* ---------------- políticas ----------------
   * La CPU y cada recurso son lo mismo: una cola con una política. Estas funciones no
   * saben a qué servidor pertenece la cola, así que sirven para las dos.
   */

  function normalizePolicy(raw, allowQueues) {
    raw = raw || {};
    var alg = ALGORITHMS[raw.algorithm] ? raw.algorithm : 'FIFO';
    // Las colas multinivel usan el nivel del proceso, que pertenece a la cola de listos:
    // un recurso no puede degradar a un proceso, así que ahí se ignoran.
    if (alg === 'MLFQ' && !allowQueues) alg = 'FIFO';
    return {
      algorithm: alg,
      quantum: Math.max(1, parseInt(raw.quantum, 10) || 1),
      preemptive: alg === 'SRTF' || alg === 'MLFQ' || (alg === 'PRIORITY' && !!raw.preemptive),
      queues: alg === 'MLFQ' ? normalizeQueues(raw.queues) : null,
      preemptedOrder: PREEMPTED_ORDERS[raw.preemptedOrder] ? raw.preemptedOrder : 'tiebreak',
    };
  }

  function sortKey(pol, p) {
    if (pol.algorithm === 'SJF' || pol.algorithm === 'SRTF') return [p.remaining, p.arrival, p.pid];
    if (pol.algorithm === 'PRIORITY') return [p.priority, p.arrival, p.pid];
    return null;
  }

  function better(pol, a, b) {
    var ka = sortKey(pol, a), kb = sortKey(pol, b);
    for (var i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i];
    return false;
  }

  // Índice del próximo proceso a atender, o -1 si la cola está vacía.
  function pickIndex(pol, queue) {
    if (!queue.length) return -1;
    if (pol.algorithm === 'FIFO' || pol.algorithm === 'RR') return 0;
    var best = 0;
    for (var i = 1; i < queue.length; i++) {
      if (pol.algorithm === 'MLFQ') { if (queue[i].level < queue[best].level) best = i; }
      else if (better(pol, queue[i], queue[best])) best = i;
    }
    return best;
  }

  // Sólo se expulsa si el candidato es ESTRICTAMENTE mejor: en empate sigue el que está.
  function shouldPreempt(pol, cand, cur) {
    if (pol.algorithm === 'SRTF') return cand.remaining < cur.remaining;
    if (pol.algorithm === 'PRIORITY') return cand.priority < cur.priority;
    if (pol.algorithm === 'MLFQ') return cand.level < cur.level;
    return false;
  }

  function quantumFor(pol, p) {
    if (pol.algorithm === 'RR') return pol.quantum;
    if (pol.algorithm === 'MLFQ') { var q = pol.queues[p.level].quantum; return q == null ? Infinity : q; }
    return Infinity;
  }

  function simulate(def, cfg) {
    cfg = cfg || {};
    if (!ALGORITHMS[cfg.algorithm]) throw new Error('Algoritmo desconocido: ' + cfg.algorithm);
    var maxTicks = cfg.maxTicks || 5000;
    var resCfg = cfg.resources || {};

    var procs = def.tasks.map(function (t, i) {
      return {
        pid: i + 1, name: String(t.name), arrival: t.arrival, priority: t.priority || 0,
        bursts: t.bursts, idx: 0, remaining: t.bursts[0].dur,
        // Un proceso usa un solo servidor a la vez (o la CPU, o un recurso), así que el
        // contador de quantum puede ser un único campo del proceso.
        state: 'new', level: 0, quantumLeft: Infinity, keepQuantum: false,
        finish: null,
        tcpu: t.bursts.reduce(function (s, b) { return s + (b.type === 'cpu' ? b.dur : 0); }, 0),
        timeline: [],
      };
    });

    function makeServer(name, pol, isCPU) {
      return { name: name, pol: pol, isCPU: !!isCPU, queue: [], busy: null, preempted: null, timeline: [] };
    }

    var cpu = makeServer('CPU', normalizePolicy(cfg, true), true);
    var resources = {};
    def.resources.forEach(function (r) { resources[r] = makeServer(r, normalizePolicy(resCfg[r], false)); });
    var resourceList = Object.keys(resources).map(function (k) { return resources[k]; });

    var pendingReady = [];     // terminaron E/S al final del instante anterior
    var pendingIO = [];        // terminaron CPU y piden E/S
    var readyTimeline = [];    // quiénes esperan la CPU en cada instante, en orden de cola
    var events = [];
    function log(t, msg) { events.push({ t: t, msg: msg }); }

    // Entran a la cola los que llegan en este instante y el expulsado por quantum,
    // ordenados según la convención elegida.
    function enqueue(server, incoming) {
      incoming = incoming.slice();
      if (server.preempted && server.pol.preemptedOrder === 'tiebreak') { incoming.push(server.preempted); server.preempted = null; }
      incoming.sort(byArrivalPid);
      if (server.preempted && server.pol.preemptedOrder === 'first') { server.queue.push(server.preempted); server.preempted = null; }
      server.queue = server.queue.concat(incoming);
      if (server.preempted) { server.queue.push(server.preempted); server.preempted = null; }
    }

    function dispatch(server, t) {
      if (server.busy && server.pol.preemptive) {
        var ci = pickIndex(server.pol, server.queue);
        if (ci >= 0 && shouldPreempt(server.pol, server.queue[ci], server.busy)) {
          log(t, 'Tarea ' + server.queue[ci].name + ' expulsa a ' + server.busy.name + (server.isCPU ? '' : ' en ' + server.name));
          server.busy.state = server.isCPU ? 'ready' : 'wait';
          server.busy.keepQuantum = true;
          server.queue.unshift(server.busy);
          server.busy = null;
        }
      }
      if (server.busy) return;
      var di = pickIndex(server.pol, server.queue);
      if (di < 0) return;
      var p = server.queue.splice(di, 1)[0];
      server.busy = p;
      p.state = server.isCPU ? 'running' : 'io';
      if (!p.keepQuantum) p.quantumLeft = quantumFor(server.pol, p);
      p.keepQuantum = false;
      var counter = isFinite(p.quantumLeft) ? ' [contador=' + p.quantumLeft + ']' : '';
      log(t, server.isCPU
        ? 'Tarea ' + p.name + ' toma la CPU' + (server.pol.algorithm === 'MLFQ' ? ' (Q' + p.level + ')' : '') + counter
        : 'Tarea ' + p.name + ' inicia E/S en ' + server.name + counter);
    }

    function runTick(server, t) {
      var p = server.busy;
      if (!p) return;
      p.remaining--;
      if (p.remaining === 0) {
        if (!server.isCPU) log(t + 1, 'Tarea ' + p.name + ' termina E/S en ' + server.name);
        advance(p, t + 1);
        server.busy = null;
        return;
      }
      if (!isFinite(p.quantumLeft)) return;
      p.quantumLeft--;
      if (p.quantumLeft > 0) return;
      log(t + 1, 'Tarea ' + p.name + ' agota su quantum' + (server.isCPU ? '' : ' en ' + server.name));
      p.state = server.isCPU ? 'ready' : 'wait';
      if (server.isCPU && server.pol.algorithm === 'MLFQ' && p.level < server.pol.queues.length - 1) {
        p.level++;
        log(t + 1, 'Tarea ' + p.name + ' baja a la cola Q' + p.level);
      }
      server.preempted = p;
      server.busy = null;
    }

    // El proceso terminó su ráfaga actual al final del instante (time-1).
    function advance(p, time) {
      p.idx++;
      if (p.idx >= p.bursts.length) {
        p.state = 'done'; p.finish = time;
        log(time, 'Tarea ' + p.name + ' finaliza');
        return;
      }
      var b = p.bursts[p.idx];
      p.remaining = b.dur;
      if (b.type === 'cpu') { p.state = 'ready'; pendingReady.push(p); }
      else { p.state = 'wait'; pendingIO.push(p); log(time, 'Tarea ' + p.name + ' solicita E/S en ' + b.resource); }
    }

    function admit(p, t) {
      p.state = 'ready';
      var first = p.bursts[0];
      if (first.type === 'io') { p.state = 'wait'; pendingIO.push(p); }
      log(t, 'Tarea ' + p.name + ' llega al sistema');
      return p.state === 'ready';
    }

    var t = 0;
    while (procs.some(function (p) { return p.state !== 'done'; })) {
      if (t >= maxTicks) throw new Error('La simulación supera ' + maxTicks + ' instantes; revisá la definición.');

      // 1) Llegadas y retornos de E/S entran a la cola de listos.
      var arriving = procs
        .filter(function (p) { return p.state === 'new' && p.arrival === t; })
        .filter(function (p) { return admit(p, t); });
      enqueue(cpu, arriving.concat(pendingReady));
      pendingReady = [];

      // 2) Pedidos de E/S → cola del recurso correspondiente.
      resourceList.forEach(function (r) {
        enqueue(r, pendingIO.filter(function (p) { return p.bursts[p.idx].resource === r.name; }));
      });
      pendingIO = [];

      // 3) Cada servidor atiende su cola con su propia política.
      resourceList.forEach(function (r) { dispatch(r, t); });
      dispatch(cpu, t);

      // 4) Registro del instante t.
      procs.forEach(function (p) { p.timeline[t] = snapshot(p); });
      cpu.timeline[t] = cpu.busy ? cpu.busy.pid : null;
      readyTimeline[t] = cpu.queue.map(function (p) { return p.pid; });
      resourceList.forEach(function (r) { r.timeline[t] = r.busy ? r.busy.pid : null; });

      // 5) Ejecución del instante y transiciones al final del mismo.
      runTick(cpu, t);
      resourceList.forEach(function (r) { runTick(r, t); });
      t++;
    }

    var out = procs.map(function (p) {
      var tr = p.finish - p.arrival;
      return {
        pid: p.pid, name: p.name, arrival: p.arrival, priority: p.priority, level: p.level,
        tcpu: p.tcpu, finish: p.finish, tr: tr, te: tr - p.tcpu, timeline: p.timeline,
      };
    });
    var n = out.length;
    return {
      algorithm: cfg.algorithm,
      procs: out,
      resources: resourceList.map(function (r) {
        return { name: r.name, timeline: r.timeline, algorithm: r.pol.algorithm, quantum: r.pol.quantum };
      }),
      cpuTimeline: cpu.timeline,
      readyTimeline: readyTimeline,
      totalTime: t,
      events: events,
      metrics: {
        tpr: n ? out.reduce(function (s, p) { return s + p.tr; }, 0) / n : 0,
        tpe: n ? out.reduce(function (s, p) { return s + p.te; }, 0) / n : 0,
      },
    };
  }

  var api = { simulate: simulate, ALGORITHMS: ALGORITHMS, DEFAULT_QUEUES: DEFAULT_QUEUES, PREEMPTED_ORDERS: PREEMPTED_ORDERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RPlanif = Object.assign(root.RPlanif || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
