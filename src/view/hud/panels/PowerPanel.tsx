import { useState } from 'react'
import {
  activeCityPowerContracts,
  activePowerExportContracts,
  cancelCityPowerContract,
  cancelPowerExportContract,
  cityDashboard,
  evaluatePowerExportOffer,
  evaluatePowerImportOffer,
  powerBalance,
  powerExportNegotiationQuote,
  powerImportNegotiationQuote,
  powerImportBill,
  signCityPowerContract,
  signPowerExportContract,
} from '../../../sim/systems/facilities'
import type { SimState } from '../../../sim/types'
import { energyPriceForState, gridScarcity, resolvePlayerPowerMw } from '../../../sim/systems/map'
import { useGameStore } from '../../../store/gameStore'
import { useUiStore } from '../../../store/uiStore'
import { computeSnapshot } from '../../../sim/tick'
import { money, mw } from '../format'

type NegotiationState = {
  mode: 'import' | 'export'
  cityId: string
  offerPrice: number
  counterPrice?: number
  message?: string
}

export function PowerPanel() {
  const state = useGameStore((store) => store.state)
  const requestConfirm = useUiStore((store) => store.requestConfirm)
  const setState = (next: typeof state) => useGameStore.setState({ state: next })
  const balance = powerBalance(state)
  const scarcity = gridScarcity(state)
  const wholesale = energyPriceForState(state)
  const snap = computeSnapshot(state)
  const resolved = resolvePlayerPowerMw(state, snap.mwDemand)
  const bill = powerImportBill(state, resolved.mwGridImport)
  const importContracts = activeCityPowerContracts(state)
  const exportContracts = activePowerExportContracts(state)
  const cities = cityDashboard(state)
  const [contractMw, setContractMw] = useState(8)
  const [contractTerm, setContractTerm] = useState(60)
  const [negotiation, setNegotiation] = useState<NegotiationState | null>(null)

  return (
    <div className="space-y-3">
      <div>
        <h2 className="hud-panel-title">Power</h2>
        <p className="hud-panel-sub">
          Trace every megawatt, lock utility supply, and contract owned surplus without manual export toggles.
        </p>
      </div>

      <PowerFlow balance={balance} bill={bill} />

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Mini label="Demand" value={mw(balance.demandMw)} />
        <Mini label="Locked import" value={mw(bill.contractMw + bill.energyContractMw)} accent="text-mint" />
        <Mini label="Spot import" value={mw(bill.spotMw)} accent={bill.spotMw > 0 ? 'text-amber' : 'text-muted'} />
        <Mini label="Export revenue" value={`${money(balance.exportRevenueDay)}/d`} accent="text-mint" />
      </div>

      <section className="rounded-2xl border border-line bg-panel-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Active commitments</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Firm imports are billed at the locked rate. Exports earn only on surplus delivered.</p>
          </div>
          <span className="font-mono text-[0.6875rem] text-muted">spot {money(wholesale)}/MWh</span>
        </div>
        {importContracts.length === 0 && exportContracts.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-line px-2.5 py-2 text-[0.75rem] text-muted">No active power contracts.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {importContracts.map((contract) => (
              <ContractRow
                key={contract.id}
                direction="Import"
                name={contract.cityName}
                mwValue={contract.mw}
                price={contract.pricePerMWh}
                days={contract.daysLeft}
                onBreak={() => requestConfirm({
                  title: 'Break the utility contract?',
                  body: `${contract.cityName} will stop supplying ${mw(contract.mw)} immediately. The remaining-term fee applies.`,
                  actionLabel: 'Break contract',
                  tone: 'danger',
                  onConfirm: () => setState(cancelCityPowerContract(state, contract.id)),
                })}
              />
            ))}
            {exportContracts.map((contract) => (
              <ContractRow
                key={contract.id}
                direction="Export"
                name={contract.cityName}
                mwValue={contract.mw}
                price={contract.pricePerMWh}
                days={contract.daysLeft}
                onBreak={() => requestConfirm({
                  title: 'Break the export contract?',
                  body: `${contract.cityName} will release the ${mw(contract.mw)} offtake commitment. The early-exit fee applies.`,
                  actionLabel: 'Break contract',
                  tone: 'danger',
                  onConfirm: () => setState(cancelPowerExportContract(state, contract.id)),
                })}
              />
            ))}
          </div>
        )}
      </section>

      <ContractDesk
        state={state}
        setState={setState}
        cities={cities}
        contractMw={contractMw}
        setContractMw={setContractMw}
        contractTerm={contractTerm}
        setContractTerm={setContractTerm}
        negotiation={negotiation}
        setNegotiation={setNegotiation}
        gridStatus={`${scarcity.industryDcCount}/${scarcity.softCap}`}
        gridConstrained={scarcity.gridDemandMw > scarcity.gridCapMw}
      />
    </div>
  )
}

type Balance = ReturnType<typeof powerBalance>
type Bill = ReturnType<typeof powerImportBill>

function PowerFlow({ balance, bill }: { balance: Balance; bill: Bill }) {
  const ownUsed = Math.min(balance.demandMw, balance.genMw)
  const locked = bill.contractMw + bill.energyContractMw
  const served = ownUsed + locked + bill.spotMw
  const short = Math.max(0, balance.demandMw - served)
  const parts = [
    { id: 'owned', label: 'Owned → load', value: ownUsed, color: 'bg-mint', detail: 'On-site generation consumed by operations.' },
    { id: 'locked', label: 'Locked → load', value: locked, color: 'bg-research', detail: 'Firm utility and PPA capacity serving operations.' },
    { id: 'spot', label: 'Spot → load', value: bill.spotMw, color: 'bg-amber', detail: 'Uncontracted grid power purchased at today’s market rate.' },
    { id: 'exported', label: 'Exported', value: balance.exportMw, color: 'bg-infer', detail: 'Owned surplus delivered under active city contracts.' },
    { id: 'curtailed', label: 'Curtailed', value: balance.curtailedMw, color: 'bg-line', detail: 'Owned generation with no load or contracted buyer.' },
    { id: 'short', label: 'Unserved', value: short, color: 'bg-danger', detail: 'Demand that cannot be reached through generation or connectors.' },
  ]
  const total = Math.max(0.001, parts.reduce((sum, part) => sum + part.value, 0))
  const [selectedId, setSelectedId] = useState('owned')
  const selected = parts.find((part) => part.id === selectedId) ?? parts[0]!
  return (
    <section aria-label="Power flow" className="rounded-2xl border border-line bg-panel-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[0.8125rem] font-semibold text-bone">Power allocation</h3>
          <p className="text-[0.625rem] text-muted">Select a segment to inspect the full system flow.</p>
        </div>
        <span className={`font-mono text-[0.6875rem] ${short > 0.05 ? 'text-danger' : 'text-mint'}`}>{short > 0.05 ? `${mw(short)} unserved` : 'fully powered'}</span>
      </div>
      <div className="mt-3 flex h-5 overflow-hidden rounded-md bg-void ring-1 ring-line/60">
        {parts.filter((part) => part.value > 0).map((part) => (
          <button
            key={part.id}
            type="button"
            aria-label={`${part.label}: ${mw(part.value)}`}
            aria-pressed={selected.id === part.id}
            onClick={() => setSelectedId(part.id)}
            className={`${part.color} min-w-1 transition hover:brightness-125 ${selected.id === part.id ? 'brightness-125 ring-2 ring-inset ring-bone/80' : ''}`}
            style={{ width: `${(part.value / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3">
        {parts.map((part) => (
          <button
            key={part.id}
            type="button"
            aria-pressed={selected.id === part.id}
            onClick={() => setSelectedId(part.id)}
            className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-left font-mono text-[0.5625rem] transition ${selected.id === part.id ? 'border-bone/50 bg-bone/10 text-bone' : 'border-line/60 text-muted hover:text-bone'}`}
          >
            <span className="truncate">{part.label}</span>
            <strong>{mw(part.value)}</strong>
          </button>
        ))}
      </div>
      <div className="mt-2 rounded-lg border border-line/70 bg-void/40 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-[0.6875rem] text-bone">{selected.label}</strong>
          <span className="font-mono text-[0.625rem] text-mint">{mw(selected.value)} · {Math.round((selected.value / total) * 100)}%</span>
        </div>
        <p className="mt-0.5 text-[0.625rem] leading-snug text-muted">{selected.detail}</p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 font-mono text-[0.625rem] text-muted">
        <span>System flow</span><span className="text-right text-bone">{mw(total)}</span>
        <span>Generation upkeep</span><span className="text-right text-bone">{money(balance.generationCostDay)}/d</span>
      </div>
    </section>
  )
}

type CityRows = ReturnType<typeof cityDashboard>

function ContractDesk({
  state,
  setState,
  cities,
  contractMw,
  setContractMw,
  contractTerm,
  setContractTerm,
  negotiation,
  setNegotiation,
  gridStatus,
  gridConstrained,
}: {
  state: SimState
  setState: (state: SimState) => void
  cities: CityRows
  contractMw: number
  setContractMw: (mw: number) => void
  contractTerm: number
  setContractTerm: (days: number) => void
  negotiation: NegotiationState | null
  setNegotiation: (negotiation: NegotiationState | null) => void
  gridStatus: string
  gridConstrained: boolean
}) {
  const importQuote = negotiation?.mode === 'import'
    ? powerImportNegotiationQuote(state, negotiation.cityId, contractMw, contractTerm)
    : null
  const exportQuote = negotiation?.mode === 'export'
    ? powerExportNegotiationQuote(state, negotiation.cityId, contractMw, contractTerm)
    : null
  const activeQuote = importQuote ?? exportQuote

  const startNegotiation = (mode: 'import' | 'export', cityId: string) => {
    if (mode === 'import') {
      const quote = powerImportNegotiationQuote(state, cityId, contractMw, contractTerm)
      if (!quote || quote.contractMw < 1) return
      setNegotiation({
        mode,
        cityId,
        offerPrice: Math.round(quote.askPricePerMWh * 0.94),
      })
      return
    }
    const quote = powerExportNegotiationQuote(state, cityId, contractMw, contractTerm)
    if (!quote || quote.contractMw < 1) return
    setNegotiation({
      mode,
      cityId,
      offerPrice: Math.round(quote.utilityOfferPerMWh * 1.05),
    })
  }

  const commitNegotiation = (price: number) => {
    if (!negotiation) return
    const before = negotiation.mode === 'import'
      ? state.cityPowerContracts.length
      : state.powerExportContracts.length
    const next = negotiation.mode === 'import'
      ? signCityPowerContract(state, negotiation.cityId, contractMw, contractTerm, price)
      : signPowerExportContract(state, negotiation.cityId, contractMw, contractTerm, price)
    const after = negotiation.mode === 'import'
      ? next.cityPowerContracts.length
      : next.powerExportContracts.length
    setState(next)
    if (after > before) setNegotiation(null)
    else setNegotiation({ ...negotiation, message: 'Could not sign. Check cash, generation, and connector headroom.' })
  }

  const submitOffer = () => {
    if (!negotiation) return
    if (importQuote) {
      const result = evaluatePowerImportOffer(importQuote, negotiation.offerPrice)
      if (result.accepted) commitNegotiation(result.agreedPricePerMWh)
      else setNegotiation({ ...negotiation, counterPrice: result.agreedPricePerMWh, message: 'Utility declined and returned a firm counteroffer.' })
      return
    }
    if (exportQuote) {
      const result = evaluatePowerExportOffer(exportQuote, negotiation.offerPrice)
      if (result.accepted) commitNegotiation(result.agreedPricePerMWh)
      else setNegotiation({ ...negotiation, counterPrice: result.agreedPricePerMWh, message: 'Utility declined your ask and returned its ceiling.' })
    }
  }

  const marketPrice = importQuote?.askPricePerMWh ?? exportQuote?.utilityOfferPerMWh ?? 0
  const sliderMin = negotiation?.mode === 'import' ? marketPrice * 0.78 : marketPrice
  const sliderMax = negotiation?.mode === 'import'
    ? marketPrice
    : (exportQuote?.ceilingPricePerMWh ?? marketPrice) * 1.18

  return (
    <section className="rounded-2xl border border-mint/25 bg-mint/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[0.8125rem] font-semibold text-bone">Contract desk</h3>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
            Negotiate price and term. Imports require commissioned connector MW inside that city’s grid zone.
          </p>
        </div>
        <span className={`font-mono text-[0.6875rem] ${gridConstrained ? 'text-danger' : 'text-mint'}`}>
          grid {gridStatus}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-[0.6875rem] text-muted">
          Requested capacity · {contractMw} MW
          <input type="range" min={1} max={80} step={1} value={contractMw} onChange={(event) => { setContractMw(Number(event.target.value)); setNegotiation(null) }} className="mt-1 w-full" />
        </label>
        <label className="text-[0.6875rem] text-muted">
          Term · {contractTerm} days
          <input type="range" min={30} max={180} step={15} value={contractTerm} onChange={(event) => { setContractTerm(Number(event.target.value)); setNegotiation(null) }} className="mt-1 w-full" />
        </label>
      </div>

      {negotiation && activeQuote ? (
        <div className="mt-3 rounded-xl border border-bone/25 bg-void/55 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className={`text-[0.625rem] font-semibold uppercase tracking-wide ${negotiation.mode === 'import' ? 'text-research' : 'text-amber'}`}>
                {negotiation.mode} negotiation
              </span>
              <h4 className="text-[0.8125rem] font-medium text-bone">{activeQuote.cityName}</h4>
            </div>
            <button type="button" onClick={() => setNegotiation(null)} className="text-[0.6875rem] text-muted hover:text-bone">Close</button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 font-mono text-[0.625rem]">
            <NegotiationMetric label="Capacity" value={mw(activeQuote.contractMw)} />
            <NegotiationMetric label="Utility position" value={`${money(marketPrice)}/MWh`} />
            <NegotiationMetric label="Term" value={`${activeQuote.termDays}d`} />
          </div>
          <label className="mt-2 block text-[0.6875rem] text-muted">
            {negotiation.mode === 'import' ? 'Your bid' : 'Your asking price'} · {money(negotiation.offerPrice)}/MWh
            <input
              type="range"
              min={Math.floor(sliderMin)}
              max={Math.ceil(sliderMax)}
              step={1}
              value={negotiation.offerPrice}
              onChange={(event) => setNegotiation({ ...negotiation, offerPrice: Number(event.target.value), counterPrice: undefined, message: undefined })}
              className="mt-1 w-full"
            />
          </label>
          {negotiation.message ? <p className="mt-2 rounded-lg border border-amber/30 bg-amber/10 px-2 py-1.5 text-[0.6875rem] text-amber">{negotiation.message}</p> : null}
          <div className="mt-2 flex gap-1.5">
            {negotiation.counterPrice != null ? (
              <button type="button" onClick={() => commitNegotiation(negotiation.counterPrice!)} className="btn-primary flex-1">
                Accept {money(negotiation.counterPrice)}/MWh
              </button>
            ) : (
              <button type="button" onClick={submitOffer} className="btn-primary flex-1">Submit offer</button>
            )}
            <button type="button" onClick={() => setNegotiation(null)} className="btn-ghost">Walk away</button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 space-y-1.5">
        {cities.map(({ city, distToPlayer, hallsInZone, rivalHallsInZone, genInZone, connectorCount, connectorMw, connectorAvailableMw }) => {
          const importTerms = powerImportNegotiationQuote(state, city.id, contractMw, contractTerm)
          const exportTerms = powerExportNegotiationQuote(state, city.id, contractMw, contractTerm)
          const canImport = (importTerms?.contractMw ?? 0) >= 1
          const canExport = (exportTerms?.contractMw ?? 0) >= 1
          return (
            <article key={city.id} className="rounded-xl border border-line/70 bg-panel-2 px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="text-[0.8125rem] font-medium text-bone">{city.name}</h4>
                  <p className="font-mono text-[0.625rem] text-muted">{city.industry} · {hallsInZone} halls · {mw(genInZone)} gen · {rivalHallsInZone} rival halls</p>
                </div>
                <span className="font-mono text-[0.625rem] text-muted">{distToPlayer == null ? 'no campus' : `${distToPlayer} tiles`}</span>
              </div>
              <div className={`mt-1.5 rounded-md border px-2 py-1 font-mono text-[0.625rem] ${connectorCount > 0 ? 'border-mint/25 bg-mint/5 text-mint' : 'border-amber/25 bg-amber/5 text-amber'}`}>
                {connectorCount > 0
                  ? `${connectorCount} grid connector${connectorCount === 1 ? '' : 's'} · ${mw(connectorAvailableMw)} free / ${mw(connectorMw)}`
                  : 'No grid connector in this city zone'}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button type="button" disabled={!canImport} onClick={() => startNegotiation('import', city.id)} className="rounded-lg border border-research/30 bg-research/10 px-2 py-1.5 text-left transition hover:bg-research/15 disabled:cursor-not-allowed disabled:opacity-40">
                  <span className="block text-[0.6875rem] font-medium text-research">Negotiate import</span>
                  <span className="font-mono text-[0.625rem] text-muted">{canImport ? `${mw(importTerms!.contractMw)} connector cap` : 'connector required'}</span>
                </button>
                <button type="button" disabled={!canExport} onClick={() => startNegotiation('export', city.id)} className="rounded-lg border border-amber/30 bg-amber/10 px-2 py-1.5 text-left transition hover:bg-amber/15 disabled:cursor-not-allowed disabled:opacity-40">
                  <span className="block text-[0.6875rem] font-medium text-amber">Negotiate export</span>
                  <span className="font-mono text-[0.625rem] text-muted">{canExport ? `${mw(exportTerms!.contractMw)} surplus` : 'generation required'}</span>
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function NegotiationMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md bg-panel-2 px-2 py-1.5 text-muted">
      <span className="block text-[0.5625rem]">{label}</span>
      <strong className="text-bone">{value}</strong>
    </span>
  )
}

function ContractRow({ direction, name, mwValue, price, days, onBreak }: { direction: 'Import' | 'Export'; name: string; mwValue: number; price: number; days: number; onBreak: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-line/70 bg-void/40 px-2.5 py-2">
      <div className="min-w-0">
        <span className={`mr-2 text-[0.625rem] font-semibold uppercase ${direction === 'Import' ? 'text-research' : 'text-mint'}`}>{direction}</span>
        <span className="text-[0.75rem] text-bone">{name}</span>
        <p className="font-mono text-[0.625rem] text-muted">{mw(mwValue)} · {money(price)}/MWh · {days}d left</p>
      </div>
      <button type="button" onClick={onBreak} className="shrink-0 text-[0.6875rem] text-danger hover:underline">Break</button>
    </div>
  )
}

function Mini({ label, value, accent = 'text-bone' }: { label: string; value: string; accent?: string }) {
  return <div className="rounded-lg border border-line bg-panel-2 px-2 py-1.5"><div className="text-[0.625rem] text-muted">{label}</div><div className={`mt-0.5 font-mono text-[0.75rem] font-medium ${accent}`}>{value}</div></div>
}
