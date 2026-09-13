# NORIA — Stage 2 (photoreal) proof

Goal: **prove a photoreal, talking Noria for $0** before spending anything on
hosting a realism engine.

`NORIA_Stage2_SadTalker_Colab.ipynb` runs **SadTalker** (open-source) on Google
Colab's **free GPU**. It pulls Noria's real render from the live site, generates
a warm voice line, and outputs a **video of Noria actually talking** — real
lip-sync, natural head motion, blinking.

## Run it (free, ~10–15 min)
1. Open the notebook in Colab (one click from GitHub, or upload it to
   [colab.research.google.com](https://colab.research.google.com)).
2. `Runtime → Change runtime type → T4 GPU`.
3. `Runtime → Run all`. Watch the video appear in the last cell.

## What this proves / doesn't
- **Proves:** the *look* of Stage 2 — a real, talking Noria from a single image.
- **Not yet:** real-time / interactive. SadTalker renders a clip per utterance
  (a few seconds of compute). Real-time, live conversation needs a persistent
  GPU running a streaming model (e.g. MuseTalk) — that's the paid-hosting step,
  and this proof is how you decide whether it's worth it.

Model/library versions drift; if a cell errors, send the error to Claude to patch.
