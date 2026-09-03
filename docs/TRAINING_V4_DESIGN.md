# Training Overhaul V4 — Phase 0 contract

This document is the frozen design for the V4 training rewrite. Phase 0 encodes types, constants, stubs, store wrappers, and small UI primitives. Workstreams A–L implement behavior against these names. Do not rename exports in `src/sim/training/`.

## Glossary

Nouns the UI uses (and only these):

| Noun | Meaning |
| --- | --- |
| **Model design** | What you configure before a run (architecture, data mix, compute, mode). |
| **Run** | In-flight training of a design. Progress, incidents, and auto-checkpoints live here. |
| **Checkpoint** | Immutable weights plus hidden truth. Created by a run, recipe, or merge. |
| **Recipe** | Post-training job on a checkpoint that produces a new checkpoint. |
| **Endpoint** | What customers buy: one checkpoint, or a router of several. |
| **Tier** | Thinking budget on an endpoint (`1 / 3 / 8 / 20`). |
| **Gym** | RL environment that produces verifiable tasks for post-training. |
| **Eval** | Measurement with a confidence interval. Does not reveal hidden truth. |

## Formulas

Symbols: \(N\) = parameter count (not billions), \(N_{\mathrm{active}}\) = active params, \(N_{\mathrm{total,B}}\) = total params in billions, \(D\) = token count, \(C\) = PF-days, \(L\) = loss, \(g\) = gap, \(\mathrm{PF_{alloc}}\) = allocated petaflops, \(\mathrm{util}\) = utilization.

### Compute

\[
C_{\mathrm{pfdays}} = 6 \cdot N_{\mathrm{active}} \cdot D_{\mathrm{train}} / 8.64\times10^{19} \cdot \mathrm{archCost} \cdot \mathrm{modalityCost}
\]

Holdout adds \(2 \cdot N \cdot D_{\mathrm{holdout}} / 8.64\times10^{19}\) (no arch/modality multipliers unless workstream A documents otherwise).

\[
\mathrm{days} = C_{\mathrm{pfdays}} / (\mathrm{PF_{alloc}} \cdot \mathrm{util} \cdot \mathrm{precisionThroughput} \cdot \mathrm{computeThroughput})
\]

clamped \(\ge \mathrm{paceFloorDays}(N_{\mathrm{total,B}})\).

\[
\mathrm{paceFloorDays}(N_{\mathrm{total,B}}) = \mathrm{clamp}\bigl(8 \cdot (N_{\mathrm{total,B}}/7)^{0.3},\, 3,\, 120\bigr)
\]

`archCost`: dense 1, moe 1.1. `modalityCost`: language 1, vision_language 1.25, audio 1.15, image_generation 1.3, video_generation 1.8, omni 2.2.

`precisionThroughput`: fp32 0.5, fp16_mixed 0.9, bf16_mixed 1.0, fp8_hybrid 1.8, nvfp4 2.7.

Train HBM uses bytes-per-param including optimizer state: fp32 16, fp16/bf16 12, fp8 8, nvfp4 6.

### Scaling law

\[
L(N,D) = E + A \cdot m_A / N_{\mathrm{eff}}^{\alpha} + B \cdot m_B / D_{\mathrm{eff}}^{\beta}
\]

\(E=1.69\), \(A=406.4\), \(B=410.7\), \(\alpha=0.34\), \(\beta=0.28\). \(m_A\) = `paramEfficiency`, \(m_B\) = `dataEfficiency` (1 = baseline, &lt;1 better).

- Dense: \(N_{\mathrm{eff}} = N_{\mathrm{total}}\). Memory still \(N_{\mathrm{total}}\).
- MoE: \(N_{\mathrm{eff}} = N_{\mathrm{active}} \cdot (N_{\mathrm{total}}/N_{\mathrm{active}})^{0.35}\). Data requirement \(\times 1.2\) (i.e. \(D_{\mathrm{eff}} \mathrel{/}= 1.2\)).

\[
D_{\mathrm{eff}} = \sum_{\mathrm{domains}} \mathrm{tokens} \cdot \mathrm{qualityWeight} \cdot \mathrm{diversity} \cdot \mathrm{epochFactor} \cdot \mathrm{syntheticDiscount}
\]

\(\mathrm{epochFactor}(\mathrm{epochs}) = 1 + 0.55 \cdot \log_2(\mathrm{epochs})\) applied to unique tokens.

\[
g = L - E + \mathrm{precisionPenalty}
\]

`precisionPenalty`: fp32 0, fp16_mixed 0.005, bf16_mixed 0, fp8_hybrid 0.02, nvfp4 0.08, then \(\times\) `precisionPenaltyMult`.

\[
\mathrm{capability} = \min\bigl(100 \cdot e^{-1.45 \cdot g},\; \mathrm{ceiling}\bigr)
\]

Ceilings: dense 82, moe 89, specialist (single non-text preset) 90, omni 94, omni verified 97, plus additive `ceilingLift`.

### Distill

\[
g_{\mathrm{student}} = \max(g_{\mathrm{teacher}} + 0.05,\; 0.6 \cdot g_{\mathrm{own}}(N, D_{\mathrm{eff}}))
\]

Compute \(\times 0.2\). May cross the size floor, never the architecture wall.

## Calibration table

Era 0, bf16, 20 tokens/param, no research. Stored as `CALIBRATION_BANDS`.

| Params | tok/param | Expected capability |
| --- | --- | --- |
| 70M | 20 | ≈6 |
| 1B | 20 | ≈26 |
| 7B | 20 | ≈48 |
| 70B | 20 | ≈69 |
| 400B | 20 | ≈80 (dense wall 82) |
| 1T dense | 20 | wall 82 |
| 70B | 1 | ≈50 |

Workstream A must land inside each row’s `tolerance`.

## Research modifier semantics

`TrainingModifiers` freeze at run start (`modifiersFrozen`). See JSDoc on the type.

| Field | Role |
| --- | --- |
| `paramEfficiency` / `dataEfficiency` | Multiply A / B. 1 = baseline, &lt;1 better. |
| `computeThroughput` / `stability` / `precisionPenaltyMult` / `postTrainEfficiency` / `syntheticQuality` / `distillEfficiency` / `serveEfficiency` / `hostingDiscount` / `quantPenaltyMult` / `modalityBridge` | Multiply. 1 = baseline. |
| `ceilingLift` | Additive capability points. |
| `rlQuality` / `routerQuality` / `verifierStrength` | 0–1 qualities. Baseline 0.35 / 0.5 / 0.2. |
| `unlocks` | `TrainingUnlock[]` gated in UI and start-run blockers. |

`modifiersForLab` (workstream E) folds research trees, staff, and programs into this struct. `baselineModifiers()` is the no-research prior.

## RNG contract

\[
g_{\mathrm{actual}} = g_{\mathrm{forecast}} \cdot (1+\varepsilon),\quad \varepsilon \sim \mathcal{N}(0,\sigma)\ \mathrm{clamped\ to\ }\pm 2.5\sigma
\]

\[
\sigma = 0.06 \cdot \mathrm{stability} \cdot \mathrm{engineerFactor} \cdot \mathrm{precisionSigma} \cdot \mathrm{moeUntested} \cdot \mathrm{scaleJump}
\]

- `precisionSigma`: fp8_hybrid 1.15, nvfp4 1.35, else 1.
- `moeUntested`: 1.25 on a lab’s first MoE run, else 1.
- `scaleJump`: \(1 + 0.15 \cdot \max(0, \log_{10}(N / N_{\mathrm{biggestPrior}}))\).

Invariants for workstream A/F:

1. The forecast capability band (P10–P90) must contain the realized outcome **≥80%** of the time under the contracted \(\varepsilon\) clamp.
2. \(\varepsilon\) is drawn once from `(run.seed, …)` and **never rerolled** by incidents, evals, or re-forecasts.
3. Catastrophic failure probability \(\le 2\%\) (`catastrophicMax`). A catastrophe **always leaves the last checkpoint**.
4. Incidents (`maxPerRun` 2, `autoResolveDays` 5) mutate `sigmaMult` / `costMult` / `gapDelta` / progress; they do not redraw \(\varepsilon\).
5. Forecast UI shows P10 / P50 / P90 of capability, plus the architecture ceiling.

## Post-training & tiers

PF at 7B active: instruct 3, preference 5, reasoning 12, agentic 8.

\[
\mathrm{pf} = \mathrm{baseStage} \cdot (N_{\mathrm{active,B}}/7)^{0.75} \cdot \mathrm{dataScale}(\mathrm{tokens})
\]

\[
\mathrm{effect} = \mathrm{adequacy}(\mathrm{data}) \cdot \mathrm{gymQuality} \cdot \mathrm{rlQuality} \cdot \mathrm{completeness}(\mathrm{pf})
\]

Zero work = zero effect.

Thinking budgets `{1,3,8,20}`:

\[
\mathrm{lift}(\mathrm{domain}) = \mathrm{rlQuality} \cdot \bigl(1 - e^{-(\mathrm{budget}-1)/4}\bigr) \cdot \mathrm{maxLift}(\mathrm{domain})
\]

`maxLift`: math / code / science / reasoning = 12; everything else = 4. Output tokens \(\times\) budget.

Gyms: kind ∈ {code, math, science, agentic, safety}, tier 0–3. Constants in `TRAINING_V4.gyms`.

## Evaluation model

| Tier | Cash | Days | σ | Leak |
| --- | --- | --- | --- | --- |
| quick | free | 1 | 4 | 0 |
| suite | $50k–$150k | 2–5 | 2.5 → 1.5 | 0 |
| audit | $400k | 7 | 1 | 10% |

- Latent draw per `(seed, checkpointId, metric)` is **immutable**. Paying again never rerolls.
- Hidden truth (`checkpoint.truth`) is **never shown** for unreleased checkpoints. UI uses eval means + CI, or “Unmeasured”.
- Seasons (`PublicSeason`) shift public boards and can flag contaminated endpoint metrics.

## Endpoints / routers

Policies: `single` | `domain` | `cascade` | `modality`.

Composite capabilities = policy-weighted max of member truths, minus misroute penalty (`misrouteBase` 0.06; cascade adds `cascadeEscalation`). HBM = **all members resident**. Sunset drain defaults to 30 days. Merge: bonus 1.5, regression risk 0.15.

`projectEndpointsToModels` keeps `player.models` as the market-facing projection. `Endpoint.modelId === Endpoint.id`.

## Data coupling

- `reserveTokens` / `releaseReservation` bind unique domain tokens to a run id so two runs cannot spend the same unique tokens.
- Synthetic lineage (teacher, depth, verified share) feeds `syntheticDiscount` and post-train pools.
- Post-train pools: instruction MTok, preference MTok, verifiable tasks, tool trajectories.

## State layout

- `player.training: TrainingState` — player V4 slice (runs, checkpoints, recipes, evals, endpoints, gyms, pools, reservations, seasons). Required from save v15.
- `rivals[i].training: TrainingState` — same slice per rival.
- `player.models` remains the **endpoint projection** consumed by the market adapter until workstream G cuts over.
- Accessors: `trainingStateOf` / `withTrainingState` in `src/sim/training/state.ts`.
- Optional in Phase 0; workstream L makes it required and migrates saves.

## File ownership (workstreams A–L)

| Stream | Owns |
| --- | --- |
| **A** | `scaling.ts`, `compute.ts`, `forecast.ts`, `outcome.ts` |
| **B** | `dataBridge.ts`, `src/sim/systems/data.ts`, `src/sim/balance/effectiveData.ts`, `syntheticGeneration.ts` |
| **C** | `postTrain.ts`, gyms |
| **D** | `evaluate.ts` |
| **E** | `modifiers.ts`, `src/sim/balance/research.ts`, `src/sim/systems/research.ts`, `researchPrograms.ts`, ResearchPanel chips |
| **F** | `run.ts`, `checkpoints.ts`, `distill.ts`, `continue.ts`, `merge.ts`, `rivals.ts`, `tickTrainingCore.ts` |
| **G** | `endpoints.ts`, `src/sim/systems/market.ts` adapter, plans |
| **H** | ModelsPanel shell / board / inspector, `viewModels/selectors.ts` |
| **I** | Design / post-train / distill / eval / release / router / sunset / merge dialogs |
| **J** | Fleet and gyms boards |
| **K** | Activity bar, objectives, celebration, Benchmarks panel, progression, victory |
| **L** | Store state, save, `createGame` |

Tick order (wired in `src/sim/tick.ts`): `tickGyms → tickRecipes → tickRivalTraining → tickRuns → tickEvals → tickSeasons → tickEndpoints` via `tickTrainingCore`. Legacy `tickTraining`, `tickCheckpointEvaluations`, `tickPostTrainGyms`, and rival `trainingJob` loops are disabled.

## Save policy

Target `SAVE_VERSION = 15`. Older saves are **rejected** with reason code `incompatible-training-overhaul`. Workstream L implements the bump in `src/sim/save.ts`; Phase 0 only documents it. Current tree remains version 14 until L lands.

Constants live in `src/sim/training/constants.ts` (`TRAINING_V4`, `CALIBRATION_BANDS`). Implementers must not hard-code these numbers elsewhere.
