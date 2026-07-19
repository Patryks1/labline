# Labline: Grounded AI Race Tycoon

Desktop-first browser strategy game about building an AI lab from a cloud-funded startup into a decade-scale research and infrastructure company. The deterministic campaign runs from **2026 through 2036**, produces a decade report, and can continue endlessly.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://127.0.0.1:5173`).

```bash
npm test
npm run build
```

## Campaign loop

1. Read compute, power, benchmark, rival, and customer forecasts.
2. Pick a commercial objective and secure cloud capacity, data, a research pod, and financing.
3. Run pilots, train a model, intervene at checkpoints, and post-train it.
4. Release through subscriptions or APIs; independent evaluations and field reviews arrive later.
5. Operate serving capacity, manage latency and reliability, then reinvest in research or physical infrastructure.

A new campaign begins with **$20M cash, $3M cloud credits, a 24 PF cloud contract, two named technical leads, eight supporting staff, and a public foundation dataset**. Five persistent rivals use the same markets and conservation rules.

At 1× speed one game day takes four real seconds. Pause, 2×, 5×, and single-day step are available; major completions, quarterly reports, and runway emergencies can auto-pause.

## Systems

| Area | What it does |
|------|--------------|
| Campaign | Gregorian 2026–2036 calendar, weekly/monthly/quarterly/annual cadence, bounded histories, endless mode |
| Models | Nine domain capabilities, product-quality axes, pilots, checkpoints, immutable manifests, post-training |
| Data | Inspectable assets, rights/provenance, math/science corpora, HQ/LQ synthetic lineages |
| Research | 76 methods grouped into seven branches; named leads, pods, evidence, integration, publishing/licensing |
| Compute | On-demand, reserved, spot, emergency, colocation, resale; conserved training/serving/research allocation |
| Infrastructure | Validated reusable rack blueprints, data centers, hard grid MW, power contracts, regional constraints |
| Market | Nine customer segments, outside options, useful-task utility, switching, bounded 4–12× adoption |
| Evaluation | Internal estimates, seasonal public suites, blind audits, 30-day field reports, quarterly reviews |
| Capital | Exact cap table, equity term sheets, five debt classes, covenants, repayments, restructuring ladder |
| Progression | Frontier and Abundance titles, specialist records, one 2036 report, non-terminal sandbox play |
| Operations | Optional overflow-cloud, allocation, data, fleet, and product-capacity automations with daily budgets |
| World | Ten deterministic three-stage industry event chains; shared grid queues, accelerator supply, and regional power prices |
| Governance | Optional carbon, water, data-rights, regulatory, and safety-audit modules applied symmetrically to every lab |

Save schema **v4** is a clean campaign boundary and pins its industry content pack. V3 live economies are intentionally not converted; valid V3 rack designs can be imported into the profile blueprint library.

Detailed daily finance is retained for 180 days and then deterministically rolled into monthly history. News, market fills, alerts, evaluations, and reviews are capped so decade saves remain compact. Rivals receive delayed public evaluations and reviews, service typed debt, compete for the same contracted compute and interconnection capacity, and pay the same optional governance costs as the player.

Player and rival labs now share the same domain-data processing, training scale, hardware throughput, power throttling, hosted-price, depreciation, contract-cost, and market-settlement paths. Strategy differences come from visible policies—research focus, corpus mix, architecture, pricing, allocation, disclosure, and capital risk—not hidden resource yields. Hosted open-weight endpoints charge their advertised service price; free/local open use is represented by the market outside option.

Recurring traffic, synthetic teachers, and market purchases are merged into inspectable provenance lineages with conserved volume and volume-weighted quality. This keeps dataset assets canonical without allowing daily traffic or repeat purchases to grow saves without bound.

## Verification

```bash
npm test
npm run lint
npm run build
```

The statistical balance gates are opt-in because they simulate hundreds of thousands of game days:

```bash
# 200 seeds × 180 days: early-game rank/solvency band
LABLINE_CALIBRATE=1 LABLINE_CALIBRATION_SEEDS=200 npm test -- --run src/sim/play/calibration.test.ts

# 50 complete 2026–2036 campaigns: primary-title strategy diversity
LABLINE_DECADE_CALIBRATE=1 LABLINE_DECADE_CALIBRATION_SEEDS=50 npm test -- --run src/sim/play/strategyCalibration.test.ts
```

The current calibrated pack passes with zero player bankruptcies in both sweeps. Across the 50 decade seeds, 97 of 100 primary titles resolve and the largest strategy share is 27.8%, below the 65% acceptance ceiling.

## Stack

Vite · React · TypeScript · Three.js · Zustand · Tailwind v4 · GSAP · Vitest

## Layout

```
src/sim/     pure deterministic simulation
src/store/   Zustand actions
src/view/    Three.js map + HUD panels
```

Important simulation boundaries live under `src/sim/systems/`: compute contracts, capital, training programs, research programs, evaluations, progression, dataset assets, and rack blueprints. `src/sim/longHorizon.test.ts` verifies a deterministic, bounded 4,000-day replay.

## Large maps

The compact simulation and viewport renderer support advanced maps up to
1,000 x 1,000 tiles without creating one JavaScript or Three.js object per
cell. See [the architecture, performance budgets, and verification plan](docs/LARGE_MAP_ARCHITECTURE.md).
