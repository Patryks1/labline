# Labline model economy and company-state contract

This document is the living calibration contract for Labline’s model loop. It is
not a placeholder. Publisher payloads, noop stubs and temporary workflows are
forbidden in this repository.

## Player loop

Research → choose model purpose → architecture and size → data recipe → compute
and training precision → train → evaluate → post-train / Cyber Gym / distil →
prepare serving → set price and launch → compete, gather data and improve.

Every choice must affect at least one of: model quality, training cost,
training duration, failure risk, inference speed, inference cost, addressable
demand, reputation, or future research/data.

## Canonical company state

Save schema version 14 stores one company record per lab, including the player.

- UI reads the player through `selectPlayerCompany(state)`.
- Simulation writes take a `companyId`, never a duplicate player object.
- Models, training jobs and deployments are stored once and referenced by ID.
- `state.player`, `state.rivals` and `state.labs` are read-only compatibility
  projections during Stage A, then removed in Stage B.
- Saves remain plain JSON. No classes, Maps, Sets, functions or cycles.

## Frozen training plans

A training run copies a `TrainingPlan` at start and never reconstructs it from
live company state. Later research, hardware or teacher deletion cannot silently
rewrite an in-flight job. Preview and finalisation call the same pure functions.

## Physical compute

Dense pre-training work is `6 × parameters × training tokens`. Held-out
verification is `2 × parameters × verification tokens`. MoE compute uses the
active path plus routing overhead; total parameters still determine memory.

```text
effective PF/day =
  raw hardware PF/day
  × utilisation
  × numerical-format throughput
  × interconnect efficiency
  × training research efficiency
  × power availability

duration = max(required PF-days / effective PF per day, minimum integration days)
```

Precision changes throughput and memory. It does not reduce theoretical
learning work twice. One job must fit in one placement domain; unrelated local
and cloud HBM is never summed.

## Effective data

Raw tokens are not useful signal. Domain effective tokens apply quality,
diversity, freshness, provenance, contamination, repetition and synthetic
lineage. Repeated epochs follow a diminishing multiplier such as
`1 + 0.55 × log2(epochs)`. Synthetic depth gradually reduces unverified value.

Reference bands, shown as ranges:

- minimum viable: under-trained but potentially useful
- strong recipe: the main gameplay target
- compute-optimal: expensive frontier comparison (~20 tokens/parameter)

## Capability

Headline capability does not win every market. Domain scores (language,
reasoning, code, math, science, vision, video, audio, tools, plus factuality,
reliability, robustness, safety and steerability) drive demand.

Each architecture and scale has a strict general ceiling. A model may exceed
that ceiling in one or two specialist domains. Research improves efficiency,
data extraction, architecture unlocks or limited headroom. It does not add
unlimited points. Stacked efficiency uses
`1 - product(1 - individual improvement)`.

Initial general-capability calibration bands (game targets, not benchmark
claims):

| Scale | Band |
| ---: | ---: |
| 70M | 7–15 |
| 400M | 12–23 |
| 1B | 18–32 |
| 7B | 34–55 |
| 70B | 55–76 |
| 400B | 72–89 |
| 1T+ | 82–96 |

## Distillation, evaluation and serving

One distillation function serves forecast and finalisation. Teacher general
capability cannot copy past the student architecture ceiling. Domain knowledge
can transfer more than unrestricted general intelligence.

Evaluations cost cash and compute, return uncertainty ranges and do not mutate
the underlying checkpoint. Post-training (SFT → preference → process → tools)
and Cyber Gym concentrate on steerability, tools, safety, coding/agents and
reliability. Cyber Gym must not raise MMLU/general, vision, audio or video.

Serving is a deployment artifact. Inference work uses active parameters;
resident memory uses total parameters. API list prices cannot fall below the
canonical hosting-cost floor. Training spend belongs in payback, not token COGS.
Promotions are credits, not below-cost list prices.

## Market, routers and rivals

Segment utility is task/reliability/safety/latency/availability/brand fit
divided by price pressure. A 7B coding specialist can beat a 70B generalist in
coding demand and still lose consumer, enterprise, legal, healthcare and
multimodal demand. Routers combine cheap defaults with specialists; they cannot
invent a missing capability.

Rivals call the same physical and economic functions. Difficulty changes
planning accuracy and risk tolerance, not free compute or cheaper racks.

## Profitability targets (normal difficulty, initial)

| Metric | Target |
| --- | --- |
| First small-model release | Day 30–90 |
| First positive operating day | Day 90–180 |
| Stable operating profitability | Day 150–300 |
| Small specialist gross margin at healthy utilisation | 30–60% |
| Frontier model initial gross margin | 5–25% |
| Small specialist training payback | 120–360 days |
| Frontier training payback | 360–1,080 days |
| Competent strategy bankruptcy | 5–20% |
| Unplanned/novice bankruptcy | 25–45% |
| Sustained unserved demand after scaling | Under 15% |

## UI

Primary stages are Train, Evaluate, Align and Launch. Advanced mathematics stay
in disclosures. No duplicated metric may show two different values.

## Save migration

v13 player and rivals become `companies[id]`. Model and job arrays become
`*ById` maps plus order arrays. Loading never calls current RNG. The same save
loaded twice is identical.

## Research basis

- Kaplan et al., Scaling Laws for Neural Language Models, arXiv:2001.08361
- Hoffmann et al., Training Compute-Optimal Large Language Models, arXiv:2203.15556
- Fedus, Zoph and Shazeer, Switch Transformers, JMLR 2022
- Dubey et al., The Llama 3 Herd of Models, arXiv:2407.21783
- Abdin et al., Phi-3 Technical Report, arXiv:2404.14219
- DeepSeek-AI, DeepSeek-V3 Technical Report, arXiv:2412.19437
- DeepSeek-AI, DeepSeek-R1, arXiv:2501.12948
- Shumailov et al., AI models collapse when trained on recursively generated data, Nature 2024
