# Labline

**Labline is an AI-lab tycoon game inspired by Capitalism Lab and Software Inc.** Build models, compete for compute and customers, ship subscriptions and APIs, and turn a cloud-funded startup into an industry leader.

[Play Labline](https://labline.patryks.me/)

## Overview

Running an AI company is messier than the headlines make it look. Models need data, hardware, power, research, capital, reliable serving, competitive pricing, and customers who may still hate the result. Labline turns those tradeoffs into a strategy game that aims to be fun while teaching players why the AI industry works the way it does.

You compete against five persistent rivals in one shared economy. Everyone fights over the same compute, money, data, talent, infrastructure, and customers—and rivals play by the same rules as the player. Train and post-train models, chase benchmarks, respond to reviews, sell API access or subscriptions, lease spare capacity, research new techniques, and eventually build physical data centers.

Shortcuts can help now and hurt later. A cheaper quant may improve margins but damage quality. A bigger model may win benchmarks but drain cash. Aggressive marketing can buy attention while poor latency and reliability drive users away.

## Run locally

Requires [Bun](https://bun.sh/).

```bash
git clone https://github.com/Patryks1/labline.git
cd labline
bun install
bun run dev
```

Open the local URL printed by Vite. Useful checks:

```bash
bun run test
bun run lint
bun run build
```

## How it was built

The simulation came first. We researched how tycoon games model shared economies, designed formulas for training, serving, pricing, demand, and infrastructure, and made one common ruleset for both the player and rival labs. The map and interface were then built in phases around that foundation.

Labline uses React, TypeScript, Vite, Three.js, Zustand, Tailwind CSS, GSAP, and Vitest. The deterministic simulation lives in `src/sim`, application state in `src/store`, and the Three.js map and HUD in `src/view`.

## Built with Codex

Codex was used as a development partner across research, simulation design, implementation, testing, balancing, and UI iteration. Large idea dumps were split into focused parallel tasks and isolated worktrees, then reviewed and merged one at a time. Image generation and browser annotations helped push the interface from a spreadsheet-like prototype toward a game.

That workflow was especially useful when stitching independently built systems together. Delegating small areas, keeping changes isolated, and validating each merge made a large two-day prototype far more manageable—and changed the process from tackling a few ideas sequentially to exploring many ideas in parallel and keeping the ones that worked.

## What's next

- Fix bugs and polish the UI and onboarding
- Add multiplayer and more rival strategies
- Package Labline as a desktop app
- Deepen training and add more unpredictable events so every run feels different

Labline is still an early, rough build, but it is playable and actively evolving.
