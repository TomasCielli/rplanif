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
          errors.push('Línea ' + lineNo + ': no entiendo "' + m[10] + '"');
        }
      }
    });

    if (!tasks.length && !errors.length) errors.push('No hay ninguna TAREA definida');
    tasks.forEach(function (t) {
      if (!t.bursts.length) errors.push('La tarea "' + t.name + '" no tiene ráfagas');
    });

    return { resources: resources, tasks: tasks, errors: errors };
  }

  // Ráfagas → texto con el formato de entrada. Usa el nombre del recurso ([R1,2]).
  function burstsToString(bursts) {
    return (bursts || []).map(function (b) {
      return b.type === 'cpu' ? '[CPU,' + b.dur + ']' : '[' + b.resource + ',' + b.dur + ']';
    }).join(' ');
  }

  // Definición (o modelo de la tabla, con bursts como string) → código qplanif.
  function serialize(def) {
    var lines = (def.resources || []).map(function (r) { return "RECURSO ''" + r + "''"; });
    (def.tasks || []).forEach(function (t) {
      lines.push("TAREA ''" + t.name + "'' PRIORIDAD=" + (t.priority || 0) + ' INICIO=' + (t.arrival || 0));
      lines.push(typeof t.bursts === 'string' ? t.bursts : burstsToString(t.bursts));
    });
    return lines.join('\n') + '\n';
  }

  var api = { parse: parse, serialize: serialize, burstsToString: burstsToString };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RPlanif = Object.assign(root.RPlanif || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
