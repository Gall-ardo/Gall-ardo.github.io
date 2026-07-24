# Hierarchical Threshold Tuner — 20260723_003920 (upgraded 2026-07-23)

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
  original 827, those clips have no metric scores: downstream stages treat them via each
  stage's missing-score policy and the Gemini estimate excludes them.
- Stage 2: DOVER++ overall (slider; 9/827 clips have no DOVER score -> keep/drop policy toggle, default keep)
- Stage 3: NISQA MOS (slider)
- Stage 4: Audiobox Aesthetics — NO full-827 scores exist (only random-100 + 49-clip smoke).
  Pass-through in the Full view; tunable only in the separate Random-100 view.
  Random-100 results are NOT extrapolated to the full set.
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
- runs/model_benchmark/audiobox_aesthetics_random100/20260708_231654/audiobox_random100_scores.csv
- runs/model_benchmark/gemini_flash_random200/20260630_230457/gemini_results.jsonl (estimation only)

## Files
- gen_data.py — regenerates data.js from the inputs above (asserts: per-row recompute of the
  4 default rules == op_* flags for all 1000 clips, 1000/173/827, manifest identity,
  gemini-200 ⊂ 827 with 143 keep / 57 drop)
- data.js — embedded per-clip raw numeric stats + metric scores (1000 clips; 827 with metrics)
- index.html — the dashboard (vanilla JS, no network calls; open locally or via any static server)

Thresholds persist in the URL hash (e.g. #dover=30&nisqa=1&av=0.2&n_dark=30&noff=motion&view=r100) — shareable.

Deployed copy: runs/final_filtering/final_two_stage_1000/web_dashboard/hierarchical_threshold_tuner/

## Verification (2026-07-23, post-upgrade)
- Stage 1 default recomputation == official manifests (asserted in gen_data.py, per-row per-flag)
- Dashboard cascade counts cross-checked against an independent Python computation
  (default + tuned numeric settings and the Gemini-estimate arithmetic).
- Rendered light+dark in headless Chrome, no console errors.
