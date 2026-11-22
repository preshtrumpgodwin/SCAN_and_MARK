/*
 * Live scanner. Shows the camera, finds the sheet of paper in every frame, draws its outline,
 * and captures automatically once the page is held steady (or when the shutter is pressed).
 *   Camera.open({title, hint, quality}) -> Promise<ImageData|null>   (null = cancelled)
 */
(function (root) {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var stream = null, timer = null, resolveFn = null, running = false;

  function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    $('cam').classList.add('hidden');
    $('camVideo').srcObject = null;
  }

  function open(opts) {
    return new Promise(function (resolve) {
      resolveFn = resolve;
      var video = $('camVideo'), overlay = $('camOverlay'), octx = overlay.getContext('2d');
      $('camTitle').textContent = opts.title || 'Scan';
      $('camHint').textContent = opts.hint || 'Hold the phone over the page';
      $('camProgress').style.width = '0%';
      $('cam').classList.remove('hidden');
      $('camTorch').classList.add('hidden');

      var small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });
      var stable = 0, last = null, STABLE_NEEDED = 6, startedAt = Date.now(), torchOn = false, done = false;

      function finish(imgData) {
        if (done) return; done = true;
        stop();
        var r = resolveFn; resolveFn = null; r(imgData);
      }
      function grabFull() {
        var c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        var x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(video, 0, 0);
        return x.getImageData(0, 0, c.width, c.height);
      }

      $('camClose').onclick = function () { finish(null); };
      $('camShoot').onclick = function () { if (video.videoWidth) finish(grabFull()); };
      $('camTorch').onclick = function () {
        torchOn = !torchOn;
        var tr = stream && stream.getVideoTracks()[0];
        if (tr) tr.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () {});
      };

      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 2560 } }
      }).then(function (s) {
        stream = s; video.srcObject = s; running = true;
        var tr = s.getVideoTracks()[0], caps = tr.getCapabilities ? tr.getCapabilities() : {};
        if (caps.torch) $('camTorch').classList.remove('hidden');
        if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
        video.play().catch(function () {});
        loop();
      }).catch(function (e) {
        finish(null);
        root.App && root.App.toast('Camera not available: ' + (e && e.message ? e.message : e) + '. Allow camera access in Android settings.');
      });

      function loop() {
        if (!running || done) return;
        var t0 = Date.now();
        try { analyse(); } catch (e) { /* keep going */ }
        timer = setTimeout(loop, Math.max(60, 220 - (Date.now() - t0)));
      }

      function analyse() {
        if (!video.videoWidth || !root.cv || !root.cv.Mat) return;
        var vw = video.videoWidth, vh = video.videoHeight, sc = 560 / Math.max(vw, vh);
        small.width = Math.round(vw * sc); small.height = Math.round(vh * sc);
        sctx.drawImage(video, 0, 0, small.width, small.height);
        var id = sctx.getImageData(0, 0, small.width, small.height);
        var mat = root.cv.matFromImageData(id);
        var q = null, sharp = 0;
        try {
          q = root.OmrEngine.findPageQuad(mat);
          var g = new root.cv.Mat(), lap = new root.cv.Mat(), mean = new root.cv.Mat(), sd = new root.cv.Mat();
          root.cv.cvtColor(mat, g, root.cv.COLOR_RGBA2GRAY);
          root.cv.Laplacian(g, lap, root.cv.CV_64F);
          root.cv.meanStdDev(lap, mean, sd);
          sharp = sd.data64F[0] * sd.data64F[0];
          g.delete(); lap.delete(); mean.delete(); sd.delete();
        } finally { mat.delete(); }

        // draw outline (video is object-fit: cover, so map through the cover transform)
        var cw = overlay.clientWidth, ch = overlay.clientHeight;
        if (overlay.width !== cw) { overlay.width = cw; overlay.height = ch; }
        octx.clearRect(0, 0, cw, ch);
        var cover = Math.max(cw / small.width, ch / small.height);
        var ox = (cw - small.width * cover) / 2, oy = (ch - small.height * cover) / 2;
        if (q) {
          // quad coords are already in `small` canvas pixels
          var pts = q.quad.map(function (p) { return [p[0] * cover + ox, p[1] * cover + oy]; });
          octx.lineWidth = 4; octx.strokeStyle = stable >= 3 ? '#4be3a0' : '#ffd24a';
          octx.fillStyle = stable >= 3 ? 'rgba(75,227,160,.12)' : 'rgba(255,210,74,.10)';
          octx.beginPath(); octx.moveTo(pts[0][0], pts[0][1]);
          for (var i = 1; i < 4; i++) octx.lineTo(pts[i][0], pts[i][1]);
          octx.closePath(); octx.fill(); octx.stroke();
        }
        // steadiness
        if (q && q.area > 0.3) {
          var cx = 0, cy = 0; q.quad.forEach(function (p) { cx += p[0] / 4; cy += p[1] / 4; });
          var diag = Math.hypot(small.width, small.height);
          if (last && Math.hypot(cx - last.cx, cy - last.cy) < diag * 0.012 && Math.abs(q.area - last.area) < 0.03) stable++; else stable = Math.max(0, stable - 2);
          last = { cx: cx, cy: cy, area: q.area };
        } else { stable = 0; last = null; }
        var needSharp = sharp > 25 || (Date.now() - startedAt > 9000);
        $('camProgress').style.width = Math.min(100, Math.round(stable / STABLE_NEEDED * 100)) + '%';
        $('camHint').textContent = !q ? 'Looking for the page… keep all 4 corners in view' :
          (stable >= STABLE_NEEDED && !needSharp ? 'Focusing…' : stable >= 2 ? 'Hold steady…' : 'Page found — hold still');
        if (stable >= STABLE_NEEDED && needSharp) finish(grabFull());
      }
    });
  }
  root.Camera = { open: open, stop: stop };
})(window);
