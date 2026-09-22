/* rplanif — interfaz: modo manual (dibujás vos) y automático (resuelve el motor). */
(function () {
  'use strict';

  var QP = window.RPlanif;
  var $ = function (id) { return document.getElementById(id); };

  // Definición inicial (ejemplo 1 del apunte) para la primera vez que se abre la app.
  var DEFAULT_DEFINITION = "#Ejemplo 1\nTAREA ''1'' PRIORIDAD=3\nINICIO=0 [CPU,9]\nTAREA ''2'' PRIORIDAD=2\nINICIO=1 [CPU,5]\nTAREA ''3'' PRIORIDAD=1\nINICIO=2 [CPU,3]\nTAREA ''4'' PRIORIDAD=2\nINICIO=3 [CPU,7]\n";

  var HINTS = {
    FIFO: 'Se elige el proceso más antiguo de la cola de listos. No apropiativo.',
    SJF: 'Se elige el proceso con la ráfaga de CPU más corta. No apropiativo: el que está en CPU no se interrumpe.',
    SRTF: 'Versión apropiativa de SJF: si llega (o vuelve de E/S) un proceso con menos tiempo restante de ráfaga, expulsa al actual.',
    RR: 'FIFO circular con quantum. Timer variable: el contador arranca en Q cada vez que un proceso toma la CPU.',
    PRIORITY: 'Menor valor = mayor prioridad. Si es apropiativo, un proceso de mayor prioridad expulsa al actual al llegar.',
    MLFQ: 'Q0, Q1, … cada una con su quantum (RR) o FCFS. Al agotar el quantum el proceso baja de cola. Una cola superior expulsa a una inferior.',
  };

  // Un color por recurso de E/S, asignado por orden de declaración (R1 celeste como en el PDF).
  var RESOURCE_COLORS = ['#22b8cf', '#845ef7', '#40c057', '#f06595', '#f59f00', '#12b886', '#4c6ef5', '#be4bdb'];
  function resourceColor(name) {
    var i = state.def ? state.def.resources.indexOf(name) : -1;
    return RESOURCE_COLORS[(i < 0 ? 0 : i) % RESOURCE_COLORS.length];
  }

  var state = {
    def: null, cfg: null, auto: null,
    // modelo editable de la tabla: bursts como string con el formato de entrada
    table: { resources: [], tasks: [] },
    // manual: celdas pintadas y marcadores (▲ llegada, ▼ fin) por "pid:t"
    manual: {}, markers: {}, manualMetrics: {},
    mode: 'manual', brush: 'cpu', horizon: 20,
    diff: null, painting: false,
  };

  /* ---------------- configuración ---------------- */

  function parseQueues(text) {
    return String(text).split(',').map(function (s) {
      s = s.trim().toUpperCase();
      var n = parseInt(s, 10);
      return { quantum: (s === '' || s === '-' || s === 'FCFS' || s === 'FIFO' || isNaN(n) || n <= 0) ? null : n };
    });
  }

  function readConfig() {
    return {
      algorithm: $('algorithm').value,
      quantum: parseInt($('quantum').value, 10) || 1,
      preemptive: $('preemptive').checked,
      queues: parseQueues($('queues').value),
      preemptedOrder: $('preempted-order').value,
    };
  }

  function describeConfig(cfg) {
    var a = QP.ALGORITHMS[cfg.algorithm].label;
    if (cfg.algorithm === 'RR') a += ' · Q=' + cfg.quantum;
    if (cfg.algorithm === 'PRIORITY') a += cfg.preemptive ? ' · apropiativo' : ' · no apropiativo';
    if (cfg.algorithm === 'MLFQ') a += ' · ' + cfg.queues.map(function (q, i) { return 'Q' + i + '=' + (q.quantum == null ? 'FCFS' : 'RR q' + q.quantum); }).join(', ');
    if (cfg.algorithm === 'RR' || cfg.algorithm === 'MLFQ') a += ' · expulsado: ' + { tiebreak: 'por desempate', last: 'al final', first: 'primero' }[cfg.preemptedOrder];
    return a;
  }

  function syncAlgorithmUI() {
    var alg = $('algorithm').value;
    $('quantum-row').classList.toggle('hidden', alg !== 'RR');
    $('preemptive-row').classList.toggle('hidden', alg !== 'PRIORITY');
    $('queues-row').classList.toggle('hidden', alg !== 'MLFQ');
    $('preempted-order-row').classList.toggle('hidden', alg !== 'RR' && alg !== 'MLFQ');
    $('algorithm-hint').textContent = HINTS[alg] || '';
  }

  /* ---------------- carga (código ⇄ tabla) ---------------- */

  function showErrors(list) {
    var ul = $('parse-errors');
    ul.innerHTML = '';
    list.forEach(function (e) { var li = document.createElement('li'); li.textContent = e; ul.appendChild(li); });
  }

  // source: 'code' (textarea/archivo → también reconstruye la tabla) | 'table' (la tabla ya es la fuente)
  function load(source) {
    var def = QP.parse($('definition').value);
    showErrors(def.errors);
    if (def.errors.length) return;

    if (source !== 'table') { tableFromDef(def); renderTable(); }

    try {
      localStorage.setItem('rplanif.definition', $('definition').value);
      localStorage.setItem('rplanif.preemptedOrder', $('preempted-order').value);
    } catch (e) { /* sin storage */ }

    var names = function (d) { return JSON.stringify(d.tasks.map(function (t) { return t.name; })); };
    var sameTasks = state.def && names(state.def) === names(def);
    if (!sameTasks) { state.manual = {}; state.markers = {}; state.manualMetrics = {}; }

    state.def = def;
    state.cfg = readConfig();
    state.diff = null;
    try {
      state.auto = QP.simulate(def, state.cfg);
    } catch (err) {
      state.auto = null;
      showErrors([err.message]);
      return;
    }
    state.horizon = sameTasks
      ? Math.max(state.horizon, state.auto.totalTime + 4, 16)
      : Math.max(state.auto.totalTime + 4, 16);
    if (state.brush.indexOf('io:') === 0 && def.resources.indexOf(state.brush.slice(3)) < 0) state.brush = 'cpu';
    render();
  }

  function tableFromDef(def) {
    state.table = {
      resources: def.resources.slice(),
      tasks: def.tasks.map(function (t) {
        return { name: t.name, arrival: t.arrival, priority: t.priority, bursts: QP.burstsToString(t.bursts) };
      }),
    };
  }

  // La tabla genera el código y lo carga.
  function tableToCode() {
    $('definition').value = QP.serialize(state.table);
    load('table');
  }

  function renderTable() {
    var tbl = $('proc-table');
    $('resources-input').value = state.table.resources.join(', ');
    var html = '<thead><tr><th>Job</th><th>Llegada</th><th>Prio</th><th>Ráfagas</th><th></th></tr></thead><tbody>';
    if (!state.table.tasks.length) html += '<tr class="empty-row"><td colspan="5">Sin procesos. Agregá uno.</td></tr>';
    state.table.tasks.forEach(function (t, i) {
      html += '<tr>'
        + '<td><input class="num" data-i="' + i + '" data-f="name" value="' + escapeAttr(t.name) + '"></td>'
        + '<td><input class="num" type="number" min="0" data-i="' + i + '" data-f="arrival" value="' + t.arrival + '"></td>'
        + '<td><input class="num" type="number" data-i="' + i + '" data-f="priority" value="' + t.priority + '"></td>'
        + '<td><input class="bursts" data-i="' + i + '" data-f="bursts" value="' + escapeAttr(t.bursts) + '" placeholder="[CPU,3] [R1,2]"></td>'
        + '<td><button class="del" data-i="' + i + '" title="Eliminar proceso">✕</button></td>'
        + '</tr>';
    });
    tbl.innerHTML = html + '</tbody>';

    tbl.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var t = state.table.tasks[+inp.dataset.i];
        var f = inp.dataset.f;
        if (f === 'arrival' || f === 'priority') t[f] = parseInt(inp.value, 10) || 0;
        else t[f] = inp.value;
        tableToCode();
      });
    });
    tbl.querySelectorAll('.del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.table.tasks.splice(+btn.dataset.i, 1);
        renderTable();
        tableToCode();
      });
    });
  }

  function addTask() {
    var used = state.table.tasks.map(function (t) { return t.name; });
    var n = 1;
    while (used.indexOf(String(n)) >= 0) n++;
    state.table.tasks.push({ name: String(n), arrival: 0, priority: 0, bursts: '[CPU,1]' });
    renderTable();
    tableToCode();
    var inputs = $('proc-table').querySelectorAll('input.bursts');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function setSource(which) {
    $('src-table').classList.toggle('active', which === 'table');
    $('src-code').classList.toggle('active', which === 'code');
    $('table-view').classList.toggle('hidden', which !== 'table');
    $('code-view').classList.toggle('hidden', which !== 'code');
  }

  /* ---------------- render ---------------- */

  function setMode(mode) {
    state.mode = mode;
    $('mode-manual').classList.toggle('active', mode === 'manual');
    $('mode-auto').classList.toggle('active', mode === 'auto');
    $('manual-tools').classList.toggle('hidden', mode !== 'manual');
    $('log-box').classList.toggle('hidden', mode !== 'auto');
    render();
  }

  function render() {
    if (!state.def || !state.auto) return;
    if (!state.def.tasks.length) { renderEmpty(); return; }
    $('status').textContent = describeConfig(state.cfg) + (state.mode === 'manual'
      ? ' — dibujá el diagrama y apretá "Corregir".'
      : ' — solución calculada por el simulador (' + state.auto.totalTime + ' instantes).');
    renderBrushes();
    renderLegend();
    // en automático se agrega una columna extra para que entre el ▼ del último proceso
    if (state.mode === 'manual') renderGantt(manualCell, manualMarkers, true, state.horizon);
    else renderGantt(autoCell, autoMarkers, false, state.auto.totalTime + 1);
    renderMetrics();
    renderFeedback();
    renderLog();
  }

  // Sin procesos: no hay nada que dibujar ni corregir.
  function renderEmpty() {
    $('status').textContent = describeConfig(state.cfg) + ' — sin procesos.';
    $('gantt').innerHTML = '<div class="empty">No hay procesos. Agregá uno en la tabla, escribí el código o importá un archivo.</div>';
    $('legend').innerHTML = '';
    $('feedback').classList.add('hidden');
    $('metrics').innerHTML = '<p class="hint">Sin procesos.</p>';
    $('log').textContent = '';
    renderBrushes();
  }

  function manualCell(pid, t) { return state.manual[pid + ':' + t] || { s: 'none' }; }
  function manualMarkers(pid, t) { return state.markers[pid + ':' + t] || {}; }
  function autoCell(pid, t) { return state.auto.procs[pid - 1].timeline[t] || { s: 'none' }; }
  function autoMarkers(pid, t) {
    var p = state.auto.procs[pid - 1];
    return { up: p.arrival === t, down: p.finish === t };
  }

  function renderBrushes() {
    var box = $('brushes');
    box.innerHTML = '';
    var brushes = [{ id: 'cpu', label: 'CPU', swatch: 'bar cpu' }];
    state.def.resources.forEach(function (r) { brushes.push({ id: 'io:' + r, label: 'E/S ' + r, swatch: 'bar io', color: resourceColor(r) }); });
    brushes.push({ id: 'up', label: 'Llegada', swatch: 'mk up' });
    brushes.push({ id: 'down', label: 'Fin', swatch: 'mk down' });
    brushes.push({ id: 'erase', label: 'Borrar', swatch: 'bar' });
    brushes.forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'brush' + (state.brush === b.id ? ' active' : '');
      btn.innerHTML = '<span class="swatch ' + b.swatch + '"' + (b.color ? ' style="background:' + b.color + '"' : '') + '></span>' + b.label;
      btn.addEventListener('click', function () { state.brush = b.id; renderBrushes(); });
      box.appendChild(btn);
    });
  }

  function renderLegend() {
    var items = [['bar cpu', 'Uso de CPU']];
    state.def.resources.forEach(function (r) { items.push(['bar io', 'E/S ' + r, resourceColor(r)]); });
    items.push(['mk up', 'Llegada al sistema'], ['mk down', 'Fin del proceso']);
    if (state.mode === 'auto') items.push(['bar wait', 'Bloqueado esperando el recurso'], ['bar ready', 'Listo (esperando CPU)']);
    else items.push(['wrong', 'Incorrecto (después de corregir)']);
    $('legend').innerHTML = items.map(function (it) {
      return '<span><i class="' + it[0] + '"' + (it[2] ? ' style="background:' + it[2] + '"' : '') + '></i>' + it[1] + '</span>';
    }).join('');
  }

  function cellLabel(c) {
    if (c.s === 'io') return c.r;
    if (c.s === 'wait') return '⏳' + c.r;
    return '';
  }

  function fillCell(el, c, mk) {
    var style = c.s === 'io' ? ' style="background:' + resourceColor(c.r) + '"' : '';
    el.innerHTML = '<span class="bar ' + c.s + '"' + style + '>' + escapeHtml(cellLabel(c)) + '</span>'
      + (mk.up ? '<i class="mk up"></i>' : '')
      + (mk.down ? '<i class="mk down"></i>' : '');
  }

  function renderGantt(getCell, getMarkers, editable, T) {
    var wrap = $('gantt');
    var grid = document.createElement('div');
    grid.className = 'gantt' + (editable ? ' editable' : '');
    grid.style.gridTemplateColumns = '150px repeat(' + T + ', var(--cell))';

    var corner = document.createElement('div'); corner.className = 'head rowlabel'; corner.textContent = 't';
    grid.appendChild(corner);
    for (var t = 0; t < T; t++) {
      var h = document.createElement('div');
      h.className = 'head' + (t % 5 === 0 ? ' major' : '');
      h.textContent = t;
      grid.appendChild(h);
    }

    if (!editable) addSummaryRow(grid, 'CPU', '', T, state.auto.cpuTimeline);

    state.def.tasks.forEach(function (task, i) {
      var pid = i + 1;
      var sub = 'llega ' + task.arrival + (state.cfg.algorithm === 'PRIORITY' ? ' · prio ' + task.priority : '');
      addRow(grid, task.name, sub, T, function (t) {
        var d = document.createElement('div');
        d.className = 'cell' + (t % 5 === 4 ? ' tick' : '');
        d.dataset.pid = pid; d.dataset.t = t;
        fillCell(d, getCell(pid, t), getMarkers(pid, t));
        var w = state.diff && state.diff.wrong[pid + ':' + t];
        if (w) { d.classList.add('wrong'); d.title = w; }
        return d;
      });
    });

    if (!editable) {
      state.auto.resources.forEach(function (r) { addSummaryRow(grid, r.name, 'recurso', T, r.timeline); });
    }

    wrap.innerHTML = '';
    wrap.appendChild(grid);
  }

  function addSummaryRow(grid, label, sub, T, timeline) {
    addRow(grid, label, sub, T, function (t) {
      var pid = timeline[t];
      var d = document.createElement('div');
      d.className = 'cell summary' + (pid == null ? ' idle' : '');
      d.textContent = pid == null ? '·' : state.auto.procs[pid - 1].name;
      return d;
    }, true);
  }

  function addRow(grid, label, sub, T, makeCell, summary) {
    var l = document.createElement('div');
    l.className = 'rowlabel' + (summary ? ' summary-label' : '');
    l.innerHTML = escapeHtml(label) + (sub ? '<small>' + escapeHtml(sub) + '</small>' : '');
    grid.appendChild(l);
    for (var t = 0; t < T; t++) grid.appendChild(makeCell(t));
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function escapeAttr(s) { return escapeHtml(s); }

  /* ---------------- pintar ---------------- */

  function paint(cellEl, isDrag) {
    if (!cellEl || cellEl.dataset.pid === undefined) return;
    var key = cellEl.dataset.pid + ':' + cellEl.dataset.t;
    var b = state.brush;

    if (b === 'up' || b === 'down') {
      if (isDrag) return;                       // los marcadores se colocan de a uno (toggle)
      var mk = state.markers[key] || {};
      mk[b] = !mk[b];
      if (!mk.up && !mk.down) delete state.markers[key]; else state.markers[key] = mk;
    } else if (b === 'erase') {
      delete state.manual[key];
      delete state.markers[key];
    } else {
      state.manual[key] = b === 'cpu' ? { s: 'cpu' } : { s: 'io', r: b.slice(3) };
    }
    fillCell(cellEl, manualCell(+cellEl.dataset.pid, +cellEl.dataset.t), manualMarkers(+cellEl.dataset.pid, +cellEl.dataset.t));
    if (state.diff) { state.diff = null; renderFeedback(); clearWrongMarks(); }
  }

  function clearWrongMarks() {
    document.querySelectorAll('.cell.wrong').forEach(function (c) { c.classList.remove('wrong'); c.removeAttribute('title'); });
    document.querySelectorAll('.metrics-box input').forEach(function (i) { i.classList.remove('wrong', 'right'); });
  }

  $('gantt').addEventListener('mousedown', function (e) {
    if (state.mode !== 'manual') return;
    var cell = e.target.closest('.cell');
    if (!cell) return;
    e.preventDefault();
    state.painting = true;
    paint(cell, false);
  });
  $('gantt').addEventListener('mouseover', function (e) {
    if (!state.painting) return;
    paint(e.target.closest('.cell'), true);
  });
  window.addEventListener('mouseup', function () { state.painting = false; });

  /* ---------------- métricas ---------------- */

  function renderMetrics() {
    var box = $('metrics');
    var procs = state.auto.procs;
    var manual = state.mode === 'manual';
    var html = '<table><thead><tr><th>Proceso</th><th>Llegada</th><th>T<sub>CPU</sub></th><th>T<sub>R</sub></th><th>T<sub>E</sub></th></tr></thead><tbody>';
    procs.forEach(function (p) {
      var mm = state.manualMetrics[p.pid] || {};
      html += '<tr><td class="name">' + escapeHtml(p.name) + '</td><td>' + p.arrival + '</td><td>' + p.tcpu + '</td>';
      if (manual) {
        html += '<td><input type="number" data-pid="' + p.pid + '" data-m="tr" value="' + (mm.tr == null ? '' : mm.tr) + '"></td>'
              + '<td><input type="number" data-pid="' + p.pid + '" data-m="te" value="' + (mm.te == null ? '' : mm.te) + '"></td>';
      } else {
        html += '<td>' + p.tr + '</td><td>' + p.te + '</td>';
      }
      html += '</tr>';
    });
    if (manual) {
      var mt = state.manualMetrics.avg || {};
      html += '<tr class="avg"><td class="name">Promedio</td><td></td><td></td>'
            + '<td><input type="number" step="0.01" data-pid="avg" data-m="tr" value="' + (mt.tr == null ? '' : mt.tr) + '"></td>'
            + '<td><input type="number" step="0.01" data-pid="avg" data-m="te" value="' + (mt.te == null ? '' : mt.te) + '"></td></tr>';
    } else {
      html += '<tr class="avg"><td class="name">Promedio</td><td></td><td></td><td>' + fmt(state.auto.metrics.tpr) + '</td><td>' + fmt(state.auto.metrics.tpe) + '</td></tr>';
    }
    html += '</tbody></table>';
    if (manual) html += '<p class="hint">Completá los tiempos que calculaste (opcional): "Corregir" también los verifica. T<sub>E</sub> = T<sub>R</sub> − T<sub>CPU</sub>. Para editar los procesos usá la tabla del panel izquierdo.</p>';
    box.innerHTML = html;

    box.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var pid = inp.dataset.pid;
        state.manualMetrics[pid] = state.manualMetrics[pid] || {};
        state.manualMetrics[pid][inp.dataset.m] = inp.value === '' ? null : parseFloat(inp.value);
        inp.classList.remove('wrong', 'right');
      });
    });
    if (state.diff) markMetricInputs();
  }

  function fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2); }

  function markMetricInputs() {
    document.querySelectorAll('.metrics-box input').forEach(function (inp) {
      var r = state.diff.metrics[inp.dataset.pid + ':' + inp.dataset.m];
      if (r === undefined) return;
      inp.classList.add(r ? 'right' : 'wrong');
    });
  }

  /* ---------------- corrección ---------------- */

  function describe(c) {
    switch (c.s) {
      case 'cpu':   return 'CPU';
      case 'io':    return 'E/S en ' + c.r;
      case 'wait':  return 'nada — está BLOQUEADO esperando ' + c.r + ', que lo tiene otro proceso';
      case 'ready': return 'nada — está LISTO esperando la CPU';
      default:      return 'nada';
    }
  }

  function check() {
    var auto = state.auto;
    var wrong = {};
    var messages = [];
    var T = Math.max(state.horizon, auto.totalTime + 1);
    var total = 0, ok = 0;

    function flag(pid, t, msg) {
      wrong[pid + ':' + t] = wrong[pid + ':' + t] ? wrong[pid + ':' + t] + ' ' + msg : msg;
      messages.push(msg);
    }

    state.def.tasks.forEach(function (task, i) {
      var pid = i + 1;
      var p = auto.procs[i];
      for (var t = 0; t < T; t++) {
        // celdas
        var exp = autoCell(pid, t);
        var expKey = exp.s === 'cpu' ? 'cpu' : exp.s === 'io' ? 'io:' + exp.r : 'none';
        var got = manualCell(pid, t);
        var gotKey = got.s === 'cpu' ? 'cpu' : got.s === 'io' ? 'io:' + got.r : 'none';
        if (expKey !== 'none' || gotKey !== 'none') total++;
        if (expKey === gotKey) { if (expKey !== 'none') ok++; }
        else {
          var expTxt = exp.s === 'none' ? 'nada — todavía no llegó o ya terminó' : describe(exp);
          flag(pid, t, 't=' + t + ', tarea ' + task.name + ': marcaste ' + describe(got) + '; correcto: ' + expTxt + '.');
        }
        // marcadores ▲ ▼
        var mk = manualMarkers(pid, t);
        var expUp = p.arrival === t, expDown = p.finish === t;
        if (expUp || mk.up) total++;
        if (expDown || mk.down) total++;
        if (expUp === !!mk.up) { if (expUp) ok++; }
        else flag(pid, t, expUp
          ? 't=' + t + ', tarea ' + task.name + ': falta el ▲ de llegada (llega en t=' + p.arrival + ').'
          : 't=' + t + ', tarea ' + task.name + ': marcaste ▲ de llegada, pero llega en t=' + p.arrival + '.');
        if (expDown === !!mk.down) { if (expDown) ok++; }
        else flag(pid, t, expDown
          ? 't=' + t + ', tarea ' + task.name + ': falta el ▼ de fin (termina en t=' + p.finish + ').'
          : 't=' + t + ', tarea ' + task.name + ': marcaste ▼ de fin, pero termina en t=' + p.finish + '.');
      }
    });

    var metrics = {};
    var metricMsgs = [];
    auto.procs.forEach(function (p) {
      var mm = state.manualMetrics[p.pid] || {};
      [['tr', p.tr, 'T_R'], ['te', p.te, 'T_E']].forEach(function (m) {
        if (mm[m[0]] == null) return;
        var right = Math.abs(mm[m[0]] - m[1]) < 1e-9;
        metrics[p.pid + ':' + m[0]] = right;
        if (!right) metricMsgs.push('Tarea ' + p.name + ': ' + m[2] + ' correcto = ' + m[1] + ' (pusiste ' + mm[m[0]] + ').');
      });
    });
    var avg = state.manualMetrics.avg || {};
    [['tr', auto.metrics.tpr, 'TPR'], ['te', auto.metrics.tpe, 'TPE']].forEach(function (m) {
      if (avg[m[0]] == null) return;
      var right = Math.abs(avg[m[0]] - m[1]) < 0.011;
      metrics['avg:' + m[0]] = right;
      if (!right) metricMsgs.push(m[2] + ' correcto = ' + fmt(m[1]) + ' (pusiste ' + avg[m[0]] + ').');
    });

    state.diff = { wrong: wrong, messages: messages, metricMsgs: metricMsgs, metrics: metrics, total: total, ok: ok };
    state.horizon = Math.max(state.horizon, auto.totalTime + 1);
    render();
  }

  function renderFeedback() {
    var fb = $('feedback');
    var d = state.diff;
    if (!d || state.mode !== 'manual') { fb.classList.add('hidden'); return; }
    fb.classList.remove('hidden');
    var allOk = !d.messages.length && !d.metricMsgs.length;
    fb.className = 'feedback ' + (allOk ? 'ok' : 'bad');
    var html;
    if (allOk) {
      html = '<h3>✔ ¡Diagrama correcto!</h3><p>Coincide con la solución del simulador para ' + describeConfig(state.cfg) + '.'
        + (Object.keys(d.metrics).length ? ' Los tiempos que cargaste también están bien.' : '') + '</p>';
    } else {
      var n = d.messages.length;
      html = '<h3>✘ ' + n + ' error' + (n === 1 ? '' : 'es') + ' en el diagrama (' + d.ok + ' de ' + d.total + ' bien)'
        + (d.metricMsgs.length ? ' · ' + d.metricMsgs.length + ' tiempo' + (d.metricMsgs.length === 1 ? '' : 's') + ' mal' : '') + '</h3>';
      var list = d.messages.slice(0, 25).concat(d.metricMsgs);
      html += '<ul>' + list.map(function (m) { return '<li>' + escapeHtml(m) + '</li>'; }).join('') + '</ul>';
      if (n > 25) html += '<p class="more">… y ' + (n - 25) + ' más. Las celdas marcadas en rojo muestran el detalle al pasar el mouse.</p>';
      html += '<p class="hint">Tip: pasá a "Automático" para ver la solución completa con el log de eventos.</p>';
    }
    fb.innerHTML = html;
  }

  function renderLog() {
    if (state.mode !== 'auto') return;
    $('log').textContent = state.auto.events.map(function (e) { return 't=' + String(e.t).padStart(3, ' ') + '  ' + e.msg; }).join('\n');
  }

  /* ---------------- importar / exportar ---------------- */

  // Instantánea completa: procesos, algoritmo y diagrama manual.
  function snapshot() {
    return {
      app: 'rplanif', version: 1, savedAt: new Date().toISOString(),
      definition: $('definition').value,
      config: {
        algorithm: $('algorithm').value, quantum: $('quantum').value, preemptive: $('preemptive').checked,
        queues: $('queues').value, preemptedOrder: $('preempted-order').value,
      },
      manual: { cells: state.manual, markers: state.markers, metrics: state.manualMetrics, horizon: state.horizon },
    };
  }

  function exportFile() {
    var snap = snapshot();
    var stamp = snap.savedAt.slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
    var blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rplanif-' + stamp + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function applySnapshot(snap) {
    var c = snap.config || {};
    if (c.algorithm && QP.ALGORITHMS[c.algorithm] && !QP.ALGORITHMS[c.algorithm].hidden) $('algorithm').value = c.algorithm;
    if (c.quantum != null) $('quantum').value = c.quantum;
    if (c.preemptive != null) $('preemptive').checked = !!c.preemptive;
    if (c.queues != null) $('queues').value = c.queues;
    if (c.preemptedOrder && QP.PREEMPTED_ORDERS[c.preemptedOrder]) $('preempted-order').value = c.preemptedOrder;
    syncAlgorithmUI();
    $('definition').value = snap.definition || '';
    load('code');
    if (!state.def) return;                         // el código del archivo tenía errores: quedan listados
    var m = snap.manual || {};
    state.manual = m.cells || {};
    state.markers = m.markers || {};
    state.manualMetrics = m.metrics || {};
    state.horizon = Math.max(m.horizon || 0, state.auto.totalTime + 4, 16);
    state.diff = null;
    render();
  }

  // Acepta un .json exportado por rplanif o un .txt con código qplanif.
  function importText(text, name) {
    var snap = null;
    try { snap = JSON.parse(text); } catch (e) { /* no es JSON: lo trato como código */ }
    if (snap && typeof snap === 'object' && snap.app === 'rplanif') {
      applySnapshot(snap);
    } else if (snap && typeof snap === 'object') {
      showErrors(['El archivo "' + name + '" es JSON pero no fue generado por rplanif.']);
      return;
    } else {
      $('definition').value = text;
      load('code');
      if (state.def) { state.manual = {}; state.markers = {}; state.manualMetrics = {}; state.diff = null; render(); }
    }
    setSource('table');
  }

  /* ---------------- tema ---------------- */

  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    $('theme-toggle').textContent = theme === 'dark' ? '☀️ Claro' : '🌙 Oscuro';
    try { localStorage.setItem('rplanif.theme', theme); } catch (e) { /* sin storage */ }
  }

  /* ---------------- eventos ---------------- */

  Object.keys(QP.ALGORITHMS).forEach(function (k) {
    if (QP.ALGORITHMS[k].hidden) return;
    var o = document.createElement('option'); o.value = k; o.textContent = QP.ALGORITHMS[k].label; $('algorithm').appendChild(o);
  });
  Object.keys(QP.PREEMPTED_ORDERS).forEach(function (k) {
    var o = document.createElement('option'); o.value = k; o.textContent = QP.PREEMPTED_ORDERS[k]; $('preempted-order').appendChild(o);
  });
  $('btn-export').addEventListener('click', exportFile);
  $('btn-import').addEventListener('click', function () { $('file-input').value = ''; $('file-input').click(); });
  $('file-input').addEventListener('change', function () {
    var f = $('file-input').files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { importText(String(reader.result), f.name); };
    reader.readAsText(f);
  });
  $('theme-toggle').addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  ['algorithm', 'quantum', 'preemptive', 'queues', 'preempted-order'].forEach(function (id) {
    $(id).addEventListener('change', function () { syncAlgorithmUI(); if (state.def) load('table'); });
  });
  $('src-table').addEventListener('click', function () { setSource('table'); });
  $('src-code').addEventListener('click', function () { setSource('code'); });
  $('btn-load').addEventListener('click', function () { load('code'); });
  $('definition').addEventListener('keydown', function (e) { if (e.ctrlKey && e.key === 'Enter') load('code'); });
  $('resources-input').addEventListener('change', function () {
    state.table.resources = $('resources-input').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    tableToCode();
  });
  $('btn-add-task').addEventListener('click', addTask);
  $('mode-manual').addEventListener('click', function () { setMode('manual'); });
  $('mode-auto').addEventListener('click', function () { setMode('auto'); });
  $('btn-check').addEventListener('click', check);
  $('btn-clear').addEventListener('click', function () { state.manual = {}; state.markers = {}; state.manualMetrics = {}; state.diff = null; render(); });
  $('btn-more').addEventListener('click', function () { state.horizon += 5; render(); });

  // arranque
  var saved = null;
  try {
    saved = localStorage.getItem('rplanif.definition');
    var savedOrder = localStorage.getItem('rplanif.preemptedOrder');
    if (savedOrder && QP.PREEMPTED_ORDERS[savedOrder]) $('preempted-order').value = savedOrder;
  } catch (e) { /* sin storage */ }
  $('definition').value = saved !== null ? saved : DEFAULT_DEFINITION;
  $('theme-toggle').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️ Claro' : '🌙 Oscuro';
  syncAlgorithmUI();
  load('code');
})();
