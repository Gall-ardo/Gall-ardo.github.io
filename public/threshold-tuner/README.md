# Hierarchical Threshold Tuner — 20260723_003920 (upgraded 2026-07-24)

Static interactive dashboard for tuning the sequential filtering cascade of
final_two_stage_1000. A clip dropped at any stage never enters later stages;
moving an upstream slider live-recomputes all downstream input/dropped/kept counts.

## Cascade
- Stage 0: all 1000 clips
- Stage 1 (tunable since the 2026-07-23 upgrade): numeric hard filter with per-rule
  sliders + enable toggles. Defaults are exactly the official rule and reproduce the
  official numeric manifests (1000 → 827 kept, cross-checked):
    audio_silent:    audio_peak < 0.05 AND audio_rms < 0.01
    too_static:      pixel_avg < 0.01
    too_dark:        mean_luma < 20
    too_much_motion: pixel_avg > 0.35
  Drop if ANY enabled rule fires. Missing raw stats (9 decode-failure clips) never fire
  a rule, matching the official filter. If loosened thresholds admit clips outside the
  original 827, those clips have no DOVER/NISQA/AV scores: those stages treat them via each
  stage's missing-score policy and the Gemini estimate excludes them. Audiobox is the
  exception — since the full-1000 run it covers every clip, loosened settings included.
- Stage 2: DOVER++ overall (slider; 9/827 clips have no DOVER score -> keep/drop policy toggle, default keep)
- Stage 3: NISQA MOS (slider)
- Stage 4: Audiobox Aesthetics — since the 2026-07-24 full-1000 run this is a LIVE, tunable
  stage in the Full view (it used to be a pass-through). All 1000 clips have a score, so the
  slider filters the whole dataset even when numeric thresholds are loosened past the 827.
  The separate Random-100 view was removed once Audiobox covered every clip — it showed
  the same scores restricted to an arbitrary 100-clip subset and added nothing.
- Stage 5: AVBench AV consistency (slider)
- Stage 6: surviving clips -> would go to Gemini 2.5 Flash on 720p_8fps proxies (NOT executed).
  Since the 2026-07-23 upgrade this stage shows an ESTIMATED Gemini keep count: the keep
  rate among surviving clips that already have a decision in the existing Gemini 2.5 Flash
  random-200 run (143/200 keep overall; uniformly sampled from the 827) is applied to the
  surviving clips inside the 827 pool, with a Wilson 95% CI. No Gemini call is made.

## Inputs (read-only)
- runs/filter_sweep/20260624_000610/scores.csv (raw numeric stats + op_* flags, 1000 clips)
- runs/final_filtering/final_two_stage_1000/numeric_prefilter_manifest.jsonl (cross-check)
- runs/model_benchmark/avbench_metric_pipeline_827/20260706_101334/combined_metric_scores_827.csv
- runs/model_benchmark/audiobox_aesthetics_full1000/20260724_202922 (all 1000 Audiobox scores — current)
- runs/model_benchmark/gemini_flash_random200/20260630_230457/gemini_results.jsonl (estimation only)

## Audiobox Aesthetics full-1000 run

| Metric | Rows | Failures | Seconds / clip | Peak VRAM |
|---|---|---|---|---|
| Audiobox Aesthetics | 1000 | 0 | 0.208 | 7150 MiB on Tesla T4 |

- Source run: `runs/model_benchmark/audiobox_aesthetics_full1000/20260724_202922`
- Model `facebook/audiobox-aesthetics`; avg_score = (CE + CU + PQ − PC) / 4
- Merged into `data.js` with `merge_audiobox_full1000_into_threshold_tuner.py --in-place`
  (900 nulls filled, 100 previously-sampled values refreshed, 0 clips unmatched; a timestamped
  `.bak` of the previous `data.js` sits beside it).
- Peak VRAM is the process-specific figure from `nvidia-smi` polling on a dedicated T4;
  0.208 s/clip is wall time over all 1000 clips including audio extraction.

## Files
- gen_data.py — regenerates data.js from the inputs above (asserts: per-row recompute of the
  4 default rules == op_* flags for all 1000 clips, 1000/173/827, manifest identity,
  gemini-200 ⊂ 827 with 143 keep / 57 drop)
- data.js — embedded per-clip raw numeric stats + metric scores (1000 clips; 827 with
  DOVER/NISQA/AV, all 1000 with Audiobox)
- index.html — the dashboard (vanilla JS, no network calls; open locally or via any static server)

Thresholds persist in the URL hash (e.g. #dover=30&nisqa=1&audiobox=3&av=0.2&n_dark=30&noff=motion) — shareable.

Deployed copy: runs/final_filtering/final_two_stage_1000/web_dashboard/hierarchical_threshold_tuner/

## Verification (2026-07-23, post-upgrade)
- Stage 1 default recomputation == official manifests (asserted in gen_data.py, per-row per-flag)
- Dashboard cascade counts cross-checked against an independent Python computation
  (default + tuned numeric settings and the Gemini-estimate arithmetic).
- Rendered light+dark in headless Chrome, no console errors.

## Verification (2026-07-24, Audiobox full-1000 merge)
Headless Chromium, 33 checks, all passing:
- 1000/1000 clips carry a non-null Audiobox score; `audiobox_n` = 1000,
  `domains.audiobox` = {min 0.9727, max 5.4011, n 1000}, coverage marker `full1000`.
- Audiobox is no longer a pass-through in the Full view — the stage renders a slider and
  reports real drop counts (threshold 3.50 on the default cascade drops 577 of 827).
- Default numeric thresholds still give **173 dropped / 827 kept**, before and after a
  full tuning round-trip and after the numeric reset button.
- With every numeric rule disabled (1000 clips entering), the Audiobox stage reports
  **zero** missing-score clips and still filters — DOVER still reports its 827-only gap,
  which is the control showing the check is real.
- Downstream cascade and the Gemini estimate both recompute from the Audiobox slider
  (≈591 keep → ≈86 keep at threshold 3.50).
- DOVER, NISQA, AV and the numeric sliders all still drive the cascade; no console errors.

## Change (2026-07-24, later): Random-100 view removed

The tuner is now a single "Full 1000" view. The Random-100 tab existed only because
full Audiobox coverage did not; with all 1000 clips scored it showed the same numbers
over an arbitrary 100-clip subset, so it was removed along with its `view=r100` hash
parameter and the per-clip `ab100` markers. Re-validated headless: 24 checks passing,
defaults still 173 dropped / 827 kept, no console errors.
