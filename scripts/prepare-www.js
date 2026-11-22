// Copies the third-party browser files the app needs into www/vendor (run by "npm run prepare-www").
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'www', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = {
  'capacitor.js': '@capacitor/core/dist/capacitor.js',
  'share.js': '@capacitor/share/dist/plugin.js',
  'filesystem.js': '@capacitor/filesystem/dist/plugin.js',
  'opencv.js': '@techstark/opencv-js/dist/opencv.js'
};
for (const [dst, src] of Object.entries(files)) {
  const from = path.join(root, 'node_modules', src);
  if (!fs.existsSync(from)) { console.error('Missing ' + from + ' - did "npm install" finish?'); process.exit(1); }
  fs.copyFileSync(from, path.join(out, dst));
  console.log('copied', dst);
}
