# Training Campaigns v2

Status: first playable vertical slice implemented. This document separates
research-backed mechanics from deliberate Labline game rules.

## Design goal

Training should play like running a risky scientific and commercial program,
not waiting for a progress bar. Parameters, architecture, compute, data,
research, staff, evaluation, and serving economics establish a forecast. The
player then spends time, money, and evidence to manage uncertainty while a
seeded latent outcome stays fixed.

The core loop is:

1. Form a product and capability hypothesis.
2. Assemble an inspectable corpus and reserve uncontaminated holdouts.
3. Run proxy experiments to narrow transfer and stability uncertainty.
4. Commit a full-scale training campaign.
5. Respond to explainable checkpoint events.
6. Select a checkpoint, post-train it, and evaluate it.
7. Release, retain as a teacher, distil, or continue into a new immutable version.
8. Convert real product usage and verified experiments into the next data version.

## Research basis

The simulation should preserve these real relationships:

- Compute, parameters, and training tokens are coupled. Dense Transformer
  training is commonly approximated as `C ≈ 6ND`; balanced parameter/data
  scaling and diminishing returns are supported by Chinchilla.
  <https://arxiv.org/abs/2203.15556>
- Data repetition can remain useful for several epochs, but its marginal value
  eventually falls toward zero. <https://arxiv.org/abs/2305.16264>
- Domain mixtures are a trainable design choice. Proxy-model mixture selection
  can improve quality or reduce required steps. <https://arxiv.org/abs/2305.10429>
- Deduplication, filtering, source selection, and contamination control change
  both learning efficiency and evaluation credibility.
  <https://arxiv.org/abs/2107.06499>
- Large runs experience many recoverable infrastructure incidents, so
  observability, checkpoints, spare capacity, and recovery automation matter.
  <https://arxiv.org/abs/2407.21783>
- SFT and preference optimization change product behavior independently of raw
  pretraining scale. <https://arxiv.org/abs/2203.02155>
- Direct preference optimization is simpler than an online reward-model/RL
  loop, while either path can over-optimize a proxy.
  <https://arxiv.org/abs/2305.18290>
- Verifiable-reward RL can elicit reasoning, but pure RL can harm readability
  and behavior; cold-start data and staged training matter.
  <https://arxiv.org/abs/2501.12948>
- Recursive synthetic replacement can narrow or collapse distribution tails.
  Real/human anchors and independent verification remain valuable.
  <https://www.nature.com/articles/s41586-024-07566-y>
- MoE increases stored capacity relative to active per-token compute, but all
  experts require memory and routing, load balance, communication, and expert
  parallelism are real constraints. <https://www.jmlr.org/papers/v23/21-0998.html>
- Tool use and agents can raise task success beyond the unaided model, but long
  action chains multiply failure probability and output-token cost.
  <https://arxiv.org/abs/2302.04761>

## Explicit game abstractions

These rules create strategy; they are not claims of settled science:

- Every fixed blueprint/version has a hard capability frontier.
- Dense has a base blueprint cap of 82, MoE 89, specialist media 90, and omni 94.
- Distillation can transfer part of a stronger teacher beyond a student's
  pretraining wall.
- Only omni can bank verified Closed-Loop Autonomous Research gains, raising
  its current blueprint wall from 94 toward a bounded ceiling of 97.
- Omni exclusivity represents the game's late-stage world-observation fantasy,
  not proof that text or MoE systems cannot participate in real AI research.

The UI and research descriptions must label these as blueprint simulation
rules, and must show the associated costs rather than presenting them as free
intelligence bonuses.

## Architecture strategy

### Dense

Strengths: predictable optimization, every parameter trained on every token,
good small/medium-scale economics, mature batching and quantization.

Costs: every parameter is active for every token; capacity and inference cost
rise together; repeated data and extra compute cannot cross the fixed blueprint
wall. Distillation or a new blueprint is required.

Campaign events: loss spikes, data anomalies, hardware faults, and mixture
discoveries. Dense should have the narrowest outcome variance when recipes are
mature.

### Mixture of experts

Strengths: higher total learned capacity per active-token FLOP, broad knowledge,
and domain expert specialization.

Costs: total weights must remain resident, interconnect traffic is high, small
batches underutilize experts, and routing can produce dead or overloaded experts.

Campaign events: routing imbalance, expert collapse, overflow tokens, and
specialization discoveries. Routing and load-balance research should reduce
downside frequency rather than passively granting only capability.

### Native omni

Strengths: shared cross-modal grounding, end-to-end audio/media interaction,
unified agents, widest data frontier, and eligibility for the speculative
closed-loop endgame.

Costs: 1.8x data-breadth target, 1.75x frontier output-token burden, paired
modality scarcity, modality interference, large evaluation matrix, and poor
initial serving margins for agent/media-heavy traffic.

Omni data needs a bridge graph, not only more independent stocks:

- text ↔ image
- text ↔ audio
- text ↔ video
- audio ↔ video
- instruction ↔ action
- observation ↔ outcome

Missing bridges create modality islands: good isolated scores but weak
cross-modal reasoning and poor end-to-end reliability.

## Bounded RNG

Every campaign receives a deterministic seed. The seed never changes when the
player benchmarks, reloads, pauses, or runs a pilot. Player-controlled risk
changes the probability and severity distribution around that seed.

Events should be explainable:

- Loss spike: recipe risk, numerical format, untested scale, and stability research.
- Bad shard: source provenance, duplication, contamination, and ingestion QA.
- Hardware fault: cluster size, duration, checkpoint cadence, and spare capacity.
- MoE routing imbalance: active fraction, routing maturity, load balance, and fabric.
- Omni modality interference: modality mix and aligned bridge data.
- Mixture discovery: uncertainty remaining after proxy experiments.
- Reward hacking: policy pressure relative to independent evaluator strength.
- Synthetic narrowing: synthetic share, generation depth, verifier diversity,
  and real-data anchor.

Most incidents preserve a checkpoint and offer three choices: a slower safe
response, an expensive evidence response, and a risky high-upside response.
Ignoring a decision for five days applies the safest qualified response so the
simulation cannot deadlock.

## Stealth checkpoint programme

Reached campaign milestones produce immutable checkpoint candidates without
ending the source training run. A candidate is initially isolated from the
commercial fleet: it has no customers, revenue, market-share effect, brand
effect, public leaderboard entry, or teacher/data-generation privileges.

The player can use the candidate in three increasingly realistic evaluation
environments:

1. **Internal lab** — fastest, cheapest and confidential. Automated suites and
   employee reviewers provide directional evidence, but correlated tools and
   benchmark familiarity leave wider intervals.
2. **Blind NDA panel** — independent domain reviewers, hidden prompt sets and
   stronger adjudication. Costs more and takes longer; reviewer disagreement is
   visible and there is a small chance that the existence of the checkpoint
   leaks.
3. **Partner pilot** — real workflows, latency, reliability and integration
   feedback from a limited early-access cohort. This provides the strongest
   product evidence and the highest confidentiality risk; it is still not a
   public product launch.

Every report belongs to one concrete checkpoint, model version and benchmark
season. It retains selected product-eligible suites, spend, duration,
measurement accuracy, confidence intervals, contamination flags, comparison
against public rivals, reviewer focus/bias/disagreement, strengths, risks and
the final recommendation. Image, video and audio checkpoints never receive
irrelevant language-only panels merely to fill a table.

Repeated reports are retained rather than allowing the player to hide an
unfavourable sample. More spending narrows uncertainty around the same fixed
checkpoint; it never changes the underlying capability or rerolls the training
outcome. An external leak can create a rumour but never creates customers or
revenue by itself.

From the checkpoint record the player may:

- Keep it in stealth and order more evidence.
- Promote it to a retained internal model, enabling distillation, continuation
  and synthetic-data work while leaving the source campaign running.
- Release a retained internal model publicly through the normal pricing,
  capacity and launch-review flow.
- Discard the candidate while preserving its audit history.

The UI must never expose the simulator's latent capability or benchmark vector
for a stealth checkpoint. Before evaluation it shows unknown values; afterward
it shows only measured estimates, ranges and reviewer evidence.

## Data system

Raw quantity and one blended quality score are insufficient. A manifest must
retain the following weighted properties of the exact attributed assets:

- Unique and repeated volume
- Domain and modality mixture
- Intrinsic quality
- Diversity and tail coverage
- Freshness
- Contamination risk
- Source and rights exposure
- Synthetic share and generation depth
- Human/real anchor share
- Effective training value

The first slice now makes those properties change effective training data and
risk. A requested recipe cannot claim more unique data than its attributed
assets contain.

Next data work:

1. Add physical media units alongside token equivalents: images, audio hours,
   video hours/frames, and agent trajectories.
2. Add alignment quality for captions, transcripts, temporal segments, tool
   schemas, and observation/outcome pairs.
3. Replace a single cleaning control with versioned pipelines: language/content
   filters, exact/semantic dedup, quality classifier, PII/rights audit, alignment
   relabeling, and contamination holdout.
4. Add proxy ablations that compare two dataset versions before full training.
5. Make training read-only over reusable corpus assets; repetition is tracked
   per campaign and discounted rather than deleting the data.
6. Stop zero-compute synthetic autofill. Generated data must come from an
   explicit teacher/agent job that spends inference/research compute and records
   lineage.
7. Make qualified model and product outcomes—not raw model count—advance media
   data and modality maturity.

## Post-training campaigns

Each stage needs its own corpus and choices:

- SFT: demonstrations, instruction coverage, formatting, refusal balance.
- DPO/RLHF: preference pairs, labeler quality, reward uncertainty, KL pressure.
- Process/RLVR: step traces, executable environments, verifier coverage, rollout budget.
- Tools/agents: successful and failed trajectories, schema diversity, retries,
  long-horizon reliability, sandbox and observation quality.

Effects must be proportional to funded PF, calendar time, relevant data,
research, and completed effectiveness. Selecting a label grants nothing. A
checkpoint with an active unfinished stage cannot be finalized until that stage
is complete or a future explicit abort-and-rollback action is used.

## Closed-Loop Autonomous Research

Unlock requirements are intentionally late and expensive: omni, autonomous
red-teaming, self-training, tool agents, compute-optimal schedules, fused serving
kernels, 32 researchers, and a long high-risk research program.

Unlocking grants no passive capability. During eligible omni campaigns, agent
teams can propose improvements. The player may:

- Independently verify: separate proposing/judging teams, hidden tests, fresh
  observations, replication, large cash bill, and 12% extra campaign compute.
- Recurse rapidly: reuse agents as judges, lower cost, 7.5% extra compute,
  higher reward-hacking/collapse risk.
- Reject proposals: preserve the real-data anchor and bank no gain.

Outcomes include verified incremental gain, breakthrough, null result, false
discovery, reward hacking, synthetic narrowing, and operational failure. Only
verified gains raise the omni blueprint cap, each immutable model version banks
its own cumulative gain, and the bonus is bounded at +3.

## Evaluation

Benchmark spend buys sample size, judge redundancy, hidden-set coverage, and
contamination auditing. It narrows a confidence interval; it never improves the
model directly. Product-aware suites and the existing $50k–$150k per-suite
range remain appropriate.

Campaign events now snapshot paid-benchmark accuracy as evidence without
rerolling the seeded event. Better evidence improves the funded intervention's
reliability/risk adjustment rather than the model itself. Proxy pilots still
need to narrow this same latent forecast in the next slice.

## Delivery phases

### Phase 1 — implemented in this slice

- Architecture blueprint profiles and hard pretraining walls
- Architecture-adjusted data coverage: equal raw corpora provide less effective
  coverage to MoE and substantially less to omni
- Distillation evaluated after the blueprint wall
- Omni-only bounded verified-recursion headroom
- Omni output-token burden feeds the existing serving/decode economics
- Detailed dense/MoE/omni research trade-offs
- Late Closed-Loop Autonomous Research unlock with no passive gain
- Pod research uses real staff, PF, cash, prerequisites, exclusivity, and
  minimum calendar time; legacy and pod systems cannot progress simultaneously
- Manifest-level diversity, freshness, contamination, provenance, rights, and
  effective-value accounting
- Trillion-scale base training has a real 100–150 active-day throughput floor:
  parameter scale and the frozen train/verification corpus each contribute to
  the duration, excess PF cannot bypass the data/optimizer pipeline, and player
  and rival jobs use the same pacing rule. Sub-trillion PF pacing is unchanged.
- Four seeded training checkpoints with explainable architecture/data/ops events
- Three player interventions per event, cash/compute/rollback effects, and
  five-day safe auto-resolution
- Visible campaign event/log and blueprint frontier on the training card
- Campaign decisions affect final capability, reliability, safety, data quality,
  terminal stumble/breakthrough odds, and verified omni headroom
- Paid benchmark accuracy is frozen as event evidence and cannot reroll RNG
- Zero-work Tools/Process stage bonuses removed; unfinished stages block finalization

### Phase 2 — next

- Route the model wizard through the existing `TrainingProgram` brief
- Make selected research methods and exact manifests authoritative before the
  underlying training job starts
- Add product objective, segment targets, pod assignments, proxy pilots, and
  forecast confidence bands to the UI
- Make proxy-pilot evidence narrow the same seeded forecast as paid benchmarks
- Add explicit checkpoint rollback selection and best-checkpoint release

### Phase 3

- Dedicated post-training corpora and recipes
- DPO versus RLHF versus RLVR trade-offs
- Reward-hacking, style regression, and long-agent-trajectory events
- Distillation campaigns optimized against lifetime serving volume
- Separate agent, media, input, and output token-equivalent economics

### Phase 4

- Player/rival parity through one pure campaign transition/build path
- Rival pilots, interventions, post-training, continuation, distillation, and
  immutable method/manifest snapshots
- Hosting profitability gates for omni recursive programs
- Demand feedback from blind evaluations, reliability, latency, and real-world reviews

### Phase 5

- Versioned data pipelines and physical media units
- Contracted/licensed/owned rights consequences
- Contamination scandals and benchmark refreshes
- Qualified production-data flywheel and model-generated lineage audits

## Required regression coverage

- Same seed and inputs produce the same event sequence.
- Every milestone is emitted once, including large one-day progress jumps.
- Paid choices charge the finance ledger exactly once.
- Insufficient cash or researchers blocks the choice without mutation.
- Auto-resolution cannot deadlock and chooses a qualified safe option.
- Selecting a post-training stage with zero work grants no stage benefit.
- Partial stage effectiveness is monotonic and save-stable.
- Dense/MoE/omni walls bind before distillation; only verified omni gains move a wall.
- Recursive gain persists through an omni continuation and cannot affect dense/MoE.
- Requested data volume cannot exceed manifest-attributed unique/repeated evidence.
- Player/rival identical campaigns eventually produce identical physical work,
  baseline capability, and seeded outcomes.
