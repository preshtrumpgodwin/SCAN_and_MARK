/* Tiny IndexedDB wrapper. Everything (exams, answer-key images, learner results) stays on the phone. */
(function (root) {
  'use strict';
  var DB = null;
  function open() {
    if (DB) return Promise.resolve(DB);
    return new Promise(function (res, rej) {
      var rq = indexedDB.open('scanscore', 1);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        db.createObjectStore('exams', { keyPath: 'id' });
        var r = db.createObjectStore('results', { keyPath: 'id' });
        r.createIndex('examId', 'examId');
      };
      rq.onsuccess = function () { DB = rq.result; res(DB); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode), st = t.objectStore(store), out = fn(st);
        t.oncomplete = function () { res(out && 'result' in out ? out.result : out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }
  root.Store = {
    put: function (store, obj) { return tx(store, 'readwrite', function (s) { s.put(obj); }); },
    get: function (store, id) { return tx(store, 'readonly', function (s) { return s.get(id); }); },
    all: function (store) { return tx(store, 'readonly', function (s) { return s.getAll(); }); },
    del: function (store, id) { return tx(store, 'readwrite', function (s) { s.delete(id); }); },
    byExam: function (examId) { return tx('results', 'readonly', function (s) { return s.index('examId').getAll(examId); }); },
    delByExam: function (examId) {
      return root.Store.byExam(examId).then(function (list) {
        return tx('results', 'readwrite', function (s) { list.forEach(function (r) { s.delete(r.id); }); });
      });
    },
    uid: function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  };
})(window);
