/*
 * OMR engine for question papers that are shaded directly on the paper.
 * Works in the browser (global OmrEngine) and in Node (module.exports) so it can be tested.
 *
 *  1. rectifyPage()      find the sheet of paper in a photo and flatten it (A4 canvas)
 *  2. alignToTemplate()  register a learner photo onto the teacher's key page (ORB + RANSAC)
 *  3. detectAnswerMarks() find shaded answers on the key page
 *  4. buildZones()       split the page into question zones (one per shaded answer)
 *  5. scoreLearnerPage() compare a learner page with the key page, question by question
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OmrEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CANON_W = 1240, CANON_H = 1754;            // A4 @ 150 dpi
  var cv = null;
  function init(cvInstance) { cv = cvInstance; }

  // ---------- small helpers ----------
  function Scope() { this.list = []; }
  Scope.prototype.add = function (m) { this.list.push(m); return m; };
  Scope.prototype.free = function () { for (var i = 0; i < this.list.length; i++) { try { this.list[i].delete(); } catch (e) {} } this.list = []; };

  function grayOf(S, src) {
    if (src.channels() === 1) return src;
    var g = S.add(new cv.Mat());
    cv.cvtColor(src, g, src.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_BGR2GRAY);
    return g;
  }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  function orderQuad(pts) {   // -> TL, TR, BR, BL
    var s = pts.map(function (p) { return p[0] + p[1]; });
    var d = pts.map(function (p) { return p[0] - p[1]; });
    var tl = pts[s.indexOf(Math.min.apply(null, s))], br = pts[s.indexOf(Math.max.apply(null, s))];
    var tr = pts[d.indexOf(Math.max.apply(null, d))], bl = pts[d.indexOf(Math.min.apply(null, d))];
    return [tl, tr, br, bl];
  }

  // ---------- 1. page detection ----------
  /** Finds the paper quadrilateral in a (BGR/RGBA/gray) Mat. Returns {quad:[[x,y]x4] in source pixels, area} or null. */
  function findPageQuad(src, opts) {
    opts = opts || {};
    var S = new Scope();
    try {
      var scale = 640 / Math.max(src.cols, src.rows);
      var small = S.add(new cv.Mat());
      cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
      var g = grayOf(S, small);
      var blur = S.add(new cv.Mat());
      cv.GaussianBlur(g, blur, new cv.Size(5, 5), 0);
      var best = null;
      var imgArea = small.cols * small.rows;
      // Two attempts: bright-paper threshold, then edge based.
      for (var attempt = 0; attempt < 2 && !best; attempt++) {
        var bin = S.add(new cv.Mat());
        if (attempt === 0) {
          cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
          var k = S.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11)));
          cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);      // text becomes part of the paper
        } else {
          cv.Canny(blur, bin, 40, 120);
          var k2 = S.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
          cv.dilate(bin, bin, k2);
          cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, S.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15))));
        }
        var contours = S.add(new cv.MatVector()), hier = S.add(new cv.Mat());
        cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        var cand = [];
        for (var i = 0; i < contours.size(); i++) {
          var c = contours.get(i);
          var area = cv.contourArea(c);
          if (area > imgArea * 0.18) cand.push({ c: c, area: area });
          else c.delete();
        }
        cand.sort(function (a, b) { return b.area - a.area; });
        for (var j = 0; j < cand.length && !best; j++) {
          var c2 = cand[j].c;
          var hull = new cv.Mat(); cv.convexHull(c2, hull);
          var peri = cv.arcLength(hull, true);
          var approx = new cv.Mat(); cv.approxPolyDP(hull, approx, 0.02 * peri, true);
          var pts = [];
          if (approx.rows === 4) { for (var r = 0; r < 4; r++) pts.push([approx.data32S[r * 2], approx.data32S[r * 2 + 1]]); }
          else {  // fall back to the extreme points of the hull
            var hp = []; for (var r2 = 0; r2 < hull.rows; r2++) hp.push([hull.data32S[r2 * 2], hull.data32S[r2 * 2 + 1]]);
            pts = orderQuad(hp);
          }
          hull.delete(); approx.delete();
          var q = orderQuad(pts);
          var w1 = dist(q[0], q[1]), w2 = dist(q[3], q[2]), h1 = dist(q[0], q[3]), h2 = dist(q[1], q[2]);
          var aw = (w1 + w2) / 2, ah = (h1 + h2) / 2;
          if (Math.min(w1, w2) / Math.max(w1, w2) < 0.6 || Math.min(h1, h2) / Math.max(h1, h2) < 0.6) continue;
          var ratio = Math.min(aw, ah) / Math.max(aw, ah);       // A4 = 0.707
          if (ratio < 0.55 || ratio > 0.88) continue;
          var qa = polyArea(q);
          if (qa < imgArea * 0.18) continue;
          best = { quad: q.map(function (p) { return [p[0] / scale, p[1] / scale]; }), area: qa / imgArea, landscape: aw > ah };
        }
        for (var z = 0; z < cand.length; z++) { try { cand[z].c.delete(); } catch (e) {} }
      }
      return best;
    } finally { S.free(); }
  }
  function polyArea(q) { var a = 0; for (var i = 0; i < q.length; i++) { var p = q[i], n = q[(i + 1) % q.length]; a += p[0] * n[1] - n[0] * p[1]; } return Math.abs(a) / 2; }

  /** Flatten the page to CANON_W x CANON_H (portrait). Returns a new Mat (caller deletes) or null. */
  function rectifyPage(src, quadInfo) {
    var qi = quadInfo || findPageQuad(src);
    if (!qi) return null;
    var q = qi.quad;
    if (qi.landscape) q = [q[3], q[0], q[1], q[2]];          // rotate so the long side is vertical
    var S = new Scope();
    try {
      var s = S.add(cv.matFromArray(4, 1, cv.CV_32FC2, [q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1]]));
      var d = S.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CANON_W, 0, CANON_W, CANON_H, 0, CANON_H]));
      var M = S.add(cv.getPerspectiveTransform(s, d));
      var out = new cv.Mat();
      cv.warpPerspective(src, out, M, new cv.Size(CANON_W, CANON_H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
      return out;
    } finally { S.free(); }
  }

  // ---------- 2. alignment ----------

  /**
   * Second alignment stage. ORB gives a good but not perfect homography (a few pixels of drift
   * across the page is enough to shift a text line). Here small patches of the key page are
   * matched against the already-warped learner page by normalised cross-correlation, and a
   * correcting homography is fitted through those much more precise correspondences.
   */
  function refineWithGrid(aligned, template) {
    var cur = aligned, improved = 0;
    for (var iter = 0; iter < 2; iter++) {
      var S = new Scope();
      try {
        var tg = grayOf(S, template), ag = grayOf(S, cur);
        var W = tg.cols, H = tg.rows;
        var pw = 150, ph = 84, sr = 26;
        var sp = [], dp = [];
        for (var cy = 110; cy < H - 112; cy += 120) {
          for (var cx = 112; cx < W - 112; cx += 150) {
            var tx = cx - pw / 2, ty = cy - ph / 2;
            var tpl = S.add(tg.roi(new cv.Rect(tx, ty, pw, ph)).clone());
            var mean = S.add(new cv.Mat()), sd = S.add(new cv.Mat());
            cv.meanStdDev(tpl, mean, sd);
            if (sd.data64F[0] < 28) continue;                       // blank paper: nothing to lock onto
            var wnd = S.add(ag.roi(new cv.Rect(tx - sr, ty - sr, pw + 2 * sr, ph + 2 * sr)).clone());
            var res = S.add(new cv.Mat());
            cv.matchTemplate(wnd, tpl, res, cv.TM_CCOEFF_NORMED);
            var mm = cv.minMaxLoc(res);
            if (mm.maxVal < 0.55) continue;
            // sub-pixel: parabola through the peak neighbours
            var px = mm.maxLoc.x, py = mm.maxLoc.y, fx = 0, fy = 0;
            if (px > 0 && px < res.cols - 1) { var l = res.floatAt(py, px - 1), c = res.floatAt(py, px), r = res.floatAt(py, px + 1); var dn = l - 2 * c + r; if (dn) fx = 0.5 * (l - r) / dn; }
            if (py > 0 && py < res.rows - 1) { var u = res.floatAt(py - 1, px), c2 = res.floatAt(py, px), d = res.floatAt(py + 1, px); var dn2 = u - 2 * c2 + d; if (dn2) fy = 0.5 * (u - d) / dn2; }
            sp.push(cx + (px + fx - sr), cy + (py + fy - sr)); dp.push(cx, cy);
          }
        }
        var n = sp.length / 2;
        if (n < 14) { if (cur !== aligned) {} break; }
        var sM = S.add(cv.matFromArray(n, 1, cv.CV_32FC2, sp)), dM = S.add(cv.matFromArray(n, 1, cv.CV_32FC2, dp));
        var mask = S.add(new cv.Mat());
        var H2 = cv.findHomography(sM, dM, cv.RANSAC, 2.0, mask);
        if (!H2 || H2.empty()) { if (H2) H2.delete(); break; }
        var inl = 0; for (var k = 0; k < mask.rows; k++) if (mask.data[k]) inl++;
        var h = H2.data64F;
        var ok = inl >= 12 && Math.abs(h[0] - 1) < 0.08 && Math.abs(h[4] - 1) < 0.08 && Math.abs(h[2]) < 40 && Math.abs(h[5]) < 40;
        if (ok) {
          var out = new cv.Mat();
          cv.warpPerspective(cur, out, H2, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
          if (cur !== aligned) cur.delete();
          cur = out; improved++;
        }
        H2.delete();
        if (!ok) break;
      } finally { S.free(); }
    }
    return cur;
  }

  function orbFeatures(S, gray) {
    var orb = new cv.ORB(3500, 1.2, 8, 31, 0, 2);   // (the longer overload fails to bind in opencv.js)
    var kp = S.add(new cv.KeyPointVector()), des = S.add(new cv.Mat());
    var mask = S.add(new cv.Mat());
    orb.detectAndCompute(gray, mask, kp, des);
    orb.delete();
    return { kp: kp, des: des };
  }

  /**
   * Register `img` (any BGR/RGBA photo of the same paper) onto the template page image
   * (canonical BGR). Returns {mat: aligned canonical BGR, inliers, method} or {error}.
   */
  function alignToTemplate(img, template, tplCache) {
    var S = new Scope();
    try {
      var tg = grayOf(S, template);
      var tf = tplCache && tplCache.feat ? tplCache.feat : null;
      var ownTpl = false;
      if (!tf) { tf = orbFeatures(new Scope(), tg); ownTpl = true; if (tplCache) tplCache.feat = tf; }
      var tryList = [];
      tryList.push({ name: 'direct', get: function () { return img; }, own: false });
      var res = null;
      for (var t = 0; t < 2 && !res; t++) {
        var cand, own = false, name;
        if (t === 0) { cand = img; name = 'direct'; }
        else {
          var rect = rectifyPage(img);
          if (!rect) break;
          cand = rect; own = true; name = 'page+refine';
        }
        var r = matchOnto(S, cand, tf, tg, template.cols, template.rows);
        if (r && r.inliers >= 40 && r.ratio >= 0.22) {
          var fine = refineWithGrid(r.mat, template);
          if (fine !== r.mat) r.mat.delete();
          res = { mat: fine, inliers: r.inliers, method: name };
        }
        else if (r) r.mat.delete();
        if (own) cand.delete();
      }
      if (!res) return { error: 'Could not match this photo to the answer key page. Check it is the right page, flat, and fully in view.' };
      return res;
    } finally { S.free(); }
  }

  function matchOnto(S, cand, tf, tplGray, tw, th) {
    var sc = Math.min(1, 2000 / Math.max(cand.cols, cand.rows));
    var small = S.add(new cv.Mat());
    if (sc < 1) cv.resize(cand, small, new cv.Size(Math.round(cand.cols * sc), Math.round(cand.rows * sc)), 0, 0, cv.INTER_AREA); else cand.copyTo(small);
    var g = grayOf(S, small);
    var f = orbFeatures(S, g);
    if (f.kp.size() < 60 || tf.kp.size() < 60) return null;
    var bf = S.add(new cv.BFMatcher(cv.NORM_HAMMING, false));
    var knn = S.add(new cv.DMatchVectorVector());
    bf.knnMatch(f.des, tf.des, knn, 2);
    var src = [], dst = [];
    for (var i = 0; i < knn.size(); i++) {
      var m = knn.get(i);
      if (m.size() < 2) continue;
      var a = m.get(0), b = m.get(1);
      if (a.distance < 0.78 * b.distance && a.distance < 64) {
        var p = f.kp.get(a.queryIdx).pt, q = tf.kp.get(a.trainIdx).pt;
        src.push(p.x / sc, p.y / sc); dst.push(q.x, q.y);
      }
    }
    var n = src.length / 2;
    if (n < 25) return null;
    var sm = S.add(cv.matFromArray(n, 1, cv.CV_32FC2, src)), dm = S.add(cv.matFromArray(n, 1, cv.CV_32FC2, dst));
    var mask = S.add(new cv.Mat());
    var H = cv.findHomography(sm, dm, cv.RANSAC, 4.0, mask);
    if (!H || H.empty()) { if (H) H.delete(); return null; }
    var inl = 0; for (var k = 0; k < mask.rows; k++) if (mask.data[k]) inl++;
    // Refine: least-squares refit on tight inliers, twice. RANSAC alone leaves several pixels
    // of residual error, which is enough to shift a whole text line off the key page.
    for (var pass = 0; pass < 3; pass++) {
      var sIn = [], dIn = [], hh = H.data64F;
      for (var i2 = 0; i2 < n; i2++) {
        var x = src[i2 * 2], y = src[i2 * 2 + 1];
        var w = hh[6] * x + hh[7] * y + hh[8];
        var px = (hh[0] * x + hh[1] * y + hh[2]) / w, py = (hh[3] * x + hh[4] * y + hh[5]) / w;
        if (Math.hypot(px - dst[i2 * 2], py - dst[i2 * 2 + 1]) < (pass === 0 ? 3 : 1.5)) { sIn.push(x, y); dIn.push(dst[i2 * 2], dst[i2 * 2 + 1]); }
      }
      if (sIn.length / 2 < 12) break;
      var sM = cv.matFromArray(sIn.length / 2, 1, cv.CV_32FC2, sIn), dM = cv.matFromArray(dIn.length / 2, 1, cv.CV_32FC2, dIn);
      var H2 = cv.findHomography(sM, dM, 0);
      sM.delete(); dM.delete();
      if (H2 && !H2.empty()) { H.delete(); H = H2; inl = sIn.length / 2; } else { if (H2) H2.delete(); break; }
    }
    // sanity: the homography must be near a plain page transform, not a wild warp
    var h = H.data64F, det = h[0] * h[4] - h[1] * h[3];
    var ok = det > 0.3 && det < 3.5 && Math.abs(h[6]) < 0.01 && Math.abs(h[7]) < 0.01;
    var out = null;
    if (ok) { out = new cv.Mat(); cv.warpPerspective(cand, out, H, new cv.Size(tw, th), cv.INTER_CUBIC, cv.BORDER_REPLICATE); }
    H.delete();
    if (!out) return null;
    return { mat: out, inliers: inl, ratio: inl / n };
  }

  // ---------- ink / density maps ----------
  var DENS_K = 13;
  /** Returns {norm (CV_8U illumination-flattened gray), ink (CV_8U 0/255), dens (CV_32F 0..1)} - all owned by S. */
  function inkMaps(S, bgr) {
    var g = grayOf(S, bgr);
    var bg = S.add(new cv.Mat());
    // paper level: large dilate (removes dark text) then blur
    cv.dilate(g, bg, S.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(21, 21))));
    cv.GaussianBlur(bg, bg, new cv.Size(0, 0), 15);
    var norm = S.add(new cv.Mat());
    cv.divide(g, bg, norm, 255, cv.CV_8U);
    var ink = S.add(new cv.Mat());
    cv.threshold(norm, ink, 172, 255, cv.THRESH_BINARY_INV);
    var inkf = S.add(new cv.Mat());
    ink.convertTo(inkf, cv.CV_32F, 1 / 255);
    var dens = S.add(new cv.Mat());
    cv.boxFilter(inkf, dens, -1, new cv.Size(DENS_K, DENS_K), new cv.Point(-1, -1), true, cv.BORDER_CONSTANT);
    return { norm: norm, ink: ink, dens: dens };
  }

  function blobsFromMask(S, maskU8, minArea, maxArea) {
    var labels = S.add(new cv.Mat()), stats = S.add(new cv.Mat()), cents = S.add(new cv.Mat());
    var n = cv.connectedComponentsWithStats(maskU8, labels, stats, cents, 8, cv.CV_32S);
    var out = [];
    for (var i = 1; i < n; i++) {
      var area = stats.intAt(i, cv.CC_STAT_AREA);
      if (area < minArea || area > maxArea) continue;
      out.push({ x: stats.intAt(i, cv.CC_STAT_LEFT), y: stats.intAt(i, cv.CC_STAT_TOP), w: stats.intAt(i, cv.CC_STAT_WIDTH), h: stats.intAt(i, cv.CC_STAT_HEIGHT), area: area, cx: cents.doubleAt(i, 0), cy: cents.doubleAt(i, 1) });
    }
    return out;
  }

  // ---------- 3. answer marks on the key ----------
  var MARK_DENS = 0.62;
  var NEW_INK_DENS = 0.30;
  /**
   * Detect shaded answers on a canonical key page. Returns array of {x,y,w,h,cx,cy,score}.
   * `skipTop` (px) ignores the printed heading band on page 1.
   */
  function detectAnswerMarks(bgr, opts) {
    opts = opts || {};
    var S = new Scope();
    try {
      var m = inkMaps(S, bgr);
      var thr = S.add(new cv.Mat());
      cv.threshold(m.dens, thr, MARK_DENS, 255, cv.THRESH_BINARY);
      thr.convertTo(thr, cv.CV_8U);
      var blobs = blobsFromMask(S, thr, 38, 9000);
      var res = [];
      for (var i = 0; i < blobs.length; i++) {
        var b = blobs[i];
        if (b.cy < (opts.skipTop || 0)) continue;
        if (b.w < 10 || b.h < 14) continue;                      // too small: underscores / punctuation, not a shaded letter
        if (b.w > 150 || b.h > 70) continue;                    // too big: smudge / table / heading
        var fill = b.area / (b.w * b.h);
        if (fill < 0.3) continue;
        // true ink fraction inside the blob box
        var roi = m.ink.roi(new cv.Rect(b.x, b.y, b.w, b.h));
        var inkFrac = cv.countNonZero(roi) / (b.w * b.h); roi.delete();
        if (inkFrac < 0.5) continue;
        res.push({ x: b.x, y: b.y, w: b.w, h: b.h, cx: b.cx, cy: b.cy, score: inkFrac });
      }
      return mergeNearby(res);
    } finally { S.free(); }
  }
  function mergeNearby(marks) {   // sprawling shading can split into pieces: merge pieces <12px apart on one line
    marks.sort(function (a, b) { return a.cy - b.cy || a.cx - b.cx; });
    var used = new Array(marks.length), out = [];
    for (var i = 0; i < marks.length; i++) {
      if (used[i]) continue;
      var a = { x: marks[i].x, y: marks[i].y, x2: marks[i].x + marks[i].w, y2: marks[i].y + marks[i].h, s: marks[i].score, n: 1 };
      var changed = true;
      while (changed) {
        changed = false;
        for (var j = i + 1; j < marks.length; j++) {
          if (used[j]) continue;
          var b = marks[j], bx2 = b.x + b.w, by2 = b.y + b.h;
          var gx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x2, bx2)), gy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y2, by2));
          if (gx < 12 && gy < 8 && Math.max(a.x2, bx2) - Math.min(a.x, b.x) < 150) {
            a.x = Math.min(a.x, b.x); a.y = Math.min(a.y, b.y); a.x2 = Math.max(a.x2, bx2); a.y2 = Math.max(a.y2, by2); a.s = Math.max(a.s, b.score); a.n++; used[j] = true; changed = true;
          }
        }
      }
      out.push({ x: a.x, y: a.y, w: a.x2 - a.x, h: a.y2 - a.y, cx: (a.x + a.x2) / 2, cy: (a.y + a.y2) / 2, score: a.s });
    }
    return out;
  }

  // ---------- 4. question zones ----------
  /**
   * Splits a key page into question zones. Every zone holds exactly one shaded answer.
   * Uses the printed question numbers in the left gutter of each text column when it can
   * (so un-shaded theory questions and headings are ignored); otherwise falls back to
   * splitting halfway between consecutive answers in a column.
   * Returns [{x,y,w,h, markIndex, col}] (reading order: column by column, top to bottom).
   */
  function buildZones(bgr, marks) {
    var S = new Scope();
    try {
      var m = inkMaps(S, bgr);
      var W = bgr.cols, H = bgr.rows;
      // Rub the shaded answers out of a copy of the ink map: heavy shading bridges the gap
      // between two text lines and would otherwise merge them into one tall "line".
      var clean = S.add(m.ink.clone());
      for (var q = 0; q < marks.length; q++) {
        var mk = marks[q];
        cv.rectangle(clean, new cv.Point(Math.max(0, Math.round(mk.x) - 4), Math.max(0, Math.round(mk.y) - 4)),
          new cv.Point(Math.min(W - 1, Math.round(mk.x + mk.w) + 4), Math.min(H - 1, Math.round(mk.y + mk.h) + 4)), new cv.Scalar(0, 0, 0, 0), -1);
      }
      m = { ink: clean };
      var cols = findColumns(S, m.ink, W, H);
      var zones = [];
      var usedMark = {};
      for (var ci = 0; ci < cols.length; ci++) {
        var col = cols[ci];
        var colMarks = [];
        for (var k = 0; k < marks.length; k++) if (marks[k].cx >= col.x0 - 5 && marks[k].cx <= col.x1 + 5) colMarks.push(k);
        colMarks.sort(function (a, b) { return marks[a].cy - marks[b].cy; });
        if (!colMarks.length) continue;
        var starts = findQuestionStarts(S, m.ink, col);
        var made = null;
        if (starts.length >= 2) made = zonesFromStarts(starts, col, marks, colMarks, H);
        if (!made) made = zonesFromMarks(col, marks, colMarks, H);
        for (var z = 0; z < made.length; z++) { made[z].col = ci; zones.push(made[z]); usedMark[made[z].markIndex] = true; }
      }
      return zones;
    } finally { S.free(); }
  }

  function findColumns(S, ink, W, H) {
    // vertical ink profile over the body of the page (skip heading band)
    var y0 = Math.round(H * 0.16), y1 = Math.round(H * 0.95);
    var roi = ink.roi(new cv.Rect(0, y0, W, y1 - y0));
    var prof = S.add(new cv.Mat());
    cv.reduce(roi, prof, 0, cv.REDUCE_SUM, cv.CV_32S);
    roi.delete();
    var p = new Array(W);
    for (var x = 0; x < W; x++) p[x] = prof.intAt(0, x) / 255;
    var first = 0, last = W - 1;
    var thr = 3;
    while (first < W && p[first] <= thr) first++;
    while (last > 0 && p[last] <= thr) last--;
    var gaps = [], run = 0, start = -1;
    for (var x2 = first; x2 <= last; x2++) {
      if (p[x2] <= 1) { if (start < 0) start = x2; run++; }
      else { if (start >= 0 && run >= 18) gaps.push([start, x2 - 1]); start = -1; run = 0; }
    }
    var cols = [], cx = first;
    gaps.forEach(function (g) { cols.push({ x0: cx, x1: g[0] - 1 }); cx = g[1] + 1; });
    cols.push({ x0: cx, x1: last });
    return cols.filter(function (c) { return c.x1 - c.x0 > W * 0.15; });
  }

  function textLines(S, ink, col, yFrom, yTo) {
    var w = col.x1 - col.x0 + 1;
    var roi = ink.roi(new cv.Rect(col.x0, yFrom, w, yTo - yFrom));
    var prof = S.add(new cv.Mat());
    cv.reduce(roi, prof, 1, cv.REDUCE_SUM, cv.CV_32S);
    var lines = [], start = -1, gap = 0;
    for (var y = 0; y < prof.rows; y++) {
      var v = prof.intAt(y, 0) / 255;
      if (v > 1.5) { if (start < 0) start = y; gap = 0; }
      else if (start >= 0) { gap++; if (gap >= 3) { if (y - gap - start >= 7) lines.push([start + yFrom, y - gap + yFrom]); start = -1; gap = 0; } }
    }
    if (start >= 0 && prof.rows - start >= 7) lines.push([start + yFrom, prof.rows + yFrom]);
    roi.delete();
    return lines;
  }

  function findQuestionStarts(S, ink, col) {
    var H = ink.rows;
    var lines = textLines(S, ink, col, 0, H);
    if (lines.length < 4) return [];
    var infos = [];
    for (var i = 0; i < lines.length; i++) {
      var y0 = lines[i][0], y1 = lines[i][1], w = col.x1 - col.x0 + 1;
      var roi = ink.roi(new cv.Rect(col.x0, y0, w, y1 - y0));
      var prof = S.add(new cv.Mat());
      cv.reduce(roi, prof, 0, cv.REDUCE_SUM, cv.CV_32S);
      roi.delete();
      // clusters of ink columns separated by gaps >= 9px
      var cl = [], s = -1, gp = 0;
      for (var x = 0; x < w; x++) {
        var v = prof.intAt(0, x) > 0;
        if (v) { if (s < 0) s = x; gp = 0; }
        else if (s >= 0) { gp++; if (gp >= 9) { cl.push([s, x - gp]); s = -1; gp = 0; } }
      }
      if (s >= 0) cl.push([s, w - 1]);
      infos.push({ y0: y0, y1: y1, cl: cl, left: cl.length ? cl[0][0] : 999 });
    }
    // The numbers sit flush left; wrapped lines start at the text indent (hanging indent).
    var cand = infos.filter(function (l) { return l.left <= 8 && l.cl.length >= 2 && (l.cl[0][1] - l.cl[0][0]) <= 42; });
    if (cand.length < 2) return [];
    // indent = the typical start of the second cluster on candidate lines
    var seconds = cand.map(function (l) { return l.cl[1][0]; }).sort(function (a, b) { return a - b; });
    var indent = seconds[Math.floor(seconds.length / 2)];
    var starts = cand.filter(function (l) { return Math.abs(l.cl[1][0] - indent) <= 8; });
    return starts.map(function (l) { return { y0: l.y0, y1: l.y1 }; });
  }

  function zonesFromStarts(starts, col, marks, colMarks, H) {
    // zone i = [starts[i].y0 - 4, starts[i+1].y0 - 4) ; keep zones that contain >= 1 shaded answer
    var zones = [];
    for (var i = 0; i < starts.length; i++) {
      var top = starts[i].y0 - 5;
      var bot = i + 1 < starts.length ? starts[i + 1].y0 - 5 : H;
      var inside = colMarks.filter(function (k) { return marks[k].cy >= top && marks[k].cy < bot; });
      if (!inside.length) continue;
      inside.sort(function (a, b) { return marks[b].score - marks[a].score; });
      zones.push({ x: col.x0, y: top, w: col.x1 - col.x0 + 1, h: bot - top, markIndex: inside[0], extraMarks: inside.slice(1) });
    }
    // every shaded answer must be covered, otherwise this layout is not what we assumed
    var covered = {};
    zones.forEach(function (z) { covered[z.markIndex] = 1; z.extraMarks.forEach(function (k) { covered[k] = 1; }); });
    for (var c = 0; c < colMarks.length; c++) if (!covered[colMarks[c]]) return null;
    return zones;
  }

  function zonesFromMarks(col, marks, colMarks, H) {
    var zones = [];
    for (var i = 0; i < colMarks.length; i++) {
      var k = colMarks[i], cy = marks[k].cy;
      var top = i === 0 ? Math.max(0, cy - 60) : (marks[colMarks[i - 1]].cy + cy) / 2;
      var bot = i + 1 < colMarks.length ? (cy + marks[colMarks[i + 1]].cy) / 2 : Math.min(H, cy + 60);
      zones.push({ x: col.x0, y: Math.round(top), w: col.x1 - col.x0 + 1, h: Math.round(bot - top), markIndex: k, extraMarks: [] });
    }
    return zones;
  }

  // ---------- 5. scoring ----------
  /**
   * keyBgr / learnerBgr: canonical, already aligned.  keyPage = {marks, zones}.
   * Returns per-question results (same order as keyPage.zones):
   *   {status: 'correct'|'wrong'|'blank'|'multiple', hit, extras:[{x,y,w,h}], learnerDensity}
   */
  function scoreLearnerPage(keyBgr, learnerBgr, keyPage) {
    var S = new Scope();
    try {
      var km = inkMaps(S, keyBgr), lm = inkMaps(S, learnerBgr);
      // local re-centring of every answer box (paper curl / small warp)
      var offs = keyPage.zones.map(function (z) {
        var mk = keyPage.marks[z.markIndex];
        return localOffset(S, km.norm, lm.norm, mk);
      });
      // New ink = ink on the learner page that is NOT explained by the key page's printed text
      // (key ink grown by a few pixels so a 1-3px registration error does not create ghosts).
      var grown = S.add(new cv.Mat());
      cv.dilate(km.ink, grown, S.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9))));
      var notGrown = S.add(new cv.Mat());
      cv.bitwise_not(grown, notGrown);
      var newInk = S.add(new cv.Mat());
      cv.bitwise_and(lm.ink, notGrown, newInk);
      var nf = S.add(new cv.Mat()), nd = S.add(new cv.Mat());
      newInk.convertTo(nf, cv.CV_32F, 1 / 255);
      cv.boxFilter(nf, nd, -1, new cv.Size(DENS_K, DENS_K), new cv.Point(-1, -1), true, cv.BORDER_CONSTANT);
      var dthr = S.add(new cv.Mat());
      cv.threshold(nd, dthr, NEW_INK_DENS, 255, cv.THRESH_BINARY);
      dthr.convertTo(dthr, cv.CV_8U);
      var nb = blobsFromMask(S, dthr, 50, 9000).filter(function (b) { return b.w >= 10 && b.h >= 12 && b.w <= 150 && b.h <= 70; });
      nb = mergeNearby(nb.map(function (b) { b.score = 1; return b; }));
      var results = [];
      var W = learnerBgr.cols, H = learnerBgr.rows;
      keyPage.zones.forEach(function (z, zi) {
        var mk = keyPage.marks[z.markIndex], off = offs[zi];
        var rx = clamp(Math.round(mk.x + off[0]) - 2, 0, W - 2), ry = clamp(Math.round(mk.y + off[1]) - 2, 0, H - 2);
        var rw = Math.min(mk.w + 4, W - rx), rh = Math.min(mk.h + 4, H - ry);
        var kroi = km.ink.roi(new cv.Rect(Math.round(mk.x) - 2 < 0 ? 0 : Math.round(mk.x) - 2, Math.round(mk.y) - 2 < 0 ? 0 : Math.round(mk.y) - 2, Math.min(rw, W), Math.min(rh, H)));
        var kfrac = cv.countNonZero(kroi) / (kroi.cols * kroi.rows); kroi.delete();
        var lroi = lm.ink.roi(new cv.Rect(rx, ry, rw, rh));
        var lfrac = cv.countNonZero(lroi) / (rw * rh); lroi.delete();
        var hit = lfrac >= Math.max(0.42, 0.62 * kfrac);
        var extras = [];
        nb.forEach(function (b) {
          if (b.cy < z.y || b.cy >= z.y + z.h || b.cx < z.x - 5 || b.cx > z.x + z.w + 5) return;
          // ignore new ink that is just the learner shading the same answer a bit bigger
          var ox = Math.max(0, Math.min(b.x + b.w, mk.x + off[0] + mk.w + 10) - Math.max(b.x, mk.x + off[0] - 10));
          var oy = Math.max(0, Math.min(b.y + b.h, mk.y + off[1] + mk.h + 8) - Math.max(b.y, mk.y + off[1] - 8));
          if (ox * oy > 0.3 * b.w * b.h) return;
          extras.push({ x: b.x, y: b.y, w: b.w, h: b.h });
        });
        var status = hit ? (extras.length ? 'multiple' : 'correct') : (extras.length ? 'wrong' : 'blank');
        results.push({ status: status, hit: hit, extras: extras, learnerDensity: round3(lfrac), keyDensity: round3(kfrac), box: { x: rx, y: ry, w: rw, h: rh }, offset: off });
      });
      return results;
    } finally { S.free(); }
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  /** small template match of the text around an answer to absorb local misalignment */
  function localOffset(S, keyNorm, learnerNorm, mk) {
    var W = keyNorm.cols, H = keyNorm.rows;
    var pad = 26, srch = 12;
    var tx = clamp(Math.round(mk.x - 70), srch, W - 2), ty = clamp(Math.round(mk.y - pad), srch, H - 2);
    var tw = Math.min(Math.round(mk.w + 140), W - srch - tx), th = Math.min(Math.round(mk.h + 2 * pad), H - srch - ty);
    if (tw < 40 || th < 20 || tx - srch < 0 || ty - srch < 0) return [0, 0];
    // use the key text only: blank out the shaded answer so it does not dominate the match
    var tpl = S.add(keyNorm.roi(new cv.Rect(tx, ty, tw, th)).clone());
    var wnd = S.add(learnerNorm.roi(new cv.Rect(tx - srch, ty - srch, tw + 2 * srch, th + 2 * srch)).clone());
    var res = S.add(new cv.Mat());
    cv.matchTemplate(wnd, tpl, res, cv.TM_CCOEFF_NORMED);
    var mm = cv.minMaxLoc(res);
    if (mm.maxVal < 0.45) return [0, 0];
    return [mm.maxLoc.x - srch, mm.maxLoc.y - srch];
  }

  return {
    CANON_W: CANON_W, CANON_H: CANON_H,
    init: init, findPageQuad: findPageQuad, rectifyPage: rectifyPage, alignToTemplate: alignToTemplate,
    detectAnswerMarks: detectAnswerMarks, buildZones: buildZones, scoreLearnerPage: scoreLearnerPage,
    _internals: { inkMaps: inkMaps, findColumns: findColumns, findQuestionStarts: findQuestionStarts, Scope: Scope }
  };
});
