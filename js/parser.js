/*
 * rplanif — parser del formato de entrada de qplanif.
 *
 *   #Ejemplo 2
 *   RECURSO ''R1''
 *   RECURSO ''R2''
 *   TAREA ''1'' PRIORIDAD=3 INICIO=0
 *   [CPU,3] [1,2] [CPU,2]
 *
 * - RECURSO define un dispositivo de E/S (cola FIFO propia).
 * - TAREA abre un proceso; PRIORIDAD/INICIO y las ráfagas pueden ir en la
 *   misma línea o en las siguientes.
 * - [CPU,n]  ráfaga de CPU de n instantes.
 * - [k,n]    ráfaga de E/S de n instantes en el k-ésimo recurso declarado
 *            (también se acepta el nombre: [R1,n]).
 * - Los comentarios empiezan con #.
 *
 * Funciona en el navegador (window.RPlanif.parse) y en Node (module.exports).
 */
(function (root) {
  'use strict';

  var TOKEN = new RegExp(
    [
      "(RECURSO|TAREA)\\s+(?:''([^']*)''|\"([^\"]*)\"|'([^']*)'|(\\S+))", // 1..5
      '(PRIORIDAD|INICIO)\\s*=\\s*(-?\\d+)',                              // 6,7
      '\\[\\s*([^,\\]\\s]+)\\s*,\\s*(\\d+)\\s*\\]',                          // 8,9
      '(\\S+)',                                                          // 10
    ].join('|'),
    'gi'
  );

  // Regla de los nombres (tareas y recursos): no vacíos y sin comillas, porque el formato
  // los delimita con ''nombre''. Devuelve el mensaje de error o null si es válido.
  function validateName(name) {
    if (!String(name || '').trim()) return 'El nombre no puede estar vacío';
    if (/['"]/.test(name)) return "El nombre no puede contener comillas: el formato lo escribe como ''nombre''";
    return null;
  }

  function parse(text) {
    var resources = [];
    var tasks = [];
    var errors = [];
    var current = null;

    String(text || '').split(/\r?\n/).forEach(function (raw, i) {
      var lineNo = i + 1;
      var line = raw.replace(/#.*$/, '').trim();
      if (!line) return;

      TOKEN.lastIndex = 0;
      var m;
      while ((m = TOKEN.exec(line))) {
        if (m[1]) {
          var name = [m[2], m[3], m[4], m[5]].find(function (v) { return v !== undefined; });
          var bad = validateName(name);
          if (bad) errors.push('Línea ' + lineNo + ': ' + bad.charAt(0).toLowerCase() + bad.slice(1) + ' (' + m[1].toUpperCase() + ')');
          if (m[1].toUpperCase() === 'RECURSO') {
            if (resources.indexOf(name) >= 0) errors.push('Línea ' + lineNo + ': recurso "' + name + '" repetido');
            else resources.push(name);
          } else {
            if (tasks.some(function (t) { return t.name === name; })) errors.push('Línea ' + lineNo + ': tarea "' + name + '" repetida');
            current = { name: name, arrival: 0, priority: 0, bursts: [] };
            tasks.push(current);
          }
        } else if (m[6]) {
          if (!current) { errors.push('Línea ' + lineNo + ': ' + m[6] + ' fuera de una TAREA'); continue; }
          var value = parseInt(m[7], 10);
          if (m[6].toUpperCase() === 'PRIORIDAD') current.priority = value;
          else {
            if (value < 0) errors.push('Línea ' + lineNo + ': INICIO no puede ser negativo');
            current.arrival = value;
          }
        } else if (m[8]) {
          if (!current) { errors.push('Línea ' + lineNo + ': ráfaga fuera de una TAREA'); continue; }
          var what = m[8];
          var dur = parseInt(m[9], 10);
          if (dur <= 0) { errors.push('Línea ' + lineNo + ': la duración de [' + what + ',' + dur + '] debe ser mayor a 0'); continue; }
          if (what.toUpperCase() === 'CPU') {
            current.bursts.push({ type: 'cpu', dur: dur });
          } else {
            var rname = /^\d+$/.test(what) ? resources[parseInt(what, 10) - 1] : what;
            if (!rname || resources.indexOf(rname) < 0) {
              errors.push('Línea ' + lineNo + ': recurso "' + what + '" no definido (declaralo antes con RECURSO)');
              continue;
            }
            current.bursts.push({ type: 'io', resource: rname, dur: dur });
          }
        } else if (m[10]) {
          errors.push(/['"]/.test(m[10])
            ? 'Línea ' + lineNo + ': no entiendo "' + m[10] + "\" — los nombres van entre comillas simples dobles (''nombre'') y no pueden contener comillas"
            : 'Línea ' + lineNo + ': no entiendo "' + m[10] + '"');
        }
      }
    });

    tasks.forEach(function (t) {
      if (!t.bursts.length) errors.push('La tarea "' + t.name + '" no tiene ráfagas');
    });

    return { resources: resources, tasks: tasks, errors: errors };
  }

  /* ---------------- notación de la tabla: (recurso, instante, duración) ----------------
   * Es la del apunte (Job | Llegada | CPU | E/S (rec., inst., dur.)): el "instante" es la
   * CPU que el proceso ya consumió cuando pide esa E/S, y el resto de su CPU va después.
   * Con CPU=5 y (R1,3,2) las ráfagas son [CPU,3] [R1,2] [CPU,2].
   */

  var IO_SPEC = /\(\s*([^,()\s]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;

  // Texto → lista de E/S. Devuelve también lo que no pudo interpretar.
  function parseIoSpec(text) {
    text = String(text == null ? '' : text).trim();
    var list = [], errors = [];
    if (!text) return { list: list, errors: errors };
    IO_SPEC.lastIndex = 0;
    var m, consumed = '';
    while ((m = IO_SPEC.exec(text))) {
      list.push({ resource: m[1], at: parseInt(m[2], 10), dur: parseInt(m[3], 10) });
      consumed += m[0];
    }
    if (!list.length || text.replace(/[\s,]/g, '').length !== consumed.replace(/[\s,]/g, '').length) {
      errors.push('La E/S se escribe entre paréntesis: (recurso, instante, duración) — por ejemplo (R1,3,2)');
    }
    return { list: list, errors: errors };
  }

  function ioToString(list) {
    return (list || []).map(function (e) { return '(' + e.resource + ',' + e.at + ',' + e.dur + ')'; }).join(' ');
  }

  // CPU total + E/S → ráfagas. resources sirve para validar y para resolver índices.
  function specToBursts(cpu, io, resources) {
    resources = resources || [];
    var errors = [];
    var total = parseInt(cpu, 10);
    if (isNaN(total) || total < 0) { total = 0; errors.push('La CPU total debe ser un número mayor o igual a 0'); }

    var parsed = typeof io === 'string' ? parseIoSpec(io) : { list: (io || []).slice(), errors: [] };
    errors = errors.concat(parsed.errors);

    var list = parsed.list.map(function (e, i) {
      var name = /^\d+$/.test(e.resource) ? resources[parseInt(e.resource, 10) - 1] : e.resource;
      if (!name || resources.indexOf(name) < 0) errors.push('El recurso "' + e.resource + '" no está definido');
      if (e.dur <= 0) errors.push('La duración de la E/S en "' + e.resource + '" debe ser mayor a 0');
      if (e.at > total) errors.push('El instante ' + e.at + ' de la E/S en "' + e.resource + '" supera la CPU total (' + total + ')');
      return { resource: name, at: e.at, dur: e.dur, order: i };
    });
    if (!total && !list.length) errors.push('El proceso necesita CPU o al menos una E/S');
    if (errors.length) return { bursts: [], errors: errors };

    // orden estable por instante: las E/S parten la CPU en tramos
    list.sort(function (a, b) { return a.at - b.at || a.order - b.order; });
    var bursts = [], used = 0;
    list.forEach(function (e) {
      if (e.at > used) { bursts.push({ type: 'cpu', dur: e.at - used }); used = e.at; }
      bursts.push({ type: 'io', resource: e.resource, dur: e.dur });
    });
    if (total > used) bursts.push({ type: 'cpu', dur: total - used });
    return { bursts: bursts, errors: [] };
  }

  // Ráfagas → CPU total + E/S (para mostrar la definición en la tabla).
  function burstsToSpec(bursts) {
    var cpu = 0, io = [];
    (bursts || []).forEach(function (b) {
      if (b.type === 'cpu') cpu += b.dur;
      else io.push({ resource: b.resource, at: cpu, dur: b.dur });
    });
    return { cpu: cpu, io: io };
  }

  // Ráfagas → texto con el formato de entrada. Usa el nombre del recurso ([R1,2]).
  function burstsToString(bursts) {
    return (bursts || []).map(function (b) {
      return b.type === 'cpu' ? '[CPU,' + b.dur + ']' : '[' + b.resource + ',' + b.dur + ']';
    }).join(' ');
  }

  // Definición, o modelo de la tabla (con bursts como string, o con cpu + io) → código qplanif.
  function serialize(def) {
    var resources = def.resources || [];
    var lines = resources.map(function (r) { return "RECURSO ''" + r + "''"; });
    (def.tasks || []).forEach(function (t) {
      lines.push("TAREA ''" + t.name + "'' PRIORIDAD=" + (t.priority || 0) + ' INICIO=' + (t.arrival || 0));
      var bursts = t.bursts;
      if (bursts === undefined) bursts = specToBursts(t.cpu, t.io, resources).bursts;
      lines.push(typeof bursts === 'string' ? bursts : burstsToString(bursts));
    });
    return lines.join('\n') + '\n';
  }

  var api = { parse: parse, serialize: serialize, burstsToString: burstsToString, validateName: validateName,
              specToBursts: specToBursts, burstsToSpec: burstsToSpec, ioToString: ioToString };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RPlanif = Object.assign(root.RPlanif || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
