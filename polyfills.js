/* polyfills.js - ТО, ЧЕГО PDF.JS ЖДЁТ ОТ ДВИЖКА, А СТАРЫЙ ВЕБВЬЮ НЕ ДАЁТ.

   КЕЙС 24.11 (Telegram, WebKit Safari < 17.4): студия писала «Promise.withResolvers is not
   a function». Лестница сборок pdf.js (modern -> legacy -> compat) этого не лечила: замер
   24.11 показал, что legacy и compat несут core-js 3.50, но НЕ ЭТИ методы -
     Promise.withResolvers (Safari 17.4), Promise.try (18.2), AbortSignal.any (17.4),
     structuredClone, Array/String/TypedArray.at, Object.hasOwn, findLast(Index) (15.4).
   То есть все три сборки падали одинаково, и одинаково же на Safari 18.0-18.1 (Promise.try).

   ОДИН ФАЙЛ НА СТРАНИЦУ И НА ВОРКЕР. Страница берёт его обычным <script> ДО модулей; воркер
   pdf.js - модуль, и у него свой глобальный объект: его `pdf.worker.shim.mjs` импортирует
   этот файл первой строкой, а сам воркер - второй (импорты модуля исполняются по порядку).
   Поэтому здесь: обычный ES5-синтаксис, строгий режим не мешает, экспорта нет, глобальный
   объект берётся из globalThis | self | window.

   НИЧЕГО НЕ ПЕРЕОПРЕДЕЛЯЕТСЯ: ставится только то, чего нет. Сторож - tests/test_pdf_old_engine.py
   (стёртые методы в странице и в воркере) и `tools/check_pdfstudio.py --old`. */
(function () {
  var G = typeof globalThis !== 'undefined' ? globalThis
    : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}));
  function def(o, k, f) {
    if (o && typeof o[k] === 'undefined') {
      Object.defineProperty(o, k, { value: f, writable: true, configurable: true, enumerable: false });
    }
  }
  var P = G.Promise;
  if (P) {
    def(P, 'withResolvers', function withResolvers() {
      var d = {};
      d.promise = new (this || P)(function (res, rej) { d.resolve = res; d.reject = rej; });
      return d;
    });
    def(P, 'try', function (f) {
      var a = [], i;
      for (i = 1; i < arguments.length; i++) a.push(arguments[i]);
      return new (this || P)(function (res) { res(f.apply(undefined, a)); });
    });
  }
  function at(n) {
    n = Math.trunc(n) || 0;
    if (n < 0) n += this.length;
    return (n < 0 || n >= this.length) ? undefined : this[n];
  }
  def(Array.prototype, 'at', at);
  def(String.prototype, 'at', function (n) {
    n = Math.trunc(n) || 0;
    if (n < 0) n += this.length;
    return (n < 0 || n >= this.length) ? undefined : this.charAt(n);
  });
  var TA = G.Int8Array && Object.getPrototypeOf(G.Int8Array);
  if (TA && TA.prototype) def(TA.prototype, 'at', at);
  def(Object, 'hasOwn', function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); });
  function fl(cb, self) {
    for (var i = this.length - 1; i >= 0; i--) if (cb.call(self, this[i], i, this)) return this[i];
    return undefined;
  }
  function fli(cb, self) {
    for (var i = this.length - 1; i >= 0; i--) if (cb.call(self, this[i], i, this)) return i;
    return -1;
  }
  def(Array.prototype, 'findLast', fl);
  def(Array.prototype, 'findLastIndex', fli);
  if (TA && TA.prototype) { def(TA.prototype, 'findLast', fl); def(TA.prototype, 'findLastIndex', fli); }
  if (G.AbortController && G.AbortSignal) {
    def(G.AbortSignal, 'any', function (list) {
      var c = new G.AbortController(), arr = Array.prototype.slice.call(list || []);
      function stop(s) { if (!c.signal.aborted) { try { c.abort(s.reason); } catch (e) { c.abort(); } } }
      for (var i = 0; i < arr.length; i++) {
        (function (s) {
          if (s.aborted) stop(s);
          else s.addEventListener('abort', function () { stop(s); }, { once: true });
        })(arr[i]);
      }
      return c.signal;
    });
    if (!('timeout' in G.AbortSignal) && G.setTimeout) {
      def(G.AbortSignal, 'timeout', function (ms) {
        var c = new G.AbortController();
        setTimeout(function () { c.abort(); }, ms);
        return c.signal;
      });
    }
  }
  /* crypto.randomUUID (15.4): pdf.js метит им пометки. Случайность - из того же crypto. */
  if (G.Crypto && G.Crypto.prototype && G.Crypto.prototype.getRandomValues) {
    def(G.Crypto.prototype, 'randomUUID', function () {
      var b = this.getRandomValues(new Uint8Array(16)), h = '', i;
      b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      for (i = 0; i < 16; i++) {
        h += (b[i] < 16 ? '0' : '') + b[i].toString(16);
        if (i === 3 || i === 5 || i === 7 || i === 9) h += '-';
      }
      return h;
    });
  }
  /* structuredClone: pdf.js клонирует им состояние пометок и сообщения «без воркера» -
     обычные объекты, массивы, Map/Set, даты и буферы. Передача (transfer) - копией буфера. */
  if (typeof G.structuredClone !== 'function') {
    G.structuredClone = function (v) {
      var seen = typeof Map === 'function' ? new Map() : null;
      function cl(x) {
        if (x === null || typeof x !== 'object') return x;
        if (seen && seen.has(x)) return seen.get(x);
        var out, k;
        if (x instanceof Date) return new Date(x.getTime());
        if (x instanceof RegExp) return new RegExp(x.source, x.flags);
        if (G.ArrayBuffer && x instanceof ArrayBuffer) return x.slice(0);
        if (G.ArrayBuffer && ArrayBuffer.isView && ArrayBuffer.isView(x)) {
          return x.slice ? x.slice() : new x.constructor(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength));
        }
        if (Array.isArray(x)) { out = []; if (seen) seen.set(x, out); for (k = 0; k < x.length; k++) out[k] = cl(x[k]); return out; }
        if (G.Map && x instanceof Map) { out = new Map(); if (seen) seen.set(x, out); x.forEach(function (b, a) { out.set(cl(a), cl(b)); }); return out; }
        if (G.Set && x instanceof Set) { out = new Set(); if (seen) seen.set(x, out); x.forEach(function (b) { out.add(cl(b)); }); return out; }
        out = {};
        if (seen) seen.set(x, out);
        for (k in x) if (Object.prototype.hasOwnProperty.call(x, k)) out[k] = cl(x[k]);
        return out;
      }
      return cl(v);
    };
  }
})();
