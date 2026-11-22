# Scan & Score (Android app)

Marks **objective questions straight from the printed question paper**. Learners shade their answers on the
paper itself. The teacher scans one shaded paper (the answer key), then scans each learner's paper with the
phone camera. Theory questions are ignored. Papers can have 1–4 pages.

## Get the APK (no coding needed)

1. Create a free account at **github.com** and click **New repository** (name it `scan-and-score`, keep it Private).
2. On the new repo page click **uploading an existing file**, then drag in **everything inside this folder**
   (including the hidden `.github` folder – if your browser skips it, create the file
   `.github/workflows/build-apk.yml` by hand with *Add file → Create new file* and paste in its contents).
   Click **Commit changes**.
3. Open the **Actions** tab. The *Build Android APK* job starts by itself (or click it → **Run workflow**).
   It takes about 6–10 minutes. A green tick means success.
4. Click the finished run, scroll to **Artifacts**, download **Scan-and-Score-APK**, unzip it → `app-debug.apk`.
5. Send the APK to the phone (WhatsApp/Drive/USB), tap it, allow *Install unknown apps*, install, open, allow **Camera**.

If the job shows a red ✗, open it, copy the last red lines and send them to me.

## Using the app

1. **New exam** → name it, choose how many pages the paper has.
2. **Scan answer key** → shade the correct answer for every objective question on a paper (use a dark pen or a
   soft pencil, fill the option letter completely). Scan each page. The app shows what it found in green: tap a
   green box to remove a wrong one, tap a missed shaded answer to add it. Check the count matches your number of questions.
3. **Score a learner** → type the name first, then scan each page. The score appears straight away.
   Questions where the learner shaded two options are flagged orange (they score 0 until you tap the number to decide).
4. Tap any question number on the result screen to flip it between right/wrong. **Export CSV** shares the class results.

## Tips for good scans

* Lay the paper flat on a **dark table** (a dark exercise book or cloth is fine); keep all 4 corners in view.
* Good light, no shadow of your hand or phone across the page. Hold still until the bar fills; the phone captures by itself.
* Print the answer key and the learners' papers from the **same file**, so every page looks identical.
* Keep the heading at the top of the page (not upside down).
* Scan pages in order: page 1, then page 2, …

## What is inside

* `www/js/omr-engine.js` – the scoring engine (finds the page, aligns it to the answer key, finds shaded answers,
  compares). Runs on-device with OpenCV; no internet needed after install.
* `www/js/camera.js`, `app.js`, `store.js` – live scanner, screens, local storage (everything stays on the phone).
* `tests/` – `npm test` runs the engine on synthetic photos of your JSS3 paper (pen, pencil, tilted, double-shaded, blank).
