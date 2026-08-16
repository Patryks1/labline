import type {
  DataDomain,
  DataMarketOffer,
  DataMarketState,
  DataQualityBand,
  DataSellerKind,
  DomainStock,
  LabData,
  ModelBackbone,
  ModelFamily,
  SegmentId,
  TrainingDataPlan,
} from '../types'

export type { DataMarketOffer, DataMarketState, DataQualityBand, DataSellerKind }

export const DATA_DOMAINS: DataDomain[] = [
  'code',
  'math',
  'science',
  'law',
  'health',
  'chat',
  'image',
  'video',
  'audio',
]

export const DATA_DOMAIN_META: Record<
  DataDomain,
  {
    label: string
    blurb: string
    coding: number
    math: number
    science: number
    law: number
    health: number
    chat: number
    vision: number
    video: number
    audio: number
    safety: number
    capability: number
    /** Cash per MTok processed */
    processCostPerMTok: number
    processHard: number
    /** Synth gen: MTok per research-PF·day at cap 50 model */
    synthMTokPerPfDay: number
  }
> = {
  code: {
    label: 'Code',
    blurb: 'Repos, issues, PRs, docs.',
    coding: 10,
    math: 5,
    science: 2,
    law: 0,
    health: 0,
    chat: -1,
    vision: 0,
    video: 0,
    audio: 0,
    safety: 0,
    capability: 1.5,
    processCostPerMTok: 900,
    processHard: 1,
    synthMTokPerPfDay: 12,
  },
  law: {
    label: 'Law',
    blurb: 'Contracts, case law, compliance.',
    coding: 0,
    math: 0,
    science: 1,
    law: 12,
    health: 1,
    chat: 0,
    vision: 0,
    video: 0,
    audio: 0,
    safety: 4,
    capability: 1,
    processCostPerMTok: 1400,
    processHard: 1.25,
    synthMTokPerPfDay: 8,
  },
  health: {
    label: 'Health',
    blurb: 'Clinical notes, papers, guidelines.',
    coding: 0,
    math: 1,
    science: 9,
    law: 1,
    health: 12,
    chat: 0,
    vision: 1,
    video: 0,
    audio: 0,
    safety: 5,
    capability: 1,
    processCostPerMTok: 1600,
    processHard: 1.35,
    synthMTokPerPfDay: 7,
  },
  chat: {
    label: 'Chat',
    blurb: 'Conversations, instructions, prefs.',
    coding: 1,
    math: 1,
    science: 0,
    law: 0,
    health: 0,
    chat: 10,
    vision: 0,
    video: 0,
    audio: 1,
    safety: 1,
    capability: 1,
    processCostPerMTok: 700,
    processHard: 0.85,
    synthMTokPerPfDay: 18,
  },
  image: {
    label: 'Image',
    blurb: 'Captions, vision pairs, design.',
    coding: 0,
    math: 0,
    science: 1,
    law: 0,
    health: 0,
    chat: 1,
    vision: 12,
    video: 2,
    audio: 0,
    safety: 0,
    capability: 1,
    // Decode, perceptual dedup, caption alignment, and safety classification.
    processCostPerMTok: 3500,
    processHard: 2.6,
    synthMTokPerPfDay: 6,
  },
  video: {
    label: 'Video',
    blurb: 'Clips + temporal labels.',
    coding: 0,
    math: 0,
    science: 1,
    law: 0,
    health: 0,
    chat: 0,
    vision: 4,
    video: 12,
    audio: 2,
    safety: -1,
    capability: 1.5,
    // Frame decode + temporal/caption checks make video the costly outlier.
    processCostPerMTok: 14000,
    processHard: 9,
    synthMTokPerPfDay: 3,
  },
  audio: {
    label: 'Audio',
    blurb: 'Speech, music tags, ASR.',
    coding: 0,
    math: 0,
    science: 0,
    law: 0,
    health: 0,
    chat: 2,
    vision: 0,
    video: 1,
    audio: 12,
    safety: 0,
    capability: 0.5,
    // Transcription, segmentation, speaker/music tagging, and rights checks.
    processCostPerMTok: 4200,
    processHard: 3.5,
    synthMTokPerPfDay: 10,
  },
  math: {
    label: 'Math',
    blurb: 'Proofs, worked solutions, formal traces.',
    coding: 3,
    math: 12,
    science: 4,
    law: 0,
    health: 1,
    chat: -1,
    vision: 0,
    video: 0,
    audio: 0,
    safety: 1,
    capability: 1.7,
    processCostPerMTok: 1900,
    processHard: 1.45,
    synthMTokPerPfDay: 6,
  },
  science: {
    label: 'Science',
    blurb: 'Papers, lab records, simulations, expert QA.',
    coding: 2,
    math: 5,
    science: 12,
    law: 0,
    health: 5,
    chat: -1,
    vision: 2,
    video: 0,
    audio: 0,
    safety: 2,
    capability: 1.8,
    processCostPerMTok: 2400,
    processHard: 1.6,
    synthMTokPerPfDay: 4,
  },
}

export const SEGMENT_DATA_DEPOSIT: Record<SegmentId, Partial<Record<DataDomain, number>>> = {
  hobby: { chat: 0.65, code: 0.1, image: 0.15, audio: 0.1 },
  consumer: { chat: 0.55, image: 0.2, audio: 0.15, video: 0.1 },
  indie_api: { code: 0.55, chat: 0.25, image: 0.1, audio: 0.1 },
  startup_api: { code: 0.5, chat: 0.2, law: 0.1, health: 0.05, image: 0.15 },
  science: { science: 0.5, math: 0.25, code: 0.15, health: 0.05, chat: 0.05 },
  enterprise: { chat: 0.25, code: 0.25, law: 0.2, health: 0.15, image: 0.1, audio: 0.05 },
  creative: { image: 0.45, video: 0.3, chat: 0.15, audio: 0.1 },
  legal: { law: 0.7, chat: 0.2, code: 0.1 },
  healthcare: { health: 0.65, chat: 0.2, image: 0.1, law: 0.05 },
}

/**
 * Token economy (MTok = million tokens).
 * Rule: min data tokens ≈ parameter count (1B params → 1000 MTok = 1B tokens).
 */
export const DATA_ECONOMY = {
  /** Starting total processed tokens (user request: 500M / 500 MTok) */
  starterTotalMTok: 500,
  /** Raw, novel MTok retained per served MTok after consent and filtering. */
  collectMTokPerServedMTok: 0.18,
  privacyBrandHit: 0.04,
  /** HQ synthetic quality (0–100) with data_synth unlocked + capable teacher */
  syntheticQualityHQ: 72,
  /** LQ synthetic quality — noisy; high share regresses models */
  syntheticQualityLQ: 28,
  /** @deprecated use syntheticQualityHQ */
  syntheticQuality: 72,
  freeBootstrapQuality: 18,
  maxProcessJobs: 6,
  maxSynthJobs: 4,
  /** Cap of research pool that data-gen can claim */
  maxDataGenResearchShare: 0.85,
  /** Capability hit mult when LQ synth share of train mix is high */
  lqRegressionMax: 0.22,
  partnershipMTok: {
    chat: 80,
    code: 50,
    math: 18,
    science: 14,
    law: 25,
    health: 20,
    image: 18,
    video: 8,
    audio: 15,
  } as Record<DataDomain, number>,
  partnershipQuality: 62,
  partnershipCash: 7_500_000,
}

/** @deprecated alias — use DataMarketOffer */
export type DomainDataContract = DataMarketOffer

/** @deprecated static catalog — use generateDataMarketOffers / state.dataMarket */
export const DOMAIN_DATA_CONTRACTS: DomainDataContract[] = []

export const DATA_SELLER_LABELS: Record<DataSellerKind, string> = {
  web_scrape: 'Web scrape',
  broker: 'Data broker',
  rival: 'Rival dump',
  enterprise: 'Enterprise',
  research_lab: 'Research lab',
  opensource: 'Open source',
}

export const DATA_QUALITY_LABELS: Record<DataQualityBand, string> = {
  scrap: 'Scrap',
  standard: 'Standard',
  premium: 'Premium',
  curated: 'Curated',
}

export const DATA_QUALITY_BAND_RANGE: Record<DataQualityBand, [number, number]> = {
  scrap: [28, 42],
  standard: [48, 60],
  premium: [62, 74],
  curated: [76, 88],
}

/** $/MTok base by quality band (before domain mult). */
export const DATA_CASH_PER_MTOK: Record<DataQualityBand, number> = {
  scrap: 4_500,
  standard: 12_000,
  premium: 28_000,
  curated: 55_000,
}

/**
 * Per-domain $ multiplier on top of the quality-band rate. Media listings are
 * far pricier than text: the typical text-domain multiplier averages ≈1.45,
 * so video (4.5) lands ≈3× and audio (3.0) ≈2× that rate — licensing, storage,
 * and labeling for AV data are genuinely expensive.
 */
export const DOMAIN_PRICE_MULT: Record<DataDomain, number> = {
  code: 1.25,
  math: 1.7,
  science: 1.9,
  law: 1.45,
  health: 1.55,
  chat: 0.85,
  image: 1.1,
  video: 4.5,
  audio: 3.0,
}

/**
 * Listing-frequency weight per domain for open-market generation. Audio and
 * video each get 20% of listings (≈40% together) — they're a big part of the
 * internet — while the seven text/image domains share the remaining 60%.
 */
export const DOMAIN_LISTING_WEIGHT: Record<DataDomain, number> = {
  code: 0.12,
  math: 0.07,
  science: 0.08,
  law: 0.07,
  health: 0.06,
  chat: 0.12,
  image: 0.08,
  video: 0.2,
  audio: 0.2,
}

export function emptyDataMarket(): DataMarketState {
  return { offers: [], lastRefreshDay: 0, nextRefreshDay: 1 }
}

type OfferTemplate = {
  domain: DataDomain
  sellerKind: DataSellerKind
  qualityBand: DataQualityBand
  name: string
  blurb: string
  /** relative volume weight */
  volumeW: number
  source: 'web' | 'scrap' | 'licensed'
}

const OFFER_TEMPLATES: OfferTemplate[] = [
  // Web scrapes — cheap, dirty, often huge
  {
    domain: 'chat',
    sellerKind: 'web_scrape',
    qualityBand: 'scrap',
    name: 'Common crawl slice',
    blurb: 'Bulk HTML dumps. Cheap tokens, noisy quality.',
    volumeW: 2.4,
    source: 'scrap',
  },
  {
    domain: 'chat',
    sellerKind: 'web_scrape',
    qualityBand: 'scrap',
    name: 'Forum scrape torrent',
    blurb: 'Unfiltered threads. High volume, low signal.',
    volumeW: 1.8,
    source: 'scrap',
  },
  {
    domain: 'code',
    sellerKind: 'web_scrape',
    qualityBand: 'scrap',
    name: 'Public repo mirror',
    blurb: 'GitHub/GitLab mirrors without license scrub.',
    volumeW: 1.6,
    source: 'scrap',
  },
  {
    domain: 'image',
    sellerKind: 'web_scrape',
    qualityBand: 'scrap',
    name: 'Imageboard crawl',
    blurb: 'Noisy captions. Fine for pretrain volume only.',
    volumeW: 1.4,
    source: 'scrap',
  },
  {
    domain: 'audio',
    sellerKind: 'web_scrape',
    qualityBand: 'scrap',
    name: 'Podcast archive torrent',
    blurb: 'Thousands of hours of rips. Auto-transcribed, noisy segments.',
    volumeW: 2.0,
    source: 'scrap',
  },
  {
    domain: 'video',
    sellerKind: 'web_scrape',
    qualityBand: 'scrap',
    name: 'Video crawl torrent',
    blurb: 'Scraped clips with weak metadata. Huge volume, rough labels.',
    volumeW: 2.2,
    source: 'scrap',
  },
  // Brokers — mid market
  {
    domain: 'chat',
    sellerKind: 'broker',
    qualityBand: 'standard',
    name: 'Dialogue marketplace',
    blurb: 'Human chats + prefs. Generalist fuel.',
    volumeW: 1.2,
    source: 'licensed',
  },
  {
    domain: 'math',
    sellerKind: 'research_lab',
    qualityBand: 'curated',
    name: 'Verified proof traces',
    blurb: 'Expert-reviewed solutions with machine-checkable answers.',
    volumeW: 0.38,
    source: 'licensed',
  },
  {
    domain: 'science',
    sellerKind: 'research_lab',
    qualityBand: 'premium',
    name: 'Reproducible science corpus',
    blurb: 'Papers, negative results, and structured experimental records.',
    volumeW: 0.42,
    source: 'licensed',
  },
  {
    domain: 'code',
    sellerKind: 'broker',
    qualityBand: 'standard',
    name: 'CodeForge corpus',
    blurb: 'Licensed repos + issues. Solid coding lift.',
    volumeW: 1.1,
    source: 'licensed',
  },
  {
    domain: 'audio',
    sellerKind: 'broker',
    qualityBand: 'standard',
    name: 'Speech marketplace',
    blurb: 'ASR transcripts + speaker tags.',
    volumeW: 0.9,
    source: 'licensed',
  },
  {
    domain: 'audio',
    sellerKind: 'broker',
    qualityBand: 'premium',
    name: 'Call-center voice logs',
    blurb: 'Consent-cleared support calls with aligned transcripts.',
    volumeW: 0.6,
    source: 'licensed',
  },
  {
    domain: 'video',
    sellerKind: 'broker',
    qualityBand: 'premium',
    name: 'Licensed footage library',
    blurb: 'B-roll + documentary footage with cleared rights.',
    volumeW: 0.65,
    source: 'licensed',
  },
  {
    domain: 'chat',
    sellerKind: 'broker',
    qualityBand: 'standard',
    name: 'Multilingual pack',
    blurb: 'Parallel text across 40 languages.',
    volumeW: 1.0,
    source: 'licensed',
  },
  // Enterprise — expensive, high Q, often smaller
  {
    domain: 'code',
    sellerKind: 'enterprise',
    qualityBand: 'premium',
    name: 'Enterprise monorepo license',
    blurb: 'Anonymized internal code. Heavy coding lift.',
    volumeW: 0.75,
    source: 'licensed',
  },
  {
    domain: 'law',
    sellerKind: 'enterprise',
    qualityBand: 'curated',
    name: 'Legal archive license',
    blurb: 'Case law + filings. Compliance edge.',
    volumeW: 0.55,
    source: 'licensed',
  },
  {
    domain: 'health',
    sellerKind: 'enterprise',
    qualityBand: 'curated',
    name: 'De-ID clinical notes',
    blurb: 'Healthcare QA packs. Safety-critical.',
    volumeW: 0.5,
    source: 'licensed',
  },
  {
    domain: 'code',
    sellerKind: 'enterprise',
    qualityBand: 'premium',
    name: 'Bug-fix + review traces',
    blurb: 'PR discussions with outcomes. Agent gold.',
    volumeW: 0.45,
    source: 'licensed',
  },
  {
    domain: 'audio',
    sellerKind: 'enterprise',
    qualityBand: 'curated',
    name: 'Studio stems license',
    blurb: 'Multi-track studio sessions — music, foley, voice. Priced per hour.',
    volumeW: 0.4,
    source: 'licensed',
  },
  {
    domain: 'video',
    sellerKind: 'enterprise',
    qualityBand: 'curated',
    name: 'Studio rushes license',
    blurb: 'Raw shoots with scene logs and releases. Premium video fuel.',
    volumeW: 0.42,
    source: 'licensed',
  },
  // Research labs
  {
    domain: 'chat',
    sellerKind: 'research_lab',
    qualityBand: 'premium',
    name: 'Instruction mix v3',
    blurb: 'Academic instruction set with human raters.',
    volumeW: 0.6,
    source: 'licensed',
  },
  {
    domain: 'image',
    sellerKind: 'research_lab',
    qualityBand: 'premium',
    name: 'Vision-language pairs',
    blurb: 'Captioned docs + VQA. Cleaner than scrapes.',
    volumeW: 0.65,
    source: 'licensed',
  },
  {
    domain: 'video',
    sellerKind: 'research_lab',
    qualityBand: 'standard',
    name: 'Clip-caption set',
    blurb: 'Short clips with weak labels. Mid quality.',
    volumeW: 0.7,
    source: 'licensed',
  },
  // Open source
  {
    domain: 'code',
    sellerKind: 'opensource',
    qualityBand: 'standard',
    name: 'The Stack open subset',
    blurb: 'Permissively licensed code. Fair price.',
    volumeW: 1.3,
    source: 'web',
  },
  {
    domain: 'chat',
    sellerKind: 'opensource',
    qualityBand: 'standard',
    name: 'OpenInstruct dump',
    blurb: 'Community instructions. Decent generalist.',
    volumeW: 1.0,
    source: 'web',
  },
  // Rival-style (seller name filled at gen time)
  {
    domain: 'code',
    sellerKind: 'rival',
    qualityBand: 'premium',
    name: 'Surplus coding corpus',
    blurb: 'Rival offloading excess code tokens.',
    volumeW: 0.8,
    source: 'licensed',
  },
  {
    domain: 'chat',
    sellerKind: 'rival',
    qualityBand: 'standard',
    name: 'User-log extract',
    blurb: 'Anonymized product traffic. Variable quality.',
    volumeW: 1.1,
    source: 'licensed',
  },
  {
    domain: 'law',
    sellerKind: 'rival',
    qualityBand: 'premium',
    name: 'Compliance pack surplus',
    blurb: 'Safety lab clearing inventory.',
    volumeW: 0.4,
    source: 'licensed',
  },
]

/** Templates grouped per domain so generation can weight domains, not templates. */
const OFFER_TEMPLATES_BY_DOMAIN: Record<DataDomain, OfferTemplate[]> =
  DATA_DOMAINS.reduce(
    (acc, domain) => {
      acc[domain] = OFFER_TEMPLATES.filter((tmpl) => tmpl.domain === domain)
      return acc
    },
    {} as Record<DataDomain, OfferTemplate[]>,
  )

/**
 * Pick a listing template: first roll a domain from DOMAIN_LISTING_WEIGHT
 * (audio + video ≈ 40% of listings), then a uniform template within it.
 */
function pickOfferTemplate(r: () => number): OfferTemplate {
  const roll = r()
  let acc = 0
  // Fallback covers the roll === 1.0 edge; weights sum to 1 otherwise.
  let domain: DataDomain = DATA_DOMAINS[DATA_DOMAINS.length - 1]!
  for (const candidate of DATA_DOMAINS) {
    acc += DOMAIN_LISTING_WEIGHT[candidate]
    if (roll < acc) {
      domain = candidate
      break
    }
  }
  const pool = OFFER_TEMPLATES_BY_DOMAIN[domain]
  return pool[Math.min(pool.length - 1, Math.floor(r() * pool.length))]!
}

/** Deterministic PRNG from seed+day+i */
function marketRng(seed: number, day: number, i: number): () => number {
  let s = (seed ^ (day * 7919) ^ (i * 104729)) >>> 0
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
  // Burn two rounds: the first LCG outputs stay correlated with small seeds,
  // which would silently starve weighted domain picks of whole domains.
  next()
  next()
  return next
}

function pickQuality(band: DataQualityBand, r: () => number): number {
  const [lo, hi] = DATA_QUALITY_BAND_RANGE[band]
  return Math.round(lo + (hi - lo) * r())
}

/**
 * Build a fresh slate of market offers.
 * Volumes vary: some listings nearly empty, some flood the market.
 * As the game progresses the shared pool deepens — much larger lots become
 * available, and the going $/MTok rate climbs with it.
 */
export function generateDataMarketOffers(
  seed: number,
  day: number,
  rivalNames: string[] = [],
  count = 10,
): DataMarketOffer[] {
  const offers: DataMarketOffer[] = []
  const n = Math.max(6, Math.min(14, count))
  // Late-game market: deeper supply (up to 9×) at higher prices (up to 6×).
  const volumeMult = 1 + Math.min(Math.max(0, day), 2400) / 300
  const priceMult = 1 + Math.min(Math.max(0, day), 3000) / 600
  for (let i = 0; i < n; i++) {
    const r = marketRng(seed, day, i + 3)
    const tmpl = pickOfferTemplate(r)
    // Volume: log-uniform-ish — thin → flood
    const volRoll = r()
    let mTokTotal: number
    if (volRoll < 0.12) {
      // Dry / almost nothing
      mTokTotal = Math.round(8 + r() * 40)
    } else if (volRoll < 0.35) {
      mTokTotal = Math.round(60 + r() * 180)
    } else if (volRoll < 0.7) {
      mTokTotal = Math.round(200 + r() * 500 * tmpl.volumeW)
    } else if (volRoll < 0.9) {
      mTokTotal = Math.round(600 + r() * 1200 * tmpl.volumeW)
    } else {
      // Flood
      mTokTotal = Math.round(1500 + r() * 4000 * tmpl.volumeW)
    }
    // Scrapes bias larger
    if (tmpl.qualityBand === 'scrap') mTokTotal = Math.round(mTokTotal * (1.4 + r() * 0.8))
    // Curated bias smaller
    if (tmpl.qualityBand === 'curated') mTokTotal = Math.round(mTokTotal * (0.35 + r() * 0.35))
    mTokTotal = Math.round(mTokTotal * volumeMult)

    // 8% chance sold out / no inventory this refresh
    const soldOut = r() < 0.08
    const mTokLeft = soldOut ? 0 : mTokTotal

    const quality = pickQuality(tmpl.qualityBand, r)
    // Lot size: small for premium, larger for scrap
    let lotMTok =
      tmpl.qualityBand === 'scrap'
        ? Math.round(80 + r() * 220)
        : tmpl.qualityBand === 'curated'
          ? Math.round(25 + r() * 60)
          : Math.round(40 + r() * 140)
    lotMTok = Math.max(10, Math.min(Math.round(lotMTok * volumeMult), Math.max(10, mTokTotal)))

    const pricePer =
      DATA_CASH_PER_MTOK[tmpl.qualityBand] *
      (DOMAIN_PRICE_MULT[tmpl.domain] ?? 1) *
      priceMult *
      (0.85 + r() * 0.35)
    const lotForPrice = mTokLeft > 0 ? Math.min(lotMTok, mTokLeft) : lotMTok
    const cash = Math.max(50_000, Math.round(lotForPrice * pricePer))

    let sellerName: string
    if (tmpl.sellerKind === 'rival' && rivalNames.length > 0) {
      sellerName = rivalNames[Math.floor(r() * rivalNames.length)]!
    } else if (tmpl.sellerKind === 'web_scrape') {
      sellerName = r() < 0.5 ? 'ShadowCrawl LLC' : 'OpenTorrent Data'
    } else if (tmpl.sellerKind === 'broker') {
      sellerName = r() < 0.5 ? 'TokenBazaar' : 'Corpus Exchange'
    } else if (tmpl.sellerKind === 'enterprise') {
      sellerName = r() < 0.5 ? 'Apex Data Rights' : 'Clearview Licensing'
    } else if (tmpl.sellerKind === 'research_lab') {
      sellerName = r() < 0.5 ? 'Uni OpenLab' : 'Civic AI Institute'
    } else {
      sellerName = 'Community mirror'
    }

    offers.push({
      id: `dm-${day}-${i}-${tmpl.domain}-${tmpl.qualityBand}`,
      domain: tmpl.domain,
      name: tmpl.name,
      blurb: tmpl.blurb,
      sellerKind: tmpl.sellerKind,
      sellerName,
      qualityBand: tmpl.qualityBand,
      quality,
      mTokLeft,
      mTokTotal,
      lotMTok,
      cash,
      daysLeft: 4 + Math.floor(r() * 10),
      source: tmpl.source,
    })
  }
  // Sort: available first, then by $/MTok
  offers.sort((a, b) => {
    if ((a.mTokLeft === 0) !== (b.mTokLeft === 0)) return a.mTokLeft === 0 ? 1 : -1
    const pa = a.cash / Math.max(1, Math.min(a.lotMTok, a.mTokLeft || a.lotMTok))
    const pb = b.cash / Math.max(1, Math.min(b.lotMTok, b.mTokLeft || b.lotMTok))
    return pa - pb
  })
  return offers
}

/** Minimum MTok to train a model of this size (1:1 tokens:params). */
export function minDataMTokForParams(paramsB: number): number {
  // paramsB is billions of parameters → need paramsB * 1e9 tokens = paramsB * 1000 MTok
  return Math.max(1, paramsB * 1000)
}

export interface TrainingDataTargetSpec {
  paramsB: number
  activeParamsB?: number
  family: ModelFamily
  backbone?: ModelBackbone
  /** Share of the selected corpus used for optimization; the rest is held out. */
  trainShare?: number
}

/**
 * Parameter capacity that must receive useful training coverage.
 *
 * Dense models exercise every parameter on every token. MoE routes only the
 * active path, while the inactive expert bank still needs partial coverage so
 * routing does not leave most experts cold. The 20% bank weight matches the
 * sparse-capacity assumption used by the legacy MoE training curve; memory
 * requirements continue to use total parameters.
 */
export function trainingDataParameterBasisB(
  spec: Pick<
    TrainingDataTargetSpec,
    'paramsB' | 'activeParamsB' | 'family' | 'backbone'
  >,
): number {
  const total = Math.max(0.001, spec.paramsB)
  const sparse = spec.backbone === 'moe' || (spec.backbone == null && spec.family === 'moe')
  if (!sparse) return total
  const active = Math.max(0.001, Math.min(total, spec.activeParamsB ?? total * 0.1))
  return active + (total - active) * 0.2
}

function trainingTargetMTok(
  spec: TrainingDataTargetSpec,
  tokensPerParameter: number,
): number {
  const trainShare = Math.max(0.4, Math.min(0.95, spec.trainShare ?? 0.82))
  const optimizationTokens =
    trainingDataParameterBasisB(spec) * 1000 * Math.max(0, tokensPerParameter)
  return Math.round(optimizationTokens / trainShare)
}

/** Raw corpus floor including the verification holdout. */
export function minimumTrainingDataMTok(spec: TrainingDataTargetSpec): number {
  const isOmni = spec.family === 'omni'
  return trainingTargetMTok(spec, isOmni ? 10 : 1)
}

/** Strong raw-corpus target including routed MoE capacity and verification. */
export function recommendedTrainingDataMTok(spec: TrainingDataTargetSpec): number {
  const isOmni = spec.family === 'omni'
  return trainingTargetMTok(spec, isOmni ? 10 : 6)
}

/**
 * Strong training target. Dense/MoE/media models aim for 6 quality-weighted
 * tokens per parameter; omni needs substantially broader coverage at 10:1.
 * The frontier curve continues toward ~20:1 (24:1 omni) with diminishing returns.
 */
export function recommendedDataMTok(paramsB: number, family: string): number {
  let m = minDataMTokForParams(paramsB) * (family === 'omni' ? 10 : 6)
  return Math.round(m)
}

/** @deprecated alias — volume is MTok now */
export function recommendedDataUnits(paramsB: number, family: string): number {
  return recommendedDataMTok(paramsB, family)
}

export function emptyDomainStock(): DomainStock {
  return {
    raw: 0,
    processed: 0,
    quality: 40,
    fromWeb: 0,
    fromUser: 0,
    fromBought: 0,
    fromSynth: 0,
    fromSynthHQ: 0,
    fromSynthLQ: 0,
  }
}

/** Back-compat: ensure HQ/LQ fields exist on older stocks. */
export function normalizeDomainStock(s: DomainStock | undefined | null): DomainStock {
  const base = emptyDomainStock()
  if (!s) return base
  const fromSynth = s.fromSynth ?? 0
  let hq = s.fromSynthHQ ?? 0
  let lq = s.fromSynthLQ ?? 0
  // Migrate legacy undifferentiated synth → treat as mostly LQ (risky)
  if (fromSynth > 0 && hq + lq < fromSynth * 0.5) {
    hq = fromSynth * 0.35
    lq = fromSynth * 0.65
  }
  return {
    raw: s.raw ?? 0,
    processed: s.processed ?? 0,
    quality: s.quality ?? 40,
    fromWeb: s.fromWeb ?? 0,
    fromUser: s.fromUser ?? 0,
    fromBought: s.fromBought ?? 0,
    fromSynth: Math.max(fromSynth, hq + lq),
    fromSynthHQ: hq,
    fromSynthLQ: lq,
  }
}

export function createEmptyLabData(): LabData {
  const stocks = {} as Record<DataDomain, DomainStock>
  for (const d of DATA_DOMAINS) stocks[d] = emptyDomainStock()

  // 500 MTok public foundation — less chat-heavy, more code/math/science,
  // with small regulated-domain seeds. Audio/video must still be earned.
  const seed: Partial<Record<DataDomain, number>> = {
    chat: 80,
    code: 180,
    math: 90,
    science: 80,
    image: 40,
    law: 15,
    health: 15,
  }
  let total = 0
  for (const d of DATA_DOMAINS) {
    const m = seed[d] ?? 0
    stocks[d].processed = m
    stocks[d].fromWeb = m
    stocks[d].quality = 48
    total += m
  }

  return {
    stocks,
    assets: [
      {
        id: 'dataset-public-foundation-2026',
        name: 'Public Foundation Mix',
        volumeMTok: total,
        domainWeights: normalizeWeights(seed),
        verticalTags: ['general', 'public-foundation'],
        quality: 48,
        diversity: 0.58,
        freshness: 0.72,
        rights: 'public',
        exclusiveUntilDay: null,
        contaminationRisk: 0.14,
        source: 'web',
        acquiredDay: 1,
      },
    ],
    manifests: [],
    processQueue: [],
    pruneQueue: [],
    synthQueue: [],
    autoProcess: true,
    collectionRate: 0.55,
    lifetimeCollected: total,
    lifetimeProcessed: total,
    dayCollected: 0,
    dayProcessed: 0,
    daySynthMTok: 0,
    dayCollectByDomain: {},
    dataGenResearchShare: 0,
  }
}

export function defaultDataWeights(family: string): Record<DataDomain, number> {
  const w: Record<DataDomain, number> = {
    code: 0.22,
    math: 0.12,
    science: 0.1,
    law: 0.04,
    health: 0.04,
    chat: 0.32,
    image: 0.08,
    video: 0.03,
    audio: 0.05,
  }
  if (family === 'diffusion') {
    return { code: 0.04, math: 0.02, science: 0.03, law: 0.01, health: 0.02, chat: 0.13, image: 0.54, video: 0.15, audio: 0.06 }
  }
  if (family === 'video') {
    return { code: 0.04, math: 0.01, science: 0.02, law: 0.01, health: 0.01, chat: 0.11, image: 0.2, video: 0.51, audio: 0.09 }
  }
  if (family === 'omni') {
    return { code: 0.13, math: 0.07, science: 0.07, law: 0.04, health: 0.04, chat: 0.25, image: 0.18, video: 0.13, audio: 0.09 }
  }
  return w
}

export function legacyMixToWeights(mix: string): Record<DataDomain, number> {
  switch (mix) {
    case 'code':
      return { code: 0.5, math: 0.12, science: 0.05, law: 0.01, health: 0.01, chat: 0.2, image: 0.06, video: 0.02, audio: 0.03 }
    case 'math':
      return { code: 0.18, math: 0.46, science: 0.16, law: 0.01, health: 0.03, chat: 0.1, image: 0.03, video: 0.01, audio: 0.02 }
    case 'curated':
      return { code: 0.13, math: 0.11, science: 0.12, law: 0.1, health: 0.1, chat: 0.31, image: 0.06, video: 0.03, audio: 0.04 }
    case 'synthetic':
      return { code: 0.18, math: 0.12, science: 0.09, law: 0.04, health: 0.04, chat: 0.36, image: 0.07, video: 0.04, audio: 0.06 }
    default:
      return defaultDataWeights('dense')
  }
}

export function normalizeWeights(
  weights: Partial<Record<DataDomain, number>>,
): Record<DataDomain, number> {
  const out = {} as Record<DataDomain, number>
  let sum = 0
  for (const d of DATA_DOMAINS) {
    const v = Math.max(0, weights[d] ?? 0)
    out[d] = v
    sum += v
  }
  if (sum <= 0) return defaultDataWeights('dense')
  for (const d of DATA_DOMAINS) out[d] = out[d]! / sum
  return out
}

export function resolveDataPlan(
  plan: TrainingDataPlan | undefined,
  paramsB: number,
  family: string,
  legacyMix?: string,
): TrainingDataPlan & { weights: Record<DataDomain, number>; totalMTok: number; trainShare: number } {
  const weights =
    plan?.weights && Object.keys(plan.weights).length > 0
      ? normalizeWeights(plan.weights)
      : legacyMix
        ? legacyMixToWeights(legacyMix)
        : defaultDataWeights(family)
  const totalMTok =
    plan?.totalMTok && plan.totalMTok > 0
      ? plan.totalMTok
      : plan?.totalUnits && plan.totalUnits > 0
        ? plan.totalUnits
        : recommendedDataMTok(paramsB, family)
  const trainShare =
    plan?.trainShare != null
      ? Math.max(0.4, Math.min(0.95, plan.trainShare))
      : 0.82
  const allowSynthetic = plan?.allowSynthetic ?? true
  return {
    totalUnits: totalMTok,
    totalMTok,
    trainShare,
    weights,
    allowSynthetic,
    includeSynthHQ: plan?.includeSynthHQ ?? allowSynthetic,
    includeSynthLQ: plan?.includeSynthLQ ?? false,
    domainModels: plan?.domainModels ? { ...plan.domainModels } : undefined,
  }
}

export function totalProcessed(data: LabData): number {
  return DATA_DOMAINS.reduce((s, d) => s + data.stocks[d].processed, 0)
}

export function totalRaw(data: LabData): number {
  return DATA_DOMAINS.reduce((s, d) => s + data.stocks[d].raw, 0)
}

export function totalSources(data: LabData): {
  web: number
  user: number
  bought: number
  synth: number
  synthHQ: number
  synthLQ: number
} {
  let web = 0
  let user = 0
  let bought = 0
  let synth = 0
  let synthHQ = 0
  let synthLQ = 0
  for (const d of DATA_DOMAINS) {
    const s = normalizeDomainStock(data.stocks[d])
    web += s.fromWeb ?? 0
    user += s.fromUser ?? 0
    bought += s.fromBought ?? 0
    synthHQ += s.fromSynthHQ ?? 0
    synthLQ += s.fromSynthLQ ?? 0
    synth += s.fromSynth ?? synthHQ + synthLQ
  }
  return { web, user, bought, synth, synthHQ, synthLQ }
}

export function formatTokens(mTok: number): string {
  if (mTok >= 1_000_000) return `${(mTok / 1_000_000).toFixed(2)}T tok`
  if (mTok >= 1000) return `${(mTok / 1000).toFixed(2)}B tok`
  if (mTok >= 1) return `${mTok.toFixed(2)}M tok`
  return `${(mTok * 1000).toFixed(2)}K tok`
}

/** LQ synth share of a train recipe → capability multiplier (1 = fine, &lt;1 regresses). */
export function lqSynthCapabilityMult(synthLqShare: number): number {
  const s = Math.max(0, Math.min(1, synthLqShare))
  // Up to ~22% capability hit when train mix is all LQ synth
  return 1 - s * (DATA_ECONOMY.lqRegressionMax ?? 0.22)
}
