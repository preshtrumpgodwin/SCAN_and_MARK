/* Scan & Score - screens and workflow. Objective answers only (shaded on the question paper). */
(function (root) {
  'use strict';
  var E = root.OmrEngine, S = root.Store, cv = null;
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');
  var keyMatCache = {};   // examId -> [Mat]  (decoded key pages, kept while the app is open)
  var featCache = {};     // examId -> [{feat}]

  // ---------- helpers ----------
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hidden'); }, 4200); }
  function busy(msg) { $('busyMsg').textContent = msg || 'Working…'; $('busy').classList.remove('hidden'); return new Promise(function (r) { setTimeout(r, 30); }); }
  function idle() { $('busy').classList.add('hidden'); }
  function tick() { return new Promise(function (r) { setTimeout(r, 20); }); }
  function pct(a, b) { return b ? Math.round(a * 1000 / b) / 10 : 0; }
  function fmtDate(t) { var d = new Date(t); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  function matToCanvas(mat, scale) {
    var c = document.createElement('canvas'), tmp = document.createElement('canvas');
    tmp.width = mat.cols; tmp.height = mat.rows;
    cv.imshow(tmp, mat);
    scale = scale || 1;
    c.width = Math.round(mat.cols * scale); c.height = Math.round(mat.rows * scale);
    c.getContext('2d').drawImage(tmp, 0, 0, c.width, c.height);
    return c;
  }
  function canvasToBlob(c, q) { return new Promise(function (r) { c.toBlob(r, 'image/jpeg', q || 0.8); }); }
  function blobToImage(b) { return new Promise(function (res, rej) { var u = URL.createObjectURL(b), i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = u; }); }
  function blobToMat(b) {
    return blobToImage(b).then(function (img) {
      var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      var x = c.getContext('2d'); x.drawImage(img, 0, 0);
      return cv.matFromImageData(x.getImageData(0, 0, c.width, c.height));
    });
  }
  function imageDataToMat(id) { return cv.matFromImageData(id); }

  // ---------- engine loading ----------
  function loadEngine() {
    return new Promise(function (resolve) {
      var c = root.cv;
      function ready() { cv = root.cv; E.init(cv); resolve(); }
      if (c && c.Mat) return ready();
      if (!c) return setTimeout(function () { loadEngine().then(resolve); }, 200);
      c.onRuntimeInitialized = ready;
    });
  }

  // ---------- views ----------
  function bar(title, back) {
    return '<div class="bar">' + (back ? '<button data-act="' + back + '">‹ Back</button>' : '') + '<h1>' + esc(title) + '</h1></div>';
  }

  function viewHome() {
    S.all('exams').then(function (exams) {
      exams.sort(function (a, b) { return b.created - a.created; });
      var h = bar('Scan & Score') + '<div class="wrap">';
      if (!exams.length) {
        h += '<div class="card"><h3>Welcome</h3><div class="muted">Mark objective questions straight from the printed question paper.</div>' +
          '<ol class="steps"><li>Create an exam below.</li><li>Shade the correct answers on one question paper and scan it (the answer key).</li>' +
          '<li>Type a learner’s name, then scan their shaded paper. The score appears at once.</li></ol></div>';
      }
      exams.forEach(function (ex) {
        h += '<div class="card" data-act="exam" data-id="' + ex.id + '"><div class="row sp"><h3>' + esc(ex.name) + '</h3>' +
          (ex.key ? '<span class="badge ok">Key ready</span>' : '<span class="badge warn">No key yet</span>') + '</div>' +
          '<div class="muted">' + ex.pages + ' page' + (ex.pages > 1 ? 's' : '') + (ex.key ? ' · ' + ex.key.total + ' objective questions' : '') + '</div></div>';
      });
      h += '<button class="btn" data-act="newExam">＋ New exam</button></div>';
      app.innerHTML = h;
    });
  }

  function viewNewExam() {
    app.innerHTML = bar('New exam', 'home') + '<div class="wrap"><div class="card">' +
      '<label>Exam name</label><input id="fName" placeholder="e.g. JSS3 Computer Studies – 1st Term">' +
      '<label>How many pages is the question paper?</label><select id="fPages"><option>1</option><option selected>2</option><option>3</option><option>4</option></select>' +
      '<label>Marks per correct answer</label><input id="fMarks" type="number" value="1" min="0.5" step="0.5">' +
      '<div class="muted" style="margin-top:10px">Only the shaded objective answers are marked. Theory questions are ignored.</div>' +
      '<button class="btn" data-act="createExam">Create exam</button></div></div>';
  }

  function viewExam(id) {
    Promise.all([S.get('exams', id), S.byExam(id)]).then(function (a) {
      var ex = a[0], results = a[1];
      if (!ex) return viewHome();
      results.sort(function (x, y) { return y.created - x.created; });
      var h = bar(ex.name, 'home') + '<div class="wrap"><div class="card">' +
        '<div class="row sp"><div><b>Answer key</b><div class="muted">' + (ex.key ? ex.key.total + ' answers found on ' + ex.pages + ' page(s)' : 'Scan a paper with the correct answers shaded') + '</div></div>' +
        (ex.key ? '<span class="badge ok">✓</span>' : '') + '</div>' +
        '<button class="btn ' + (ex.key ? 'alt' : '') + '" data-act="scanKey" data-id="' + id + '">' + (ex.key ? 'Re-scan answer key' : 'Scan answer key') + '</button></div>';
      h += '<button class="btn" data-act="newLearner" data-id="' + id + '"' + (ex.key ? '' : ' disabled') + '>Score a learner</button>';
      h += '<div class="row sp" style="margin:18px 2px 8px"><b>Results (' + results.length + ')</b>' +
        (results.length ? '<button class="btn alt sm" data-act="exportCsv" data-id="' + id + '">Export CSV</button>' : '') + '</div>';
      results.forEach(function (r) {
        var flags = r.questions.filter(function (q) { return q.status === 'multiple' && q.override == null; }).length;
        h += '<div class="card" data-act="result" data-id="' + r.id + '"><div class="row sp"><h3>' + esc(r.name) + '</h3><div><b>' + r.score + ' / ' + r.total + '</b></div></div>' +
          '<div class="muted">' + pct(r.score, r.total) + '% · ' + fmtDate(r.created) + (flags ? ' · <span style="color:#a56000">' + flags + ' to review</span>' : '') + '</div></div>';
      });
      h += '<button class="btn warn" data-act="delExam" data-id="' + id + '" style="margin-top:24px">Delete this exam</button></div>';
      app.innerHTML = h;
    });
  }

  function viewNewLearner(id) {
    app.innerHTML = bar('New learner', 'exam:' + id) + '<div class="wrap"><div class="card"><label>Learner’s full name</label>' +
      '<input id="fLearner" autocapitalize="words" placeholder="Type the name first, then scan">' +
      '<button class="btn" data-act="startLearner" data-id="' + id + '">Start scanning</button></div></div>';
    setTimeout(function () { var f = $('fLearner'); f && f.focus(); }, 200);
  }

  // ---------- answer key flow ----------
  function scanKey(id) {
    S.get('exams', id).then(function (ex) {
      var pages = [], i = 0;
      function nextPage() {
        if (i >= ex.pages) return saveKey(ex, pages);
        scanOneKeyPage(ex, i, pages).then(function (ok) {
          if (ok === 'cancel') { freeKeyPages(pages); return viewExam(id); }
          pages[i] = ok; i++; nextPage();
        });
      }
      nextPage();
    });
  }
  function freeKeyPages(p) { p.forEach(function (x) { x && x.canon && x.canon.delete(); }); }

  function scanOneKeyPage(ex, i, pages) {
    return root.Camera.open({ title: 'Answer key – page ' + (i + 1) + ' of ' + ex.pages, hint: 'Hold the shaded key paper flat, all 4 corners visible' }).then(function (imgData) {
      if (!imgData) return 'cancel';
      return busy('Reading page ' + (i + 1) + '…').then(function () {
        var photo = imageDataToMat(imgData), canon = E.rectifyPage(photo);
        photo.delete();
        if (!canon) { idle(); toast('Could not find the page edges. Put the paper on a dark surface and try again.'); return scanOneKeyPage(ex, i, pages); }
        var marks = E.detectAnswerMarks(canon, { skipTop: i === 0 ? 190 : 0 });
        idle();
        return reviewKey(ex, i, canon, marks, pages);
      });
    });
  }

  // Review screen: teacher sees detected answers on the page, taps to remove false ones / add missed ones.
  function reviewKey(ex, i, canon, marks, pages) {
    return new Promise(function (resolve) {
      var canvas, ctx, scale = 1;
      function draw() {
        var base = matToCanvas(canon, 0.55); scale = 0.55;
        canvas.width = base.width; canvas.height = base.height;
        ctx.drawImage(base, 0, 0);
        marks.forEach(function (m, k) {
          ctx.lineWidth = 3; ctx.strokeStyle = '#1a9a54'; ctx.fillStyle = 'rgba(26,154,84,.22)';
          ctx.fillRect(m.x * scale - 3, m.y * scale - 3, m.w * scale + 6, m.h * scale + 6);
          ctx.strokeRect(m.x * scale - 3, m.y * scale - 3, m.w * scale + 6, m.h * scale + 6);
        });
        $('keyCount').textContent = marks.length;
      }
      app.innerHTML = bar('Check answers – page ' + (i + 1) + ' of ' + ex.pages) + '<div class="wrap"><div class="card">' +
        '<div class="row sp"><div><b><span id="keyCount">0</span> answers found</b><div class="muted">Green = detected answer. Tap a green box to remove it; tap a shaded answer that was missed to add it.</div></div></div>' +
        '<canvas id="keyCv" class="keycv"></canvas>' +
        '<button class="btn" id="keyOk">Looks right ✓</button><button class="btn alt" id="keyRetake">Retake this page</button></div></div>';
      canvas = $('keyCv'); ctx = canvas.getContext('2d'); draw();
      canvas.onclick = function (ev) {
        var r = canvas.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * canvas.width / scale, y = (ev.clientY - r.top) / r.height * canvas.height / scale;
        var hit = -1; marks.forEach(function (m, k) { if (x >= m.x - 8 && x <= m.x + m.w + 8 && y >= m.y - 8 && y <= m.y + m.h + 8) hit = k; });
        if (hit >= 0) marks.splice(hit, 1); else marks.push({ x: x - 20, y: y - 13, w: 40, h: 26, cx: x, cy: y, score: 1 });
        draw();
      };
      $('keyRetake').onclick = function () { canon.delete(); resolve(scanOneKeyPage(ex, i, pages)); };
      $('keyOk').onclick = function () { resolve({ canon: canon, marks: marks }); };
    });
  }

  function saveKey(ex, pages) {
    busy('Saving answer key…').then(function () {
      var out = [], total = 0, chain = Promise.resolve();
      pages.forEach(function (p, i) {
        chain = chain.then(function () { return tick(); }).then(function () {
          var zones = E.buildZones(p.canon, p.marks);
          return canvasToBlob(matToCanvas(p.canon, 1), 0.85).then(function (blob) {
            out.push({ img: blob, marks: p.marks, zones: zones });
            total += zones.length;
          });
        });
      });
      return chain.then(function () {
        ex.key = { pages: out, total: total, saved: Date.now() };
        return S.delByExam(ex.id).then(function () { return S.put('exams', ex); });
      }).then(function () {
        freeKeyPages(pages); delete keyMatCache[ex.id]; delete featCache[ex.id];
        idle(); toast('Answer key saved: ' + total + ' objective questions.'); viewExam(ex.id);
      });
    }).catch(function (e) { idle(); toast('Could not save: ' + e); });
  }

  // ---------- learner flow ----------
  function getKeyMats(ex) {
    if (keyMatCache[ex.id]) return Promise.resolve(keyMatCache[ex.id]);
    var mats = [];
    return ex.key.pages.reduce(function (p, pg) {
      return p.then(function () { return blobToMat(pg.img).then(function (m) { mats.push(m); }); });
    }, Promise.resolve()).then(function () { keyMatCache[ex.id] = mats; featCache[ex.id] = mats.map(function () { return {}; }); return mats; });
  }

  function startLearner(id, name) {
    S.get('exams', id).then(function (ex) {
      getKeyMats(ex).then(function (mats) {
        var pageResults = [], i = 0;
        function next() {
          if (i >= ex.pages) return finishLearner(ex, name, pageResults);
          root.Camera.open({ title: name + ' – page ' + (i + 1) + ' of ' + ex.pages, hint: 'Hold the learner’s paper flat, all 4 corners visible' }).then(function (imgData) {
            if (!imgData) return viewExam(id);
            busy('Marking page ' + (i + 1) + '…').then(function () {
              var photo = imageDataToMat(imgData), al = E.alignToTemplate(photo, mats[i], featCache[ex.id][i]);
              photo.delete();
              if (al.error) { idle(); toast(al.error); return next(); }
              var keyPage = ex.key.pages[i];
              var res = E.scoreLearnerPage(mats[i], al.mat, keyPage);
              return canvasToBlob(matToCanvas(al.mat, 0.6), 0.75).then(function (blob) {
                al.mat.delete(); idle();
                pageResults[i] = { res: res, img: blob }; i++; next();
              });
            }).catch(function (e) { idle(); toast('Problem reading page: ' + e); next(); });
          });
        }
        next();
      });
    });
  }

  function finishLearner(ex, name, pageResults) {
    var questions = [], pages = [], n = 0;
    pageResults.forEach(function (pr, pi) {
      pages.push(pr.img);
      pr.res.forEach(function (r, zi) {
        n++;
        questions.push({ n: n, page: pi, zone: zi, status: r.status, override: null });
      });
    });
    var rec = { id: S.uid(), examId: ex.id, name: name, created: Date.now(), questions: questions, pages: pages, total: questions.length, score: 0, marksPer: ex.marksPer };
    rec.score = questions.filter(function (q) { return q.status === 'correct'; }).length;
    S.put('results', rec).then(function () { viewResult(rec.id, true); });
  }

  // ---------- result screen ----------
  function finalCorrect(q) { return q.override != null ? q.override === 'correct' : q.status === 'correct'; }
  function drawOverlay(canvas, img, rec, ex, pi) {
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    var ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    var sc = img.naturalWidth / E.CANON_W, kp = ex.key.pages[pi];
    rec.questions.forEach(function (q) {
      if (q.page !== pi) return;
      var m = kp.marks[kp.zones[q.zone].markIndex];
      var ok = finalCorrect(q), colour = q.override != null ? (ok ? '#1a9a54' : '#d23b3b') : { correct: '#1a9a54', wrong: '#d23b3b', multiple: '#e08a00', blank: '#8a9a9b' }[q.status];
      ctx.lineWidth = 3; ctx.strokeStyle = colour; ctx.fillStyle = colour;
      var x = m.x * sc, y = m.y * sc, w = m.w * sc, h = m.h * sc;
      ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText((ok ? '✓ ' : q.status === 'blank' ? '– ' : '✗ ') + q.n, x - 4, y - 7);
    });
  }
  function viewResult(rid, justScanned) {
    S.get('results', rid).then(function (rec) {
      S.get('exams', rec.examId).then(function (ex) {
        var score = rec.questions.filter(finalCorrect).length, review = rec.questions.filter(function (q) { return q.status === 'multiple' && q.override == null; }).length;
        var h = bar(rec.name, 'exam:' + rec.examId) + '<div class="wrap"><div class="card"><div class="muted">' + esc(ex.name) + '</div>' +
          '<div class="row sp" style="margin-top:6px"><div class="score">' + score + '<span class="muted" style="font-size:22px"> / ' + rec.total + '</span></div><div style="text-align:right"><b style="font-size:24px">' + pct(score, rec.total) + '%</b>' +
          (rec.marksPer && rec.marksPer !== 1 ? '<div class="muted">' + (score * rec.marksPer) + ' marks</div>' : '') + '</div></div>' +
          (review ? '<div class="badge warn" style="margin-top:10px">' + review + ' question(s) have two shaded answers — tap to decide</div>' : '') +
          '<div class="muted" style="margin-top:10px">Tap a question number to flip it between right and wrong.</div><div class="chips" id="chips"></div></div>';
        rec.pages.forEach(function (p, pi) { h += '<div class="card"><b>Page ' + (pi + 1) + '</b><canvas class="pagecv" id="pg' + pi + '"></canvas></div>'; });
        h += '<button class="btn" data-act="newLearner" data-id="' + rec.examId + '">Next learner</button>' +
          '<button class="btn warn" data-act="delResult" data-id="' + rec.id + '">Delete this result</button></div>';
        app.innerHTML = h;
        function chips() {
          $('chips').innerHTML = rec.questions.map(function (q, k) {
            var cls = q.override != null ? (q.override === 'correct' ? 'correct' : 'wrong') + ' ov' : q.status;
            return '<div class="chip ' + cls + '" data-act="flip" data-k="' + k + '">' + q.n + '</div>';
          }).join('');
        }
        chips();
        var imgs = [];
        function redraw() { rec.pages.forEach(function (p, pi) { if (imgs[pi]) drawOverlay($('pg' + pi), imgs[pi], rec, ex, pi); }); }
        Promise.all(rec.pages.map(blobToImage)).then(function (list) { imgs = list; redraw(); });
        viewResult._flip = function (k) {
          var q = rec.questions[k], cur = finalCorrect(q);
          q.override = cur ? 'wrong' : 'correct';
          if ((q.override === 'correct') === (q.status === 'correct')) q.override = null;
          rec.score = rec.questions.filter(finalCorrect).length;
          S.put('results', rec).then(function () { viewResult(rid); });
        };
      });
    });
  }

  // ---------- CSV export ----------
  function exportCsv(examId) {
    Promise.all([S.get('exams', examId), S.byExam(examId)]).then(function (a) {
      var ex = a[0], rs = a[1].sort(function (x, y) { return x.name.localeCompare(y.name); });
      var rows = [['Name', 'Score', 'Out of', 'Percent', 'Marks', 'Scanned']];
      rs.forEach(function (r) {
        var sc = r.questions.filter(finalCorrect).length;
        rows.push([r.name, sc, r.total, pct(sc, r.total), sc * (r.marksPer || 1), new Date(r.created).toLocaleString()]);
      });
      var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
      var fname = ex.name.replace(/[^a-z0-9]+/gi, '_') + '_results.csv';
      var FS = root.capacitorFilesystem && root.capacitorFilesystem.Filesystem, SH = root.capacitorShare && root.capacitorShare.Share;
      if (FS && SH && root.Capacitor && root.Capacitor.isNativePlatform && root.Capacitor.isNativePlatform()) {
        FS.writeFile({ path: fname, data: csv, directory: 'CACHE', encoding: 'utf8' }).then(function (r) {
          return SH.share({ title: 'Results', text: ex.name + ' results', url: r.uri, dialogTitle: 'Share results' });
        }).catch(function (e) { toast('Could not share: ' + (e && e.message || e)); });
      } else {
        var a2 = document.createElement('a'); a2.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a2.download = fname; a2.click();
      }
    });
  }

  // ---------- events ----------
  app.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]'); if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    if (act.indexOf('exam:') === 0) return viewExam(act.slice(5));
    switch (act) {
      case 'home': return viewHome();
      case 'newExam': return viewNewExam();
      case 'createExam': {
        var name = $('fName').value.trim(); if (!name) return toast('Give the exam a name.');
        var ex = { id: S.uid(), name: name, pages: +$('fPages').value, marksPer: +$('fMarks').value || 1, created: Date.now(), key: null };
        return S.put('exams', ex).then(function () { viewExam(ex.id); });
      }
      case 'exam': return viewExam(id);
      case 'scanKey': return scanKey(id);
      case 'newLearner': return viewNewLearner(id);
      case 'startLearner': {
        var nm = $('fLearner').value.trim().replace(/\s+/g, ' ');
        if (!nm) return toast('Type the learner’s name first.');
        return startLearner(id, nm);
      }
      case 'result': return viewResult(id);
      case 'flip': return viewResult._flip(+el.getAttribute('data-k'));
      case 'exportCsv': return exportCsv(id);
      case 'delExam': if (confirm('Delete this exam and all its results?')) S.delByExam(id).then(function () { return S.del('exams', id); }).then(viewHome); return;
      case 'delResult': S.get('results', id).then(function (r) { if (confirm('Delete this result?')) S.del('results', id).then(function () { viewExam(r.examId); }); }); return;
    }
  });

  root.App = { toast: toast };
  app.innerHTML = '<div class="busy"><div class="spinner"></div><div>Loading scanner engine…</div></div>';
  loadEngine().then(viewHome);
})(window);
