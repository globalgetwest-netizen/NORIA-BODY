Put the two real Noria face images here, named exactly:

  noria-f.png   (or .jpg / .jpeg / .webp)   — the gold-suit Noria-F render
  noria-m.png   (or .jpg / .jpeg / .webp)   — the Noria-M render

Portrait, face centered, roughly head-and-shoulders works best.
After adding them, refresh http://localhost:5178 — Noria becomes your real image,
alive (head motion, breathing, blink, gaze) and speaking from the live engine.

If the blink/mouth land slightly off, tell me and I'll fine-tune the per-image
calibration (eye + mouth positions) in public/image-face.js (the CAL object).
