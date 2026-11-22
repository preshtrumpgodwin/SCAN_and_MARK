// Adjusts the generated Android project: camera permission, portrait lock, app label.
const fs = require('fs'), path = require('path');
const mf = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
let x = fs.readFileSync(mf, 'utf8');
if (!x.includes('android.permission.CAMERA')) {
  x = x.replace(/<application/, '<uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />\n\n    <application');
}
if (!x.includes('screenOrientation')) {
  x = x.replace(/<activity/, '<activity\n            android:screenOrientation="portrait"');
}
fs.writeFileSync(mf, x);
console.log('AndroidManifest.xml patched');
