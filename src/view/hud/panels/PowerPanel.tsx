import { useState } from 'react'
import { Handshake, PaperPlaneTilt } from '@phosphor-icons/react'
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
import {
  NegotiationHeader,
  NegotiationMessage,
  NegotiationMetric,
  NegotiationMood,
  NegotiationSlider,
  type NegotiationStatus,
} from '../ui/NegotiationRoom'

type NegotiationState = {
  mode: 'import' | 'export'
  cityId: string
  offerPrice?: number
  status: NegotiationStatus
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
  const [negotiation, setNegotiation] = useState<NegotiationState>(() => ({
    mode: 'import',
    cityId: cities[0]?.city.id ?? '',
    status: 'idle',
  }))

  return (
    <div className="space-y-3">
      <div>
        <h2 className="hud-panel-title">Power</h2>
        <p className="hud-panel-sub">
          Trace every megawatt, lock utility supply, and contract owned surplus without manual export toggles.
        </p>
      </div>

      <PowerFlow balance={balance} bill={bill} />

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
  const demandScale = Math.max(0.001, balance.demandMw)
  const runningCost = balance.generationCostDay + bill.totalCostDay
  return (
    <section aria-label="Power status" className="rounded-2xl border border-line bg-panel-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[0.8125rem] font-semibold text-bone">Power status</h3>
          <p className="text-[0.625rem] text-muted">What your operations need and where it comes from.</p>
        </div>
        <span className={`font-mono text-[0.6875rem] ${short > 0.05 ? 'text-danger' : 'text-mint'}`}>
          {short > 0.05 ? `${mw(short)} short` : 'fully powered'}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 divide-x divide-line/70 rounded-lg border border-line/70 bg-void/35">
        <PowerStat label="Need" value={mw(balance.demandMw)} />
        <PowerStat label="Supplied" value={mw(Math.min(balance.demandMw, served))} />
        <PowerStat label="Cost" value={`${money(runningCost)}/d`} />
      </div>

      {balance.demandMw > 0.001 ? (
        <>
          <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-void ring-1 ring-line/50">
            {ownUsed > 0 ? (
              <span className="bg-mint" style={{ width: `${(ownUsed / demandScale) * 100}%` }} />
            ) : null}
            {locked > 0 ? (
              <span className="bg-research" style={{ width: `${(locked / demandScale) * 100}%` }} />
            ) : null}
            {bill.spotMw > 0 ? (
              <span className="bg-amber" style={{ width: `${(bill.spotMw / demandScale) * 100}%` }} />
            ) : null}
            {short > 0 ? (
              <span className="bg-danger" style={{ width: `${(short / demandScale) * 100}%` }} />
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.625rem] text-muted">
            <PowerKey color="bg-mint" label="On-site" value={mw(ownUsed)} />
            <PowerKey color="bg-research" label="Contract" value={mw(locked)} />
            <PowerKey color="bg-amber" label="Spot" value={mw(bill.spotMw)} />
            {short > 0 ? <PowerKey color="bg-danger" label="Short" value={mw(short)} /> : null}
          </div>
        </>
      ) : (
        <p className="mt-2 rounded-lg border border-dashed border-line/70 px-2.5 py-2 text-[0.6875rem] text-muted">
          No facilities are drawing power yet.
        </p>
      )}

      {balance.exportMw > 0 || balance.curtailedMw > 0 ? (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line/60 pt-2 font-mono text-[0.625rem] text-muted">
          <span>Surplus sold {mw(balance.exportMw)}</span>
          <span>Unused {mw(balance.curtailedMw)}</span>
        </div>
      ) : null}
    </section>
  )
}

function PowerStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-2 py-1.5">
      <div className="text-[0.625rem] text-muted">{label}</div>
      <div className="truncate font-mono text-[0.75rem] font-medium text-bone">{value}</div>
    </div>
  )
}

function PowerKey({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label} <strong className="text-bone">{value}</strong>
    </span>
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
  negotiation: NegotiationState
  setNegotiation: (negotiation: NegotiationState) => void
  gridStatus: string
  gridConstrained: boolean
}) {
  const importQuote = negotiation.mode === 'import'
    ? powerImportNegotiationQuote(state, negotiation.cityId, contractMw, contractTerm)
    : null
  const exportQuote = negotiation.mode === 'export'
    ? powerExportNegotiationQuote(state, negotiation.cityId, contractMw, contractTerm)
    : null
  const activeQuote = importQuote ?? exportQuote
  const selectedCity = cities.find(({ city }) => city.id === negotiation.cityId)
  const marketPrice = importQuote?.askPricePerMWh ?? exportQuote?.utilityOfferPerMWh ?? 0
  const defaultOffer = Math.round(
    importQuote
      ? importQuote.askPricePerMWh * 0.94
      : exportQuote
        ? exportQuote.utilityOfferPerMWh * 1.05
        : 0,
  )
  const offerPrice = negotiation.offerPrice ?? defaultOffer
  const sliderMin = Math.max(
    1,
    Math.floor(
      importQuote
        ? importQuote.floorPricePerMWh * 0.82
        : (exportQuote?.utilityOfferPerMWh ?? 1) * 0.9,
    ),
  )
  const sliderMax = Math.max(
    sliderMin + 1,
    Math.ceil(
      importQuote
        ? importQuote.askPricePerMWh * 1.05
        : (exportQuote?.ceilingPricePerMWh ?? 1) * 1.18,
    ),
  )
  const canNegotiate = (activeQuote?.contractMw ?? 0) >= 1
  const agreementScore = Math.max(
    5,
    Math.min(
      95,
      importQuote
        ? 58 +
            ((offerPrice - importQuote.floorPricePerMWh) /
              Math.max(1, importQuote.askPricePerMWh - importQuote.floorPricePerMWh)) *
              28
        : exportQuote
          ? 58 +
            ((exportQuote.ceilingPricePerMWh - offerPrice) /
              Math.max(1, exportQuote.ceilingPricePerMWh - exportQuote.utilityOfferPerMWh)) *
              28
          : 5,
    ),
  )
  const dailyValue = (activeQuote?.contractMw ?? 0) * offerPrice * 24

  const resetNegotiation = (patch: Partial<Pick<NegotiationState, 'cityId' | 'mode'>> = {}) => {
    setNegotiation({
      ...negotiation,
      ...patch,
      offerPrice: undefined,
      status: 'idle',
      message: undefined,
    })
  }

  const commitNegotiation = (price: number) => {
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
    if (after > before) {
      setNegotiation({
        ...negotiation,
        offerPrice: price,
        status: 'signed',
        message: `Deal accepted. ${mw(activeQuote?.contractMw ?? 0)} is live now at ${money(price)}/MWh.`,
      })
    } else {
      setNegotiation({
        ...negotiation,
        offerPrice: price,
        status: 'declined',
        message: 'We could not activate this contract. Check cash, generation, and connector headroom.',
      })
    }
  }

  const submitOffer = () => {
    if (importQuote) {
      const result = evaluatePowerImportOffer(importQuote, offerPrice)
      if (result.accepted) commitNegotiation(result.agreedPricePerMWh)
      else setNegotiation({
        ...negotiation,
        offerPrice: Math.round(result.agreedPricePerMWh),
        status: 'countered',
        message: `That price is too low. Our firm counter is ${money(result.agreedPricePerMWh)}/MWh.`,
      })
      return
    }
    if (exportQuote) {
      const result = evaluatePowerExportOffer(exportQuote, offerPrice)
      if (result.accepted) commitNegotiation(result.agreedPricePerMWh)
      else setNegotiation({
        ...negotiation,
        offerPrice: Math.round(result.agreedPricePerMWh),
        status: 'countered',
        message: `That asking price is too high. Our firm counter is ${money(result.agreedPricePerMWh)}/MWh.`,
      })
    }
  }

  const providerCopy = negotiation.status === 'signed'
    ? 'The agreement is active. Power and settlement start immediately.'
    : importQuote
      ? canNegotiate
        ? `We can reserve up to ${mw(importQuote.contractMw)} at ${money(importQuote.askPricePerMWh)}/MWh. Longer terms improve the price.`
        : `Commission a grid connector inside ${importQuote.cityName} before buying power here.`
      : exportQuote
        ? canNegotiate
          ? `We can buy up to ${mw(exportQuote.contractMw)} of your surplus. Our opening price is ${money(exportQuote.utilityOfferPerMWh)}/MWh.`
          : `Build generation inside ${exportQuote.cityName} before offering surplus power.`
        : 'Select a city utility to open a negotiation.'

  return (
    <section className="overflow-hidden rounded-2xl border border-mint/25 bg-panel-2/90">
      <NegotiationHeader
        title="Utility desk"
        subtitle={`Power contract negotiation · grid ${gridStatus}${gridConstrained ? ' constrained' : ''}`}
        status={negotiation.status}
      />

      <div className="space-y-2 p-2.5">
        <label className="flex items-center gap-2 rounded-lg border border-line/70 bg-void/55 px-2 py-1.5">
          <span className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
            Chat with
          </span>
          <select
            value={negotiation.cityId}
            onChange={(event) => resetNegotiation({ cityId: event.target.value })}
            className="min-w-0 flex-1 bg-transparent text-right text-[0.75rem] font-medium text-bone outline-none"
            aria-label="City utility"
          >
            {cities.map(({ city }) => (
              <option key={city.id} value={city.id} className="bg-void">
                {city.name} Utility
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 rounded-lg border border-line/70 bg-void/45 p-1">
          {(['import', 'export'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => resetNegotiation({ mode })}
              className={`rounded-md px-2 py-1.5 text-[0.75rem] font-medium transition ${negotiation.mode === mode ? 'bg-mint/15 text-mint' : 'text-muted hover:text-bone'}`}
            >
              {mode === 'import' ? 'Buy power' : 'Sell surplus'}
            </button>
          ))}
        </div>

        <div className="space-y-2 rounded-xl border border-line/60 bg-void/35 p-2">
          <NegotiationMessage
            side="provider"
            name={`${activeQuote?.cityName ?? selectedCity?.city.name ?? 'City'} Utility`}
          >
            <span className="font-medium text-bone">
              {negotiation.mode === 'import' ? 'Firm supply offer' : 'Surplus purchase offer'}
            </span>
            <span className="mt-0.5 block text-muted">{providerCopy}</span>
            {selectedCity ? (
              <span className="mt-1.5 flex flex-wrap gap-1 font-mono text-[0.625rem] text-muted">
                <span className="rounded-full bg-void/70 px-1.5 py-0.5">
                  {selectedCity.connectorCount} connector{selectedCity.connectorCount === 1 ? '' : 's'}
                </span>
                <span className="rounded-full bg-void/70 px-1.5 py-0.5">
                  {negotiation.mode === 'import'
                    ? `${mw(selectedCity.connectorAvailableMw)} grid room`
                    : `${mw(selectedCity.genInZone)} generation`}
                </span>
              </span>
            ) : null}
          </NegotiationMessage>

          <NegotiationMessage side="player" name="You">
            <span className="font-medium text-bone">Here’s my proposal.</span>
            <span className="mt-0.5 block text-muted">
              {negotiation.mode === 'import' ? 'Buy' : 'Sell'} {contractMw} MW for {contractTerm} days at {money(offerPrice)}/MWh.
            </span>
          </NegotiationMessage>

          {negotiation.message ? (
            <NegotiationMessage
              side="provider"
              name={`${activeQuote?.cityName ?? selectedCity?.city.name ?? 'City'} Utility`}
              status={negotiation.status}
            >
              {negotiation.message}
            </NegotiationMessage>
          ) : null}
        </div>

        {negotiation.status !== 'signed' ? (
          <>
            <div className="rounded-xl border border-line/70 bg-void/45 p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted">
                  Your offer
                </span>
                <span className="text-[0.6875rem] text-muted">Drag to negotiate</span>
              </div>
              <div className="space-y-1.5">
                <NegotiationSlider
                  label="Capacity"
                  value={contractMw}
                  min={1}
                  max={80}
                  suffix=" MW"
                  onChange={(value) => {
                    setContractMw(value)
                    resetNegotiation()
                  }}
                />
                <NegotiationSlider
                  label="Term"
                  value={contractTerm}
                  min={30}
                  max={180}
                  step={15}
                  suffix=" days"
                  onChange={(value) => {
                    setContractTerm(value)
                    resetNegotiation()
                  }}
                />
                <NegotiationSlider
                  label={negotiation.mode === 'import' ? 'Your bid' : 'Your ask'}
                  value={offerPrice}
                  min={sliderMin}
                  max={sliderMax}
                  suffix="/MWh"
                  onChange={(value) =>
                    setNegotiation({
                      ...negotiation,
                      offerPrice: value,
                      status: 'idle',
                      message: undefined,
                    })
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-1 font-mono text-[0.6875rem]">
              <NegotiationMetric label="Capacity" value={mw(activeQuote?.contractMw ?? 0)} />
              <NegotiationMetric
                label={negotiation.mode === 'import' ? 'Daily cost' : 'Daily revenue'}
                value={money(dailyValue)}
              />
              <NegotiationMetric label="Term" value={`${activeQuote?.termDays ?? contractTerm}d`} />
              <NegotiationMetric label="Market" value={`${money(marketPrice)}/MWh`} />
            </div>

            <NegotiationMood score={agreementScore} />

            {!canNegotiate ? (
              <p className="rounded-lg border border-amber/30 bg-amber/5 px-2 py-1.5 text-[0.75rem] text-amber">
                {negotiation.mode === 'import'
                  ? 'A commissioned grid connector with free capacity is required in this city.'
                  : 'Commissioned generation with unsold surplus is required in this city.'}
              </p>
            ) : null}
          </>
        ) : null}

        {negotiation.status === 'idle' || negotiation.status === 'countered' ? (
          <button
            type="button"
            disabled={!canNegotiate}
            className="btn-primary flex w-full items-center justify-center gap-1.5 py-1.5 text-[0.8125rem] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={submitOffer}
          >
            <PaperPlaneTilt size={15} weight="fill" />
            {negotiation.status === 'countered' ? 'Send counter-offer' : 'Send proposal'}
          </button>
        ) : null}
        {negotiation.status === 'signed' ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-mint/35 bg-mint/10 px-2 py-1.5 text-[0.8125rem] font-medium text-mint">
            <span className="flex items-center gap-1.5">
              <Handshake size={16} weight="duotone" />
              Contract active · power online
            </span>
            <button type="button" className="text-[0.6875rem] hover:underline" onClick={() => resetNegotiation()}>
              New deal
            </button>
          </div>
        ) : null}
        {negotiation.status === 'declined' ? (
          <button
            type="button"
            className="btn-ghost flex w-full items-center justify-center gap-1.5 py-1.5 text-[0.8125rem]"
            onClick={() => resetNegotiation()}
          >
            <Handshake size={15} />
            Edit proposal
          </button>
        ) : null}
      </div>
    </section>
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
