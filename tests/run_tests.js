const fs = require('fs'), path = require('path');
const jpeg = require('jpeg-js'), { PNG } = require('pngjs');
const Engine = require('../www/js/omr-engine.js');
let cv = require('@techstark/opencv-js');
const D = path.join(__dirname, 'data');
const truth = JSON.parse(fs.readFileSync(path.join(D, 'truth.json')));
function load(file) {
  const buf = fs.readFileSync(path.join(D, file));
  const img = file.endsWith('.png') ? PNG.sync.read(buf) : jpeg.decode(buf, { useTArray: true });
  return cv.matFromImageData({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });
}
function run() {
  Engine.init(cv);
  const only = process.argv[2];
  const t0 = Date.now();
  // ---- key ----
  const keyPages = [];
  for (let p = 1; p <= 2; p++) {
    const photo = load(`key_p${p}.jpg`);
    const canon = Engine.rectifyPage(photo);
    if (!canon) { console.log('KEY page', p, 'rectify FAILED'); process.exit(1); }
    const marks = Engine.detectAnswerMarks(canon, { skipTop: p === 1 ? 190 : 0 });
    const zones = Engine.buildZones(canon, marks);
    keyPages.push({ canon, marks, zones, cache: {} });
    console.log(`key p${p}: marks=${marks.length} zones=${zones.length}`);
    photo.delete();
  }
  const totalMarks = keyPages.reduce((a, k) => a + k.zones.length, 0);
  console.log('total zones', totalMarks, 'expected', truth.n, ' (', Date.now() - t0, 'ms )');
  // check each truth question has a key zone containing its shaded option
  let keyOk = 0;
  truth.questions.forEach(q => {
    const L = truth.key[q.n][0], b = q.opts[L];
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const kp = keyPages[q.page];
    const z = kp.zones.find(z => { const m = kp.marks[z.markIndex]; return Math.abs(m.cx - cx) < 30 && Math.abs(m.cy - cy) < 18; });
    if (z) keyOk++; else console.log('  key miss Q' + q.n, L, Math.round(cx), Math.round(cy));
  });
  console.log(`key answers located correctly: ${keyOk}/${truth.n}`);
  // ---- learners ----
  const names = Object.keys(truth.learners).filter(n => !only || n.includes(only));
  let allGood = true;
  for (const name of names) {
    const tl = Date.now();
    const results = [];
    let fail = null;
    for (let p = 1; p <= 2; p++) {
      const photo = load(`${name}_p${p}.jpg`);
      const al = Engine.alignToTemplate(photo, keyPages[p - 1].canon, keyPages[p - 1].cache);
      photo.delete();
      if (al.error) { fail = al.error; break; }
      const r = Engine.scoreLearnerPage(keyPages[p - 1].canon, al.mat, keyPages[p - 1]);
      results.push({ r, al: { inliers: al.inliers, method: al.method } });
      al.mat.delete();
    }
    if (fail) { console.log(name, 'ALIGN FAIL', fail); allGood = false; continue; }
    // map zones to question numbers via the key positions
    let correct = 0, agree = 0, total = 0, mism = [];
    truth.questions.forEach(q => {
      const kp = keyPages[q.page], L = truth.key[q.n][0], b = q.opts[L];
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      const zi = kp.zones.findIndex(z => { const m = kp.marks[z.markIndex]; return Math.abs(m.cx - cx) < 30 && Math.abs(m.cy - cy) < 18; });
      if (zi < 0) return;
      total++;
      const got = results[q.page].r[zi].status, want = truth.learners[name].kinds[q.n];
      if (got === 'correct') correct++;
      if (got === want || (want === 'wrong' && got === 'wrong')) agree++; else mism.push(`Q${q.n}:${want}->${got}`);
    });
    const wantScore = truth.learners[name].score;
    const ok = correct === wantScore;
    if (!ok) allGood = false;
    console.log(`${name}: score ${correct}/${truth.n} (expected ${wantScore}) ${ok ? 'OK' : 'MISMATCH'}  status-agree ${agree}/${total}  inliers ${results.map(x => x.al.inliers + '/' + x.al.method).join(',')}  ${(Date.now() - tl)}ms`);
    if (mism.length) console.log('   differences:', mism.join(' '));
  }
  console.log(allGood ? 'ALL SCORES MATCH' : 'SOME DIFFER');
  process.exit(0);
}
if (cv.Mat) run(); else cv.onRuntimeInitialized = run;
