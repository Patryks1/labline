import { useState } from 'react'
import { useGameStore } from '../../../store/gameStore'
import { useUiStore } from '../../../store/uiStore'
import {
  activeCityPowerContracts,
  buyRivalDataCenter,
  cancelCityPowerContract,
  cityDashboard,
  estimateHallSaleValue,
  nearestCity,
  powerBalance,
  powerImportBill,
  rivalHallAskPrice,
  sellPlayerBuilding,
  setHallPowered,
  setPowerExportEnabled,
  signCityPowerContract,
  tileInCityPowerZone,
} from '../../../sim/systems/facilities'
import {
  buildingDisplayName,
  energyPriceForState,
  gridScarcity,
  isDcAnchor,
  isDcKind,
  resolvePlayerPowerMw,
} from '../../../sim/systems/map'
import { computeSnapshot } from '../../../sim/tick'
import { money, mw, num } from '../format'
import { BuildingNameField } from '../ui/BuildingNameField'
import {
  facilityAnchorTiles,
  mapTileAtAny,
} from '../../../sim/systems/worldAccess'

/**
 * Fleet → Power: city stats, export surplus, power-down / sell halls, buy rivals.
 */
export function PowerPanel() {
  const state = useGameStore((s) => s.state)
  const selected = useGameStore((s) => s.selectedTile)
  const setState = (next: typeof state) => useGameStore.setState({ state: next })
  const requestConfirm = useUiStore((s) => s.requestConfirm)
  const bal = powerBalance(state)
  const grid = gridScarcity(state)
  const cities = cityDashboard(state)
  const wholesale = energyPriceForState(state)
  const exportOn = state.player.powerExportEnabled !== false
  const contracts = activeCityPowerContracts(state)
  const snap = computeSnapshot(state)
  const power = resolvePlayerPowerMw(state, snap.mwDemand)
  const bill = powerImportBill(state, power.mwGridImport)

  const [contractMw, setContractMw] = useState(8)
  const [contractTerm, setContractTerm] = useState(60)

  const tile = selected ? mapTileAtAny(state, selected.x, selected.y) : undefined
  const cityAtSel = tile ? tileInCityPowerZone(state, tile.x, tile.y) : null
  const near = tile ? nearestCity(state, tile.x, tile.y) : null

  const dcFacilities = [
    ...facilityAnchorTiles(state, { kind: 'dc' }),
    ...facilityAnchorTiles(state, { kind: 'dc_m' }),
    ...facilityAnchorTiles(state, { kind: 'dc_l' }),
  ]
  const forSale = dcFacilities.filter(
    (t) =>
      isDcKind(t.kind) &&
      isDcAnchor(t) &&
      t.owner !== 'player' &&
      t.owner !== 'neutral' &&
      t.buildingProgress >= t.buildingTarget &&
      (t.forSale || true),
  )

  return (
    <div className="space-y-3">
      <div>
        <h2 className="hud-panel-title">Power & campuses</h2>
        <p className="hud-panel-sub">
          City power zones, export surplus, power-down halls, sell or buy data centers.
        </p>
      </div>

      {/* Balance */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
        <Mini label="Demand" value={mw(bal.demandMw)} />
        <Mini label="Generation" value={mw(bal.genMw)} accent="text-mint" />
        <Mini
          label="Grid import"
          value={mw(bal.gridImportMw)}
          accent={bal.deficitMw > 0.1 ? 'text-amber' : 'text-bone'}
        />
        <Mini
          label="Gen upkeep / day"
          value={money(bal.generationCostDay)}
          accent="text-amber"
        />
        <Mini
          label="Export rev / day"
          value={money(bal.exportRevenueDay)}
          accent="text-mint"
        />
      </div>

      <div className="rounded-xl border border-line bg-panel-2 p-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[0.8125rem] font-medium text-bone">Sell surplus power</div>
            <p className="text-[0.75rem] text-muted">
              Over-gen sells first to cities in your power zone (
              {money(bal.cityBuyPerMWh)}/MWh), rest to wholesale grid (
              {money(bal.wholesalePerMWh * 0.55)}/MWh).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setState(setPowerExportEnabled(state, !exportOn))}
            className={`shrink-0 rounded-full px-2.5 py-1 text-[0.75rem] font-medium ${
              exportOn
                ? 'bg-mint/20 text-mint ring-1 ring-mint/30'
                : 'bg-void text-muted'
            }`}
          >
            {exportOn ? 'Export ON' : 'Export OFF'}
          </button>
        </div>
        <div className="font-mono text-[0.75rem] text-muted">
          Surplus {mw(bal.surplusMw)} · exporting {mw(bal.exportMw)} · wholesale{' '}
          {money(wholesale)}/MWh · grid DCs {grid.industryDcCount}/{grid.softCap}
        </div>
        <div className="font-mono text-[0.75rem] text-muted">
          Power in: gen {mw(bal.genMw)} · import {mw(bal.gridImportMw)} · demand {mw(bal.demandMw)}
          {bal.deficitMw > 0.05 ? (
            <span className="text-amber"> · short {mw(bal.deficitMw)} (brownout)</span>
          ) : null}
        </div>
        <div className="font-mono text-[0.75rem] text-muted">
          Import bill: contract {money(bill.contractCostDay)} ({mw(bill.contractMw)}) · spot{' '}
          {money(bill.spotCostDay)} ({mw(bill.spotMw)})
          {bill.energyContractMw > 0 ? (
            <> · PPA/utility {mw(bill.energyContractMw)} (take-or-pay ledger)</>
          ) : null}
        </div>
        <div className="font-mono text-[0.75rem] text-muted">
          Owned generation upkeep: {money(bal.generationCostDay)} for {mw(bal.generationUsedMw)} ·{' '}
          60% of grid $/MWh plus plant fixed operations
        </div>
      </div>

      {/* City power offtake contracts */}
      <div className="rounded-xl border border-line bg-panel-2 p-2.5 space-y-2">
        <h3 className="text-[0.8125rem] font-semibold text-bone">City power contracts</h3>
        <p className="text-[0.75rem] text-muted">
          Lock firm MW from a metro at a discounted $/MWh for a fixed term. You stay locked until
          expiry (early exit costs ~40% of remaining bill). Build in the city power zone first.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[0.6875rem] text-muted">
            MW
            <input
              type="number"
              min={1}
              max={80}
              step={1}
              value={contractMw}
              onChange={(e) => setContractMw(Math.max(1, Number(e.target.value) || 1))}
              className="mt-0.5 w-full rounded border border-line bg-void px-1.5 py-1 font-mono text-[0.8125rem] text-bone"
            />
          </label>
          <label className="text-[0.6875rem] text-muted">
            Term (days)
            <input
              type="number"
              min={30}
              max={180}
              step={15}
              value={contractTerm}
              onChange={(e) => setContractTerm(Math.max(30, Number(e.target.value) || 30))}
              className="mt-0.5 w-full rounded border border-line bg-void px-1.5 py-1 font-mono text-[0.8125rem] text-bone"
            />
          </label>
        </div>
        {contracts.length > 0 && (
          <div className="space-y-1">
            {contracts.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-mint/25 bg-mint/5 px-2 py-1 font-mono text-[0.75rem]"
              >
                <span className="text-bone">
                  {c.cityName} · {mw(c.mw)} @ {money(c.pricePerMWh)}/MWh · {c.daysLeft}d left
                </span>
                <button
                  type="button"
                  className="text-danger hover:underline"
                  onClick={() => {
                    requestConfirm({
                      title: 'Break the city power contract?',
                      body: `${c.cityName} will stop supplying ${mw(c.mw)} at the locked rate immediately.`,
                      actionLabel: 'Break contract',
                      tone: 'danger',
                      onConfirm: () => setState(cancelCityPowerContract(state, c.id)),
                    })
                  }}
                >
                  Break
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cities */}
      <div>
        <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-bone">Cities</h3>
        <div className="space-y-1.5">
          {cities.length === 0 && (
            <p className="text-[0.8125rem] text-muted">No metro anchors on this map.</p>
          )}
          {cities.map(({ city, distToPlayer, hallsInZone, rivalHallsInZone, genInZone }) => (
            <div
              key={city.id}
              className="rounded-xl border border-line bg-panel-2 px-2.5 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-bone">{city.name}</div>
                  <div className="font-mono text-[0.75rem] text-muted">
                    {city.industry} · pop {num(city.population, 0)}
                  </div>
                </div>
                <div className="text-right font-mono text-[0.75rem] text-muted">
                  zone r{city.powerRadius}
                  {distToPlayer != null && (
                    <div className={distToPlayer <= city.powerRadius ? 'text-mint' : ''}>
                      you @ {distToPlayer} tiles
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1 font-mono text-[0.6875rem] text-muted">
                <span>
                  Offtake {mw(city.powerBuyMw)} · lock ~
                  {money(wholesale * city.powerBuyPriceMult * 0.88)}/MWh
                </span>
                <span className="text-center">
                  Your halls {hallsInZone} · gen {mw(genInZone)}
                </span>
                <span className="text-right">Rival halls {rivalHallsInZone}</span>
              </div>
              <button
                type="button"
                className="mt-1.5 rounded-full bg-mint/15 px-2.5 py-0.5 text-[0.75rem] font-medium text-mint"
                onClick={() =>
                  setState(signCityPowerContract(state, city.id, contractMw, contractTerm))
                }
              >
                Lock {contractMw} MW · {contractTerm}d
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Selected tile actions */}
      {tile && (
        <div className="rounded-xl border border-mint/30 bg-mint/5 p-2.5 space-y-2">
          <div className="text-[0.8125rem] font-medium text-bone">
            <span className="text-muted">Selected · </span>
            {tile.owner === 'player' && isDcKind(tile.kind) ? (
              <span className="inline-block min-w-[8rem] align-middle">
                <BuildingNameField tile={tile} compact />
              </span>
            ) : (
              buildingDisplayName(tile, tile.kind)
            )}
            {tile.owner !== 'player' && tile.owner !== 'neutral'
              ? ` · ${state.rivals.find((r) => r.id === tile.owner)?.name ?? tile.owner}`
              : tile.owner === 'player'
                ? ' · you'
                : ''}
          </div>
          {cityAtSel ? (
            <p className="text-[0.75rem] text-mint">
              Inside {cityAtSel.name} power zone — good offtake for surplus gen.
            </p>
          ) : near ? (
            <p className="text-[0.75rem] text-muted">
              Nearest metro {near.city.name} is {near.dist} tiles (zone r{near.city.powerRadius}).
            </p>
          ) : null}

          {tile.owner === 'player' &&
            isDcKind(tile.kind) &&
            isDcAnchor(tile) &&
            tile.buildingProgress >= tile.buildingTarget && (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className="btn-ghost py-1 text-[0.75rem]"
                onClick={() =>
                  setState(setHallPowered(state, tile.x, tile.y, tile.powered === false))
                }
              >
                {tile.powered === false ? 'Power on' : 'Power down'}
              </button>
              <button
                type="button"
                className="rounded-full bg-danger/15 px-2.5 py-1 text-[0.75rem] text-danger"
                onClick={() => {
                  const v = estimateHallSaleValue(state, tile.x, tile.y)
                  requestConfirm({
                    title: 'Sell this data hall?',
                    body: `Estimated recovery is ${money(v)}. Installed racks are sold with the hall.`,
                    actionLabel: 'Sell hall',
                    tone: 'danger',
                    onConfirm: () => setState(sellPlayerBuilding(state, tile.x, tile.y)),
                  })
                }}
              >
                Sell hall ~{money(estimateHallSaleValue(state, tile.x, tile.y))}
              </button>
            </div>
          )}

          {isDcKind(tile.kind) &&
            isDcAnchor(tile) &&
            tile.owner !== 'player' &&
            tile.owner !== 'neutral' &&
            tile.buildingProgress >= tile.buildingTarget && (
              <button
                type="button"
                className="btn-primary py-1.5 text-[0.8125rem]"
                onClick={() => {
                  const ask = rivalHallAskPrice(state, tile)
                  requestConfirm({
                    title: `Acquire ${tile.name || 'this campus'}?`,
                    body: `The acquisition costs ${money(ask)} and transfers installed racks to your fleet.`,
                    actionLabel: 'Acquire campus',
                    tone: 'neutral',
                    onConfirm: () => setState(buyRivalDataCenter(state, tile.x, tile.y)),
                  })
                }}
              >
                Buy campus {money(rivalHallAskPrice(state, tile))}
                {tile.forSale ? ' · listed' : ''}
              </button>
            )}
        </div>
      )}

      {/* Rival campuses to buy */}
      <div>
        <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-bone">Rival campuses</h3>
        <p className="mb-1 text-[0.75rem] text-muted">
          Select on map or buy from list. Cash-strapped rivals list halls; others still sell at a
          premium.
        </p>
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {forSale.slice(0, 12).map((h) => {
            const rival = state.rivals.find((r) => r.id === h.owner)
            const ask = rivalHallAskPrice(state, h)
            return (
              <div
                key={`${h.x}-${h.y}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 px-2 py-1.5 font-mono text-[0.75rem]"
              >
                <span className="min-w-0 truncate text-bone">
                  {buildingDisplayName(h, 'Hall')} · {rival?.name ?? h.owner} · {h.racksUsed} racks
                  {h.forSale ? ' · LISTED' : ''}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-mint hover:underline"
                  onClick={() => {
                    requestConfirm({
                      title: `Acquire ${buildingDisplayName(h, 'Hall')}?`,
                      body: `The listed acquisition price is ${money(ask)}. Installed racks transfer with the hall.`,
                      actionLabel: 'Acquire hall',
                      tone: 'neutral',
                      onConfirm: () => setState(buyRivalDataCenter(state, h.x, h.y)),
                    })
                  }}
                >
                  {money(ask)}
                </button>
              </div>
            )
          })}
          {forSale.length === 0 && (
            <p className="text-[0.8125rem] text-muted">No rival halls on the map yet.</p>
          )}
        </div>
      </div>
    </div>
  )
}

function Mini({
  label,
  value,
  accent = 'text-bone',
}: {
  label: string
  value: string
  accent?: string
}) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
      <div className="text-[0.6875rem] uppercase text-muted">{label}</div>
      <div className={`font-mono text-xs font-medium ${accent}`}>{value}</div>
    </div>
  )
}
