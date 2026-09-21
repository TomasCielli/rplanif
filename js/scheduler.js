/*
 * qplanif+ — motor de planificación de CPU (sin DOM, testeable en Node).
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
    MLFQ:     { label: 'Colas multinivel con retroalimentación', quantum: 'queues', preemptive: true },
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

  function simulate(def, cfg) {
    cfg = cfg || {};
    var alg = cfg.algorithm;
    if (!ALGORITHMS[alg]) throw new Error('Algoritmo desconocido: ' + alg);
    var quantum = Math.max(1, parseInt(cfg.quantum, 10) || 1);
    var queues = alg === 'MLFQ' ? normalizeQueues(cfg.queues) : null;
    var preemptive = alg === 'SRTF' || alg === 'MLFQ' || (alg === 'PRIORITY' && !!cfg.preemptive);
    var preemptedOrder = PREEMPTED_ORDERS[cfg.preemptedOrder] ? cfg.preemptedOrder : 'tiebreak';
    var maxTicks = cfg.maxTicks || 5000;

    var procs = def.tasks.map(function (t, i) {
      return {
        pid: i + 1, name: String(t.name), arrival: t.arrival, priority: t.priority || 0,
        bursts: t.bursts, idx: 0, remaining: t.bursts[0].dur,
        state: 'new', level: 0, quantumLeft: Infinity, keepQuantum: false,
        finish: null,
        tcpu: t.bursts.reduce(function (s, b) { return s + (b.type === 'cpu' ? b.dur : 0); }, 0),
        timeline: [],
      };
    });
    var resources = {};
    def.resources.forEach(function (r) { resources[r] = { name: r, busy: null, queue: [], timeline: [] }; });
    var resourceList = Object.keys(resources).map(function (k) { return resources[k]; });

    var ready = [];
    var running = null;
    var preempted = null;      // expulsado por quantum al final del instante anterior
    var pendingReady = [];     // terminaron E/S al final del instante anterior
    var pendingIO = [];        // terminaron CPU y piden E/S
    var cpuTimeline = [];
    var events = [];
    function log(t, msg) { events.push({ t: t, msg: msg }); }

    function quantumFor(p) {
      if (alg === 'RR') return quantum;
      if (alg === 'MLFQ') { var q = queues[p.level].quantum; return q == null ? Infinity : q; }
      return Infinity;
    }

    function sortKey(p) {
      if (alg === 'SJF' || alg === 'SRTF') return [p.remaining, p.arrival, p.pid];
      if (alg === 'PRIORITY') return [p.priority, p.arrival, p.pid];
      return null;
    }
    function less(a, b) {
      var ka = sortKey(a), kb = sortKey(b);
      for (var i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i];
      return false;
    }

    function pickIndex() {
      if (!ready.length) return -1;
      if (alg === 'FIFO' || alg === 'RR') return 0;
      var best = 0;
      for (var i = 1; i < ready.length; i++) {
        if (alg === 'MLFQ') { if (ready[i].level < ready[best].level) best = i; }
        else if (less(ready[i], ready[best])) best = i;
      }
      return best;
    }

    function shouldPreempt(cand, run) {
      if (alg === 'SRTF') return cand.remaining < run.remaining;
      if (alg === 'PRIORITY') return cand.priority < run.priority;
      if (alg === 'MLFQ') return cand.level < run.level;
      return false;
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

      // 1) Llegadas y retornos de E/S entran a la cola de listos (empate: llegada, PID).
      var incoming = procs
        .filter(function (p) { return p.state === 'new' && p.arrival === t; })
        .filter(function (p) { return admit(p, t); });
      incoming = incoming.concat(pendingReady); pendingReady = [];
      //    El expulsado por quantum entra junto con ellos según la convención elegida.
      if (preempted && preemptedOrder === 'tiebreak') { incoming.push(preempted); preempted = null; }
      incoming.sort(byArrivalPid);
      if (preempted && preemptedOrder === 'first') { ready.push(preempted); preempted = null; }
      ready = ready.concat(incoming);
      if (preempted) { ready.push(preempted); preempted = null; }

      // 2) Pedidos de E/S → cola del recurso correspondiente.
      pendingIO.sort(byArrivalPid).forEach(function (p) { resources[p.bursts[p.idx].resource].queue.push(p); });
      pendingIO = [];

      // 3) Recursos libres atienden al primero de su cola.
      resourceList.forEach(function (r) {
        if (!r.busy && r.queue.length) {
          r.busy = r.queue.shift(); r.busy.state = 'io';
          log(t, 'Tarea ' + r.busy.name + ' inicia E/S en ' + r.name);
        }
      });

      // 4) Planificación de CPU.
      if (running && preemptive) {
        var ci = pickIndex();
        if (ci >= 0 && shouldPreempt(ready[ci], running)) {
          log(t, 'Tarea ' + ready[ci].name + ' expulsa a ' + running.name);
          running.state = 'ready'; running.keepQuantum = true;
          ready.unshift(running); running = null;
        }
      }
      if (!running) {
        var di = pickIndex();
        if (di >= 0) {
          running = ready.splice(di, 1)[0]; running.state = 'running';
          if (!running.keepQuantum) running.quantumLeft = quantumFor(running);
          running.keepQuantum = false;
          log(t, 'Tarea ' + running.name + ' toma la CPU'
            + (alg === 'MLFQ' ? ' (Q' + running.level + ')' : '')
            + (isFinite(running.quantumLeft) ? ' [contador=' + running.quantumLeft + ']' : ''));
        }
      }

      // 5) Registro del instante t.
      procs.forEach(function (p) { p.timeline[t] = snapshot(p); });
      cpuTimeline[t] = running ? running.pid : null;
      resourceList.forEach(function (r) { r.timeline[t] = r.busy ? r.busy.pid : null; });

      // 6) Ejecución del instante t y transiciones al final del mismo.
      if (running) {
        running.remaining--;
        if (running.remaining === 0) {
          advance(running, t + 1); running = null;
        } else if (isFinite(running.quantumLeft)) {
          running.quantumLeft--;
          if (running.quantumLeft === 0) {
            log(t + 1, 'Tarea ' + running.name + ' agota su quantum');
            running.state = 'ready';
            if (alg === 'MLFQ' && running.level < queues.length - 1) {
              running.level++;
              log(t + 1, 'Tarea ' + running.name + ' baja a la cola Q' + running.level);
            }
            preempted = running; running = null;
          }
        }
      }
      resourceList.forEach(function (r) {
        if (!r.busy) return;
        r.busy.remaining--;
        if (r.busy.remaining === 0) {
          log(t + 1, 'Tarea ' + r.busy.name + ' termina E/S en ' + r.name);
          advance(r.busy, t + 1); r.busy = null;
        }
      });
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
      algorithm: alg,
      procs: out,
      resources: resourceList.map(function (r) { return { name: r.name, timeline: r.timeline }; }),
      cpuTimeline: cpuTimeline,
      totalTime: t,
      events: events,
      metrics: {
        tpr: out.reduce(function (s, p) { return s + p.tr; }, 0) / n,
        tpe: out.reduce(function (s, p) { return s + p.te; }, 0) / n,
      },
    };
  }

  var api = { simulate: simulate, ALGORITHMS: ALGORITHMS, DEFAULT_QUEUES: DEFAULT_QUEUES, PREEMPTED_ORDERS: PREEMPTED_ORDERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QPlanif = Object.assign(root.QPlanif || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
