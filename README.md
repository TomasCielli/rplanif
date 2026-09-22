# rplanif

Simulador de planificación de CPU para practicar diagramas de Gantt, basado en la
*Explicación de práctica — Administración de Procesos* (Introducción a los Sistemas
Operativos / Conceptos de Sistemas Operativos, Facultad de Informática, UNLP).

La idea: **dibujás el diagrama a mano, después lo corregís con el simulador.**

## Cómo usarlo

Abrí `index.html` en cualquier navegador. No hay que instalar nada.

1. **Procesos**: editá la **tabla** (Job, Llegada, Prio, Ráfagas; agregar / eliminar
   procesos; recursos separados por coma), escribí el **código** con el formato de
   qplanif, o **importá un archivo** (ver más abajo). Tabla y código están sincronizados en los dos
   sentidos: lo que tocás en la tabla genera el código, y el código cargado rellena la tabla.

   ```
   RECURSO ''R1''
   TAREA ''1'' PRIORIDAD=2 INICIO=0
   [CPU,3] [1,2] [CPU,2]
   ```

   - `[CPU,n]` ráfaga de CPU de *n* instantes.
   - `[k,n]` E/S de *n* instantes en el *k*-ésimo recurso declarado (también vale `[R1,n]`).
   - `#` comentario. `PRIORIDAD` e `INICIO` valen 0 si no se indican.

2. **Algoritmo**: FIFO, SJF, SRTF, Round Robin (quantum) o Prioridades (apropiativo o
   no). Las colas multinivel están implementadas pero ocultas porque la práctica de la
   comisión no las usa (`ALGORITHMS.MLFQ.hidden` en `js/scheduler.js`).

3. **Manual**: elegí un pincel (CPU, E/S en cada recurso, ▲ Llegada, ▼ Fin, Borrar) y
   pintá las celdas con clic o arrastrando. Los marcadores se colocan de a uno sobre el
   borde izquierdo de la celda: ▲ en el instante en que el proceso llega al sistema y
   ▼ en el instante en que termina (como en el qplanif original). Opcionalmente cargá
   los T<sub>R</sub> / T<sub>E</sub> que calculaste. Apretá **Corregir**: las celdas y
   marcadores mal quedan en rojo con la explicación de qué tenía que pasar.

4. **Automático**: muestra la solución completa (fila de CPU, filas por proceso con
   ▲ llegada y ▼ fin, filas por recurso, tiempos y log de eventos instante por instante).

5. **Tema**: el botón de la barra superior alterna claro / oscuro. Por defecto sigue la
   preferencia del sistema y recuerda tu elección.

## Importar y exportar

- **Exportar** guarda un `.json` con todo: procesos, algoritmo y sus parámetros, y el
  diagrama manual (celdas, marcadores ▲▼ y tiempos cargados). Sirve para guardar un
  ejercicio a medio hacer o pasárselo a alguien.
- **Importar** acepta ese `.json`, o un `.txt` con código qplanif pelado (por ejemplo los
  archivos de la cátedra). En `ejemplos/` están los del apunte listos para importar.
- **🖼️ Imagen** descarga el diagrama que estás viendo (manual o automático) como PNG a
  doble resolución, con el tema activo, para pegarlo en un informe. Se dibuja en un
  `<canvas>` propio: no depende de ninguna librería ni de internet.

Los nombres de procesos y recursos no pueden estar vacíos ni contener comillas, porque el
formato los delimita con `''nombre''`. La tabla lo avisa mientras escribís.

## Reglas que aplica el simulador

Siguen la explicación de la cátedra; si tu comisión usa otra convención, está todo
en `js/scheduler.js`.

- Instante *t* = intervalo [t, t+1). Una ráfaga que termina al final de *t* deja al
  proceso listo (o pidiendo E/S) desde *t+1*.
- La E/S corre en paralelo con la CPU. Cada recurso atiende de a un proceso con cola
  FIFO; si está ocupado, el proceso **espera bloqueado** (rayado en el diagrama).
- Desempate: orden de llegada al sistema (`INICIO`), después PID (orden de declaración).
- **RR, timer variable**: el contador arranca en Q cada vez que un proceso toma la CPU.
  Si el expulsado por quantum coincide en el mismo instante con llegadas o retornos de
  E/S, se encola según la opción *"Expulsado por quantum…"*:
  - **Por desempate** (default): se ordena junto con ellos por llegada al sistema y luego
    PID — en la práctica, el más viejo primero.
  - **Al final**: detrás de los que entran en ese instante.
  - **Primero**: delante de los que entran en ese instante.
- **Prioridades**: menor valor = mayor prioridad.
- Los apropiativos (SRTF, Prioridades apropiativo) sólo expulsan si el
  candidato es *estrictamente* mejor; en empate sigue el que está.
- **Multinivel** (oculto en la interfaz): los procesos entran en Q0; al agotar el quantum bajan una cola; una
  cola superior expulsa a una inferior (el expulsado conserva su quantum restante).
- T<sub>R</sub> = fin − llegada · T<sub>E</sub> = T<sub>R</sub> − T<sub>CPU</sub> · TPR / TPE = promedios.

## Estructura

```
index.html        interfaz
css/styles.css
js/parser.js      formato de entrada ⇄ {resources, tasks} (parse / serialize)
js/scheduler.js   motor de planificación (sin DOM, testeable)
js/calc.js        evaluador aritmético de la minicalculadora (sin eval)
js/app.js         modo manual / automático, corrección, calculadora
tests/            tests del motor contra los ejemplos del apunte
```

## Tests

Requiere Node ≥ 18:

```
npm test
```
