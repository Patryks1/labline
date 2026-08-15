# Hall Operations v2

## Product goal

Turn the data-hall editor from a visual capacity screen into an operating-system game for physical compute. Two halls containing the same racks must produce meaningfully different usable compute, operating cost, deployment time, failure exposure, and expansion flexibility because of their layouts.

The recurring player loop is:

```text
plan -> validate -> fund -> build -> cable -> commission -> operate
     -> inspect bottlenecks -> maintain/upgrade -> standardize and repeat
```

Every required object or editing action must affect at least one of: deployable compute, capex, delivery/build time, opex, energy efficiency, resilience, repair time, security, or expandability. Pure decoration stays optional.

## Research synthesis

The design deliberately combines a small number of proven patterns rather than copying one game.

- **Software Inc.** makes construction consequential through topology, staff routes, local environmental effects, utilities, degradation, maintenance, failures, and reusable blueprints. Its room-level then local pathfinding is a good performance model for Labline. Sources: [official site](https://swinc.net/), [developer building-system article](https://www.moddb.com/games/software-inc/news/building-mechanic-replaced), [developer pathfinding article](https://softwareinc.coredumping.com/pathfinding/), [official furniture schema](https://softwareinc.coredumping.com/wiki/index.php/Furniture_Modding), [official temperature update](https://store.steampowered.com/news/posts/?appids=362620&enddate=1615201736&feed=steam_community_announcements).
- **The Sims 4** supplies forgiving authoring: safe experiments, whole-room manipulation, grid/top-down modes, undo/redo, catalogues, and saved rooms. Automatic structures should remain previews because EA found automatically placed doors produced poor results. Sources: [EA design article](https://www.ea.com/news/see-early-concept-art-from-the-sims-4), [official manual](https://eaassets-a.akamaihd.net/eahelp/manuals/the-sims-4-ps4-na.pdf).
- **Factorio** separates ghosts from constructed entities, makes utility shortfalls visibly throttle consumers, and exposes production/satisfaction/storage history and largest consumers. Its reusable rotate/mirror/upgrade blueprints are the right answer to hyperscale repetition. Sources: [blueprints](https://wiki.factorio.com/Blueprint), [electric system](https://wiki.factorio.com/Electric_system), [official undo/redo design](https://www.factorio.com/blog/post/fff-412).
- **Prison Architect and Project Hospital** separate planning, construction, zoning, object requirements, staffing, logistics, and commissioning-style validity. They distinguish a missing mandatory dependency from a merely inefficient design. Sources: [Prison Architect planning](https://prison-architect.fandom.com/wiki/Alpha_8), [utilities](https://prison-architect.fandom.com/wiki/Utilities), [Project Hospital developer site](https://oxymoron.games/), [official workload update](https://store.steampowered.com/news/posts/?appids=868360&enddate=1559917122).
- **Two Point** demonstrates a useful inspector/queue loop, while its additive prestige behavior is a warning against catalogs of repeated generic bonus items. Source: [official Two Point Hospital page](https://www.twopointstudios.com/en/games/two-point-hospital).
- **Dwarf Fortress** suggests soft route priorities, coverage, and conditional work orders without simulating each technician's every step. Sources: [traffic](https://www.dwarffortresswiki.org/index.php/Traffic), [work orders](https://dwarffortresswiki.org/index.php/Work_orders).

## Existing foundation and diagnosed gaps

Labline already has a useful base: three physical shells on a 250 mm grid, priced rack/power/cooling/network footprints, walls and doors, transactional drafts, revision checks, undo/redo, a searchable inventory, auto-layout previews, a Three.js scene, persisted layouts, and downstream hooks from operational rack IDs into compute and PUE.

The current rules nevertheless erase most player agency:

1. Opening or loading a hall can freely repair it, place staged racks, and add utilities.
2. Applying a manual draft and automatic delivery placement can silently buy or add missing utilities.
3. Interior work becomes live immediately after payment.
4. Power and network routes are decorative Manhattan lines that cross walls and equipment; cooling is a global pool.
5. The resilience strategy has no independent paths or failure-domain benefit.
6. A disconnected-rack fallback can resurrect offline racks at 55% compute, disagreeing with stricter compute consumers.
7. Incident risk is calculated but not consumed, and infrastructure carries little layout-specific recurring cost.
8. Walls are rendered but not normally selectable, so the door workflow is effectively unreachable.

## Authoritative model

`DataHallLayout` becomes the single authority for physical hall operation. The older row/bay projection remains compatibility data until a later migration removes it.

### Geometry layer

- Shell bounds and exterior loading/service entrance.
- Object footprints and orientation.
- Wall edges, door openings, collision, front/rear service faces, and aisle clearance.
- Flood-fill/BFS walkability from the exterior entrance.
- Hard blockers for overlap, invalid shell placement, blocked doors, unreachable mandatory service faces, and impossible utility paths.

### Utility graphs

The implementation uses a local grid now and leaves a coarse room graph as a later scale optimization.

- **Power:** capacity, route length, load, headroom, alternate source availability.
- **Cooling:** local reach/route, heat load, headroom, airflow and hot/cold aisle quality.
- **Network:** capacity, route length, load, headroom, alternate fabric availability.
- Walls block graph edges unless a door opens the crossing. Equipment blocks walk cells. Routes terminate at reachable object perimeters rather than teleporting between object centers.

A delivered rack is operational only when mandatory power, cooling, network, and service access exist. Saturation and poor environment cause explainable proportional throttling; a missing mandatory connection is a hard zero.

### Operational summary

Cached analysis contains:

- online/offline rack unit IDs and per-network routes;
- power, cooling, and network utilization/headroom;
- access/maintainability, airflow, aisle, cooling, and redundancy scores;
- effective throughput and PUE multipliers;
- incident-risk multiplier, single points of failure, bottlenecks, and unreachable objects;
- projected infrastructure opex.

Compute, hosting, training, and UI must consume the same operational rack set. There is no disconnected-capacity fallback.

## Construction and commissioning

Applying a plan is a schedule operation, not an instant mutation.

1. Validate geometry and quote all deltas.
2. Reserve/deduct capex and place rack purchase orders.
3. Persist the target as a ghost construction project while the live layout remains authoritative.
4. Advance through build, cabling, and commissioning over 3–14 simulation days based on scope.
5. Atomically replace the live layout only after commissioning, then recalculate operations.

Only one project may modify a hall at a time in v2. A later version can support independent work zones and maintenance windows. Delivered auto-placement may schedule an installation project or leave inventory visibly staged; it must never create free infrastructure or spend cash invisibly.

Infrastructure has recurring operations and maintenance expense derived from commissioned asset value/type. The first v2 pass keeps failures conservative; later causal incidents use utilization, redundancy, access, and condition rather than opaque global RNG.

## Editor information architecture

Keep the existing 3D editor and progressively extract its scene, inspector, and timeline rather than rewriting it.

### Modes and overlays

- **Overview:** online capacity, effective PF, PUE, cost, time, blockers.
- **Power:** routes, utilization, headroom, unpowered racks, single points of failure.
- **Cooling:** cooling routes/coverage, heat load, hot spots, aisle/airflow loss.
- **Network:** routes, saturation, disconnected racks, redundant fabrics.
- **Access:** exterior reachability, service faces, blocked/narrow aisles.
- **Risk:** redundancy, overload, maintainability, projected incident exposure.
- **Construction:** live versus ghost target, stage, days remaining, committed cost.

Warnings must quantify consequence and identify the affected asset. Placement previews should state the exact invalid reason and forecast capex, opex, commissioning time, throughput, PUE, and risk deltas.

### Forgiving authoring

- Retain click/drag placement, rotation, search, undo/redo, and explicit auto-layout previews.
- Make walls and routes selectable; a selected wall can accept a door.
- Confirm closing a dirty plan and confirm any future live modification that causes projected downtime.
- Add responsive and keyboard-accessible controls alongside the WebGL view.
- Follow with box-select, copy/mirror rack rows, saved pods, whole-hall blueprints, and upgrade variants.

## Delivery phases

### P0 — Hall Operations v2 vertical slice

- [x] Versioned backward-compatible analysis/project normalization.
- [x] Obstacle- and door-aware service and utility routing.
- [x] Local cooling, mandatory three-network service, headroom, bottlenecks, and redundancy.
- [x] One canonical operational rack set and removal of offline-compute fallbacks.
- [x] Paid 3–14 day build/cable/commission lifecycle with ghost targets.
- [x] No free recurring repair or invisible utility purchase.
- [x] Commissioned-infrastructure opex.
- [x] Overview/power/cooling/network/access/risk/construction overlays.
- [x] Live-versus-plan inspector, construction timeline, wall selection, and dirty-close protection.
- [x] Scenario, save, store, compute parity, UI model, build, lint, long-horizon, and rendered responsive verification.

### P1 — operations and reliability

- Equipment condition, preventive-maintenance coverage, repair backlog, and spares.
- Causal breaker, cooling, leak, and fabric incidents with visible origin and recovery.
- N, N+1, and 2N policies; A/B feeds and independent fault domains.
- Live work zones, maintenance windows, and temporary capacity loss.
- Fire detection, compartmentation, and clean-agent suppression.
- Facility crew pools without individual-person micromanagement.

### P2 — hyperscale authoring

- Box selection; copy, mirror, replace, and decommission batches.
- Saved rack-row/pod/hall blueprints with reusable inventory and upgrade variants.
- Room/zone roles for white space, electrical, cooling plant, network, staging, and service.
- Multi-floor/building links, generators/fuel/black start, water and carbon trade-offs.
- Time-series network inspectors and largest-consumer views.

## Migration and compatibility

- Persist route cells only as recomputable caches; save targets and lifecycle state.
- Normalize missing v2 analysis values rather than treating them as trusted save data.
- Grandfather existing live placements once. Do not run a value-generating “repair” every time a save or editor opens.
- Preserve paid rack ownership and stable rack unit IDs.
- Keep rivals functional through explicit controller automation using the same costs, timing, and physical rules; automation is not a player-facing silent mutation.

## Acceptance scenarios

1. A wall without a door blocks service and utility routes; adding a door restores only the routes that can physically reach it.
2. A remote rack outside local cooling reach is offline or throttled with an exact cooling warning despite surplus cooling elsewhere.
3. A dense single-source hall is cheaper but has worse access, airflow, PUE, and redundancy than a resilient hall with the same racks.
4. Removing one redundant source does not drop protected racks; removing the only source does.
5. Paying for a project does not add compute until its commissioning day, and save/load preserves progress.
6. Staged delivered racks never become powered through free or invisible equipment.
7. All compute consumers agree on the same offline rack set.
8. Equipment capex creates visible daily opex and affects profitability.
9. A user can select a wall, add a door, inspect each network, understand blockers, and safely discard or apply a draft.
10. Compact, long-horizon, rival-parity, and play simulations remain viable after migration.

## Explicit non-goals for the first patch

- Individual technician path/needs simulation.
- Manually drawing every cable, pipe, or conductor.
- Decorative prestige items with generic percentage bonuses.
- Multiple simultaneous construction work zones.
- Multi-storey free-form building construction.
- Catastrophic random failures without warnings and counterplay.
