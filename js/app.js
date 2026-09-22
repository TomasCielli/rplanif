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
  // Devuelve true si la definición se cargó (sin errores de parseo ni de simulación).
  function load(source) {
    var def = QP.parse($('definition').value);
    showErrors(def.errors);
    if (def.errors.length) return false;

    if (source !== 'table') { tableFromDef(def); renderTable(); }

    // El diagrama manual está indexado por posición (pid), así que sobrevive a renombrar o
    // editar atributos; sólo se descarta si cambia la cantidad de procesos.
    var sameTasks = !!state.def && state.def.tasks.length === def.tasks.length;
    if (!sameTasks) { state.manual = {}; state.markers = {}; state.manualMetrics = {}; }

    state.def = def;
    state.cfg = readConfig();
    state.diff = null;
    try {
      state.auto = QP.simulate(def, state.cfg);
    } catch (err) {
      state.auto = null;
      showErrors([err.message]);
      return false;
    }
    state.horizon = sameTasks
      ? Math.max(state.horizon, state.auto.totalTime + 4, 16)
      : Math.max(state.auto.totalTime + 4, 16);
    if (state.brush.indexOf('io:') === 0 && def.resources.indexOf(state.brush.slice(3)) < 0) state.brush = 'cpu';
    render();
    return true;
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
        if (f === 'name') {
          var bad = QP.validateName(inp.value);
          inp.classList.toggle('invalid', !!bad);
          if (bad) { showErrors([bad + ' (proceso ' + (+inp.dataset.i + 1) + ')']); return; }
        }
        if (f === 'arrival' || f === 'priority') t[f] = parseInt(inp.value, 10) || 0;
        else t[f] = inp.value.trim();
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
    $('manual-actions').classList.toggle('hidden', mode !== 'manual');
    $('log-box').classList.toggle('hidden', mode !== 'auto');
    render();
  }

  function persist() {
    try { localStorage.setItem('rplanif.snapshot', JSON.stringify(snapshot())); } catch (e) { /* sin storage */ }
  }

  function render() {
    if (!state.def || !state.auto) return;
    persist();
    if (!state.def.tasks.length) { renderEmpty(); return; }
    $('status').textContent = describeConfig(state.cfg) + (state.mode === 'manual'
      ? ' — dibujá el diagrama y apretá "Corregir".'
      : ' — solución calculada por el simulador (' + state.auto.totalTime + ' instantes).');
    renderBrushes();
    renderHorizon();
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
    renderHorizon();
  }

  function renderHorizon() {
    $('horizon-count').textContent = state.horizon;
    $('horizon-value').textContent = state.horizon;
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
    grid.style.gridTemplateColumns = 'var(--label) repeat(' + T + ', var(--cell))';

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
    persist();
  }

  function clearWrongMarks() {
    document.querySelectorAll('.cell.wrong').forEach(function (c) { c.classList.remove('wrong'); c.removeAttribute('title'); });
    document.querySelectorAll('.metrics-box input').forEach(function (i) { i.classList.remove('wrong', 'right'); });
  }

  var lastPointerType = 'mouse';
  $('gantt').addEventListener('pointerdown', function (e) {
    lastPointerType = e.pointerType;
    if (state.mode !== 'manual' || e.pointerType !== 'mouse' || e.button !== 0) return;
    var cell = e.target.closest('.cell');
    if (!cell) return;
    e.preventDefault();
    state.painting = true;
    paint(cell, false);
  });
  $('gantt').addEventListener('pointerover', function (e) {
    if (!state.painting || e.pointerType !== 'mouse') return;
    paint(e.target.closest('.cell'), true);
  });
  // Con el dedo o lápiz: "click" sólo llega si no hubo desplazamiento → tocar pinta, arrastrar hace scroll.
  $('gantt').addEventListener('click', function (e) {
    if (state.mode !== 'manual' || lastPointerType === 'mouse') return;
    var cell = e.target.closest('.cell');
    if (cell) paint(cell, false);
  });
  window.addEventListener('pointerup', function () { state.painting = false; });
  window.addEventListener('pointercancel', function () { state.painting = false; });
  document.addEventListener('mouseleave', function () { state.painting = false; });

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
        persist();
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
    var stamp = timestamp();
    downloadBlob(new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' }), 'rplanif-' + stamp + '.json');
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function timestamp() {
    return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
  }

  /* ---------------- exportar imagen ---------------- */

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // Modelo de filas del Gantt visible (mismo contenido que renderGantt, sin DOM).
  function ganttRows() {
    var manual = state.mode === 'manual';
    var T = manual ? state.horizon : state.auto.totalTime + 1;
    var rows = [];
    if (!manual) rows.push({ label: 'CPU', sub: '', summary: state.auto.cpuTimeline });
    state.def.tasks.forEach(function (task, i) {
      var pid = i + 1, cells = [], marks = [];
      for (var t = 0; t < T; t++) {
        cells.push(manual ? manualCell(pid, t) : autoCell(pid, t));
        marks.push(manual ? manualMarkers(pid, t) : autoMarkers(pid, t));
      }
      rows.push({
        label: task.name,
        sub: 'llega ' + task.arrival + (state.cfg.algorithm === 'PRIORITY' ? ' · prio ' + task.priority : ''),
        cells: cells, marks: marks,
      });
    });
    if (!manual) state.auto.resources.forEach(function (r) { rows.push({ label: r.name, sub: 'recurso', summary: r.timeline }); });
    return { T: T, rows: rows, manual: manual };
  }

  function exportImage() {
    if (!state.def || !state.auto || !state.def.tasks.length) return;
    var m = ganttRows();
    var S = 2, pad = 20, labelW = 150, cellW = 30, rowH = 36, headH = 28, titleH = 28, legendH = 30;
    var W = pad * 2 + labelW + m.T * cellW;
    var H = pad * 2 + titleH + headH + m.rows.length * rowH + legendH;
    var cv = document.createElement('canvas');
    cv.width = W * S; cv.height = H * S;
    var ctx = cv.getContext('2d');
    ctx.scale(S, S);
    var C = {
      bg: cssVar('--panel'), text: cssVar('--text'), muted: cssVar('--muted'), border: cssVar('--border'),
      soft: cssVar('--border-soft'), tick: cssVar('--border-tick'), cpu: cssVar('--cpu'), io: cssVar('--io'),
      wait: cssVar('--wait'), wait2: cssVar('--wait-2'), ready: cssVar('--ready'), dot: cssVar('--ready-dot'),
      panel2: cssVar('--panel-2'), panel3: cssVar('--panel-3'), idle: cssVar('--idle'),
    };
    var FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';
    var x0 = pad + labelW, y0 = pad + titleH;

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';

    // título
    ctx.fillStyle = C.text; ctx.font = 'bold 14px ' + FONT; ctx.textAlign = 'left';
    ctx.fillText('rplanif — ' + describeConfig(state.cfg) + (m.manual ? '  ·  diagrama manual' : '  ·  solución del simulador'), pad, pad + titleH / 2 - 4);

    // cabecera de tiempos
    ctx.textAlign = 'center'; ctx.font = '11px ' + FONT;
    for (var t = 0; t < m.T; t++) {
      ctx.fillStyle = t % 5 === 0 ? C.text : C.muted;
      ctx.font = (t % 5 === 0 ? 'bold ' : '') + '11px ' + FONT;
      ctx.fillText(String(t), x0 + t * cellW + cellW / 2, y0 + headH / 2);
    }
    hline(y0 + headH);

    m.rows.forEach(function (row, ri) {
      var y = y0 + headH + ri * rowH;
      // etiqueta
      ctx.fillStyle = row.summary ? C.panel3 : C.panel2;
      ctx.fillRect(pad, y, labelW, rowH);
      ctx.textAlign = 'left'; ctx.fillStyle = C.text; ctx.font = 'bold 13px ' + FONT;
      ctx.fillText(row.label, pad + 10, y + rowH / 2);
      if (row.sub) {
        var lw = ctx.measureText(row.label).width;
        ctx.font = '11px ' + FONT; ctx.fillStyle = C.muted;
        ctx.fillText(row.sub, pad + 10 + lw + 6, y + rowH / 2);
      }
      for (var t = 0; t < m.T; t++) {
        var x = x0 + t * cellW;
        if (row.summary) {
          ctx.fillStyle = C.panel2; ctx.fillRect(x, y, cellW, rowH);
          var pid = row.summary[t];
          ctx.textAlign = 'center';
          ctx.fillStyle = pid == null ? C.idle : C.text;
          ctx.font = (pid == null ? '' : 'bold ') + '11px ' + FONT;
          ctx.fillText(pid == null ? '·' : state.auto.procs[pid - 1].name, x + cellW / 2, y + rowH / 2);
        } else {
          var c = row.cells[t], by = y + 8, bh = rowH - 16;
          if (c.s === 'cpu' || c.s === 'io') {
            ctx.fillStyle = c.s === 'cpu' ? C.cpu : resourceColor(c.r);
            ctx.fillRect(x, by, cellW, bh);
            if (c.s === 'io') { ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '10px ' + FONT; ctx.fillText(c.r, x + cellW / 2, by + bh / 2); }
          } else if (c.s === 'wait') {
            ctx.save(); ctx.beginPath(); ctx.rect(x, by, cellW, bh); ctx.clip();
            ctx.fillStyle = C.wait2; ctx.fillRect(x, by, cellW, bh);
            ctx.strokeStyle = C.wait; ctx.lineWidth = 3;
            for (var k = -bh; k < cellW + bh; k += 8) { ctx.beginPath(); ctx.moveTo(x + k, by + bh); ctx.lineTo(x + k + bh, by); ctx.stroke(); }
            ctx.restore();
            ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.font = '10px ' + FONT; ctx.fillText('⏳' + c.r, x + cellW / 2, by + bh / 2);
          } else if (c.s === 'ready') {
            ctx.fillStyle = C.ready; ctx.fillRect(x, by, cellW, bh);
            ctx.fillStyle = C.dot; ctx.beginPath(); ctx.arc(x + cellW / 2, by + bh / 2, 2.5, 0, Math.PI * 2); ctx.fill();
          }
        }
        // separador vertical
        ctx.beginPath();
        ctx.setLineDash(t % 5 === 4 ? [] : [1, 2]);
        ctx.strokeStyle = t % 5 === 4 ? C.tick : C.soft; ctx.lineWidth = 1;
        ctx.moveTo(x + cellW + 0.5, y); ctx.lineTo(x + cellW + 0.5, y + rowH); ctx.stroke();
        ctx.setLineDash([]);
      }
      // marcadores (encima de las barras y separadores)
      if (!row.summary) {
        for (var t2 = 0; t2 < m.T; t2++) {
          var mk = row.marks[t2], mx = x0 + t2 * cellW;
          ctx.fillStyle = C.io;
          if (mk.up) { ctx.beginPath(); ctx.moveTo(mx - 6, y + rowH); ctx.lineTo(mx + 6, y + rowH); ctx.lineTo(mx, y + rowH - 8); ctx.closePath(); ctx.fill(); }
          if (mk.down) { ctx.beginPath(); ctx.moveTo(mx - 6, y); ctx.lineTo(mx + 6, y); ctx.lineTo(mx, y + 8); ctx.closePath(); ctx.fill(); }
        }
      }
      hline(y + rowH);
    });
    // borde izquierdo de la grilla
    ctx.strokeStyle = C.border; ctx.beginPath(); ctx.moveTo(x0 + 0.5, y0); ctx.lineTo(x0 + 0.5, y0 + headH + m.rows.length * rowH); ctx.stroke();

    // leyenda
    var ly = y0 + headH + m.rows.length * rowH + legendH / 2 + 6, lx = pad;
    var items = [[C.cpu, 'Uso de CPU']];
    state.def.resources.forEach(function (r) { items.push([resourceColor(r), 'E/S ' + r]); });
    if (!m.manual) items.push([C.wait, 'Bloqueado esperando el recurso'], [C.ready, 'Listo (esperando CPU)']);
    items.push(['▲', 'Llegada al sistema'], ['▼', 'Fin del proceso']);
    ctx.font = '11px ' + FONT; ctx.textAlign = 'left';
    items.forEach(function (it) {
      if (it[0] === '▲' || it[0] === '▼') {
        ctx.fillStyle = C.io; ctx.beginPath();
        if (it[0] === '▲') { ctx.moveTo(lx, ly + 5); ctx.lineTo(lx + 12, ly + 5); ctx.lineTo(lx + 6, ly - 4); }
        else { ctx.moveTo(lx, ly - 4); ctx.lineTo(lx + 12, ly - 4); ctx.lineTo(lx + 6, ly + 5); }
        ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = it[0]; ctx.fillRect(lx, ly - 5, 14, 10);
        ctx.strokeStyle = C.border; ctx.strokeRect(lx + 0.5, ly - 4.5, 13, 9);
      }
      ctx.fillStyle = C.muted;
      ctx.fillText(it[1], lx + 19, ly);
      lx += 19 + ctx.measureText(it[1]).width + 16;
    });

    cv.toBlob(function (blob) { downloadBlob(blob, 'rplanif-gantt-' + timestamp() + '.png'); }, 'image/png');

    function hline(yy) {
      ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(pad, yy + 0.5); ctx.lineTo(W - pad, yy + 0.5); ctx.stroke();
    }
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
    if (!load('code')) return false;                // el código del archivo tenía errores: quedan listados
    var m = snap.manual || {};
    state.manual = m.cells || {};
    state.markers = m.markers || {};
    state.manualMetrics = m.metrics || {};
    state.horizon = Math.max(m.horizon || 0, state.auto.totalTime + 4, 16);
    state.diff = null;
    render();
    return true;
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
      if (load('code')) { state.manual = {}; state.markers = {}; state.manualMetrics = {}; state.diff = null; render(); }
    }
    setSource('table');
  }

  /* ---------------- tema ---------------- */

  function themeIcon() {
    var icon = $('theme-toggle').querySelector('.disco');
    if (icon.classList.contains('party')) return;
    icon.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '🌙' : '☀️';
  }

  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    $('theme-toggle').title = theme === 'dark' ? 'Tema oscuro (clic para claro)' : 'Tema claro (clic para oscuro)';
    themeIcon();
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
  var themeClicks = [];
  $('theme-toggle').addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    var now = Date.now();
    themeClicks = themeClicks.filter(function (t) { return now - t < 3000; });
    themeClicks.push(now);
    if (themeClicks.length >= 4) {
      themeClicks = [];
      var disco = $('theme-toggle').querySelector('.disco');
      disco.textContent = '🪩'; disco.classList.add('party');
      setTimeout(function () { disco.classList.remove('party'); themeIcon(); }, 4000);
      window.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1', '_blank', 'noopener');
    }
  });
  ['algorithm', 'quantum', 'preemptive', 'queues', 'preempted-order'].forEach(function (id) {
    $(id).addEventListener('change', function () { syncAlgorithmUI(); if (state.def) load('table'); });
  });
  $('src-table').addEventListener('click', function () { setSource('table'); });
  $('src-code').addEventListener('click', function () { setSource('code'); });
  $('btn-load').addEventListener('click', function () { load('code'); });
  $('definition').addEventListener('keydown', function (e) { if (e.ctrlKey && e.key === 'Enter') load('code'); });
  $('resources-input').addEventListener('change', function () {
    var names = $('resources-input').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var bad = null;
    names.forEach(function (n) { bad = bad || QP.validateName(n); });
    $('resources-input').classList.toggle('invalid', !!bad);
    if (bad) { showErrors([bad + ' (recursos)']); return; }
    state.table.resources = names;
    tableToCode();
  });
  $('btn-image').addEventListener('click', exportImage);
  $('btn-add-task').addEventListener('click', addTask);
  $('mode-manual').addEventListener('click', function () { setMode('manual'); });
  $('mode-auto').addEventListener('click', function () { setMode('auto'); });
  $('btn-check').addEventListener('click', check);
  $('btn-clear').addEventListener('click', function () { state.manual = {}; state.markers = {}; state.manualMetrics = {}; state.diff = null; render(); });
  $('horizon-stepper').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-d]');
    if (!b) return;
    state.horizon = Math.max(5, state.horizon + parseInt(b.dataset.d, 10));
    render();
  });
  // el desplegable se cierra al hacer clic afuera
  document.addEventListener('pointerdown', function (e) {
    var box = $('horizon-box');
    if (box.open && !box.contains(e.target)) box.open = false;
  });

  /* ---------------- minicalculadora ---------------- */

  (function calculator() {
    var expr = $('calc-expr'), result = $('calc-result'), history = $('calc-history');
    var entries = [];

    function fmtNum(n) { return String(Math.round(n * 100) / 100).replace('.', ','); }

    function preview() {
      var text = expr.value;
      if (!text.trim()) { result.innerHTML = '&nbsp;'; result.classList.remove('err'); return; }
      var v = QP.evaluate(text);
      if (v === null) { result.textContent = 'expresión incompleta'; result.classList.add('err'); }
      else { result.textContent = fmtNum(v); result.classList.remove('err'); }
    }

    function insert(text) {
      var s = expr.selectionStart, e = expr.selectionEnd, v = expr.value;
      expr.value = v.slice(0, s) + text + v.slice(e);
      expr.selectionStart = expr.selectionEnd = s + text.length;
      preview();
    }

    function compute() {
      var v = QP.evaluate(expr.value);
      if (v === null) { preview(); return; }
      entries.unshift({ expr: expr.value.trim(), value: v });
      entries = entries.slice(0, 6);
      history.innerHTML = entries.map(function (en, i) {
        return '<li data-i="' + i + '"><span>' + escapeHtml(en.expr) + '</span><b>= ' + fmtNum(en.value) + '</b></li>';
      }).join('');
      expr.value = fmtNum(v);          // el resultado queda para encadenar operaciones
      preview();
    }

    expr.addEventListener('input', preview);
    expr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); compute(); }
      if (e.key === 'Escape') { expr.value = ''; preview(); }
    });
    // pointerdown + preventDefault: los botones no roban el foco del campo
    $('calc-keys').addEventListener('pointerdown', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      e.preventDefault();
      expr.focus();
      if (b.dataset.k) insert(b.dataset.k);
      else if (b.dataset.a === 'clear') { expr.value = ''; preview(); }
      else if (b.dataset.a === 'back') {
        var s = expr.selectionStart, en = expr.selectionEnd;
        if (s === en && s > 0) s--;
        expr.value = expr.value.slice(0, s) + expr.value.slice(en);
        expr.selectionStart = expr.selectionEnd = s;
        preview();
      }
      else if (b.dataset.a === 'eq') compute();
    });
    history.addEventListener('click', function (e) {
      var li = e.target.closest('li');
      if (!li) return;
      expr.focus();
      insert(fmtNum(entries[+li.dataset.i].value));
    });
  })();

  /* ---------------- bloques plegables y calculadora movible ---------------- */

  (function layoutUI() {
    var ui = { sections: {}, calc: { floating: false, x: 0, y: 0, collapsed: false } };
    try { ui = Object.assign(ui, JSON.parse(localStorage.getItem('rplanif.ui') || '{}')); } catch (e) { /* sin storage */ }
    function saveUI() { try { localStorage.setItem('rplanif.ui', JSON.stringify(ui)); } catch (e) { /* sin storage */ } }

    // secciones: recordar abierto/cerrado
    document.querySelectorAll('details[id]').forEach(function (d) {
      if (ui.sections[d.id] !== undefined) d.open = ui.sections[d.id];
      d.addEventListener('toggle', function () { ui.sections[d.id] = d.open; saveUI(); });
    });

    var calc = $('calc'), head = $('calc-head');
    var narrow = function () { return window.innerWidth < 900; };

    function applyCalc() {
      calc.classList.toggle('collapsed', !!ui.calc.collapsed);
      $('calc-min').textContent = ui.calc.collapsed ? '+' : '–';
      var floating = ui.calc.floating && !narrow();     // en celular siempre acoplada
      calc.classList.toggle('floating', floating);
      $('calc-dock').classList.toggle('hidden', !floating);
      if (floating) place(ui.calc.x, ui.calc.y); else { calc.style.left = ''; calc.style.top = ''; }
    }
    function place(x, y) {
      var r = calc.getBoundingClientRect();
      x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - r.width));
      y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - r.height));
      calc.style.left = x + 'px'; calc.style.top = y + 'px';
      ui.calc.x = x; ui.calc.y = y;
    }

    $('calc-min').addEventListener('click', function () { ui.calc.collapsed = !ui.calc.collapsed; applyCalc(); saveUI(); });
    $('calc-dock').addEventListener('click', function () { ui.calc.floating = false; applyCalc(); saveUI(); });

    // arrastre desde el título (mouse o dedo); al soltar queda flotando en esa posición
    var drag = null;
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button') || narrow()) return;
      var r = calc.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, x0: e.clientX, y0: e.clientY };
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    head.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 4) return;
        drag.moved = true;
        ui.calc.floating = true;
        calc.classList.add('floating', 'dragging');
        $('calc-dock').classList.remove('hidden');
      }
      place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      calc.classList.remove('dragging');
      drag = null;
      saveUI();
    }
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', applyCalc);
    applyCalc();
  })();

  // arranque
  $('theme-toggle').title = document.documentElement.getAttribute('data-theme') === 'dark' ? 'Tema oscuro (clic para claro)' : 'Tema claro (clic para oscuro)';
  themeIcon();
  var restored = false;
  try {
    var raw = localStorage.getItem('rplanif.snapshot');
    if (raw) {
      restored = applySnapshot(JSON.parse(raw));
    } else {
      // versiones anteriores guardaban sólo la definición
      var legacy = localStorage.getItem('rplanif.definition');
      if (legacy !== null) {
        var legacyOrder = localStorage.getItem('rplanif.preemptedOrder');
        if (legacyOrder && QP.PREEMPTED_ORDERS[legacyOrder]) $('preempted-order').value = legacyOrder;
        $('definition').value = legacy;
        syncAlgorithmUI();
        restored = load('code');
      }
    }
  } catch (e) { restored = false; }
  if (!restored) {
    $('definition').value = DEFAULT_DEFINITION;
    syncAlgorithmUI();
    load('code');
  }
})();
