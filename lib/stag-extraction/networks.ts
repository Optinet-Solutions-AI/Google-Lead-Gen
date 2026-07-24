/**
 * [LGP-088] Per-affiliate-network extractor library.
 *
 * Ordered catalog of the affiliate networks we see in the wild plus
 * the extraction signatures (URL params, cookies, tracker hosts) that
 * identify them. Ordered so the FIRST matcher wins — put the more-
 * specific signatures at the top so `iaID` doesn't accidentally match
 * a generic `id=` URL, etc.
 *
 * WHAT LIVES HERE VS THE LEGACY LIB:
 *   - lib/stag-extraction/extract.ts still owns the "walk the HTML,
 *     follow redirects, parse params" pipeline for backwards-compat.
 *   - This file adds the DATA that a v2 pipeline can use: which
 *     network is this, what's their cookie name, what does the value
 *     look like. Both the URL-param path and the (new) cookie-drop
 *     path consult this registry.
 *
 * ADDING A NETWORK:
 *   1. Look at 5+ example URLs / cookie dumps and figure out the
 *      signature — is it a distinctive host, a param name, a cookie
 *      name?
 *   2. Add an entry with the matcher + label. Verify one of the
 *      matchers is unique enough that we don't get false positives.
 *   3. Bump the `known_by_us` note so the recommendation memo can
 *      cite growing coverage.
 */

export type AffiliateNetwork = {
  /** Short slug used as source_param label on s_tag rows when this
   *  network wins. */
  key: string
  /** Human-readable name for logs + memo. */
  name: string
  /** URL-param names to try in order. First non-empty wins. */
  urlParams: string[]
  /** Cookie names dropped on the affiliate site that carry the tag.
   *  Empty array = URL-only tracking (cookies won't help). */
  cookieNames: string[]
  /** Regexes matching tracker/redirect hosts (host or endsWith host).
   *  Used to say "this redirect went through Cellxpert therefore we
   *  should extract with the Cellxpert extractor even if the URL
   *  landed on the operator's own domain." */
  trackerHosts: RegExp[]
  /** Optional: shape validator for a candidate tag value. Keeps us
   *  from accepting `1` as the affiliate id when a real Cellxpert
   *  cxd is a 30+ char alphanumeric. */
  valueShape?: RegExp
  /** How common we see it (rough share of successes today). Kept as
   *  a comment for memo work. */
  knownByUs: number
  notes?: string
}

/**
 * Ordered list. Match-first-wins so signatures with the tightest
 * uniqueness live at the top.
 */
export const AFFILIATE_NETWORKS: ReadonlyArray<AffiliateNetwork> = [
  {
    key: 'cellxpert',
    name: 'Cellxpert',
    urlParams: ['cxd', 'clickid'],
    cookieNames: ['cxd', 'cxd_offer_id', 'cxd_click_id', 'cellxpert_click', 'affid'],
    trackerHosts: [/\.cellxpert\.com$/, /^cellxpert\.com$/, /cxrtb\.com/],
    valueShape: /^[a-zA-Z0-9._-]{6,64}$/,
    knownByUs: 0.08,
    notes: 'Common on casino operators. cxd is the click-scope tag; cxd_offer_id names the campaign.',
  },
  {
    key: 'income_access',
    name: 'Income Access',
    urlParams: ['iaID', 'aff', 'sub_aff', 'ia_partner'],
    cookieNames: ['ias_partner', 'IAS_PART', 'iaid', 'iaClickId'],
    trackerHosts: [/\.iaservicecommunity\.com$/, /\.ia-clk\.com$/, /\.income-access\.com$/],
    knownByUs: 0.06,
    notes:
      'Owned by Paysafe. Big on Canadian and European operators. iaID is the partner id, sub_aff is the campaign.',
  },
  {
    key: 'myaffiliates',
    name: 'MyAffiliates',
    urlParams: ['btag', 'bta', 'affiliate_id'],
    cookieNames: ['ma_click_id', 'ma_visit', 'bta', 'btag_cookie'],
    trackerHosts: [/\.myaffiliates\.com$/, /\.smartaffiliates\.com$/, /\.affilka\.live$/],
    knownByUs: 0.24,
    notes:
      'HIGHEST-share extractor in our data (24% of successes via btag). Widely used on European casinos. Affilka is the newer rebrand.',
  },
  {
    key: 'netrefer',
    name: 'NetRefer',
    urlParams: ['btag', 'nrid', 'affid', 'placeholder'],
    cookieNames: ['nrClickId', 'nr_pid', 'nr_bta'],
    trackerHosts: [/\.netrefer\.com$/, /\.trckcelbet\.com$/],
    valueShape: /^[a-zA-Z0-9_-]{4,64}$/,
    knownByUs: 0.03,
    notes:
      'btag collision with MyAffiliates — disambiguate by tracker host or by cookie shape.',
  },
  {
    key: 'post_affiliate_pro',
    name: 'Post Affiliate Pro',
    urlParams: ['a_aid', 'AffiliateID', 'a_bid', 'AffiliateID2'],
    cookieNames: ['papVisitorId', 'PAPVisitorId', 'PAPCookie_Visit', 'a_aid'],
    trackerHosts: [/\.postaffiliatepro\.com$/, /\/scripts\/[a-z0-9]{4,}\/pap\.js/],
    knownByUs: 0.02,
    notes:
      'Common on smaller operators. Distinctive cookie prefix "PAP" makes cookie-drop extraction very reliable.',
  },
  {
    key: 'hasoffers',
    name: 'HasOffers / TUNE',
    urlParams: ['offer_id', 'aff_id', 'transaction_id', 'aff_sub'],
    cookieNames: ['aff_sub_id', 'hasoffers_aff', 'transaction_id'],
    trackerHosts: [/\.go2cloud\.org$/, /\.hasoffers\.com$/, /\.tune\.com$/, /\.hasoffers\.net$/],
    knownByUs: 0.02,
  },
  {
    key: 'everflow',
    name: 'Everflow',
    urlParams: ['ef_id', 'offer_id', 'transaction_id', 'oid'],
    cookieNames: ['ef_click', '_ef_click', 'ef_transaction_id'],
    trackerHosts: [/\.everflowclient\.io$/, /\.evfl\.io$/, /\.everflow\.io$/],
    knownByUs: 0.02,
    notes: 'Modern successor to HasOffers. Growing share on newer casinos.',
  },
  {
    key: 'impact',
    name: 'Impact (impact.com)',
    urlParams: ['irclickid', 'clickid', 'sharedid'],
    cookieNames: ['iradmc', '_impact_id', 'ir_click_id'],
    trackerHosts: [/\.impactradius\.com$/, /\.impact\.com$/, /\.7eer\.net$/, /\.impctcdn\.com$/],
    valueShape: /^[a-zA-Z0-9]{12,64}$/,
    knownByUs: 0.02,
    notes: 'irclickid is very distinctive — no other network uses that param name.',
  },
  {
    key: 'commissionjunction',
    name: 'CJ Affiliate',
    urlParams: ['PID', 'AID', 'sid'],
    cookieNames: ['cje', 'cj_user', 'cjevent'],
    trackerHosts: [/\.anrdoezrs\.net$/, /\.dpbolvw\.net$/, /\.tkqlhce\.com$/, /\.commission-junction\.com$/],
    knownByUs: 0.01,
    notes:
      'Legacy but still around. tkqlhce.com / dpbolvw.net are recognizable if you spot them in redirect chains.',
  },
  {
    key: 'rakuten',
    name: 'Rakuten Advertising',
    urlParams: ['ranMID', 'ranEAID', 'ranSiteID'],
    cookieNames: ['ranMID', 'r_ranPID', 'ranSiteID'],
    trackerHosts: [/\.linksynergy\.com$/, /\.rakutenadvertising\.com$/],
    knownByUs: 0.005,
  },
  {
    key: 'kwanko',
    name: 'Kwanko / Netaffiliation',
    urlParams: ['ns_source', 'ns_campaign', 'noc_aff'],
    cookieNames: ['kwanko_click', 'ktag'],
    trackerHosts: [/\.trackink\.com$/, /\.netaffiliation\.com$/, /\.tradedoubler\.com$/],
    knownByUs: 0.005,
  },
  {
    key: 'admitad',
    name: 'Admitad',
    urlParams: ['admitad_uid', 'ad_id'],
    cookieNames: ['aduid', '_asc'],
    trackerHosts: [/\.admitad\.com$/, /\.lenkmio\.com$/],
    knownByUs: 0.005,
  },
  // Generic / legacy fallback — matches the params in the current
  // STAG_PARAM_ORDER, kept last so specific networks win when they
  // can.
  {
    key: 'generic_stag',
    name: 'Generic stag/affid fallback',
    urlParams: ['stag', 'affid', 'mid', 'aff', 'ref', 'affiliate_id'],
    cookieNames: ['stag', 'affid', 'aff_id', 'affiliate_id'],
    trackerHosts: [],
    knownByUs: 0.53,
    notes:
      'Catch-all for the current pipeline. High share because most of our historical extractions land here without a network being identified. Once the specific networks above are wired up, this share should shrink dramatically.',
  },
]

/**
 * Fast lookup: find the network that owns a URL-param name. Returns
 * null if no known network claims it — caller can still try generic
 * extraction with lib/stag-extraction/extract.ts.
 */
export function networkForUrlParam(param: string): AffiliateNetwork | null {
  const lower = param.toLowerCase()
  for (const n of AFFILIATE_NETWORKS) {
    for (const p of n.urlParams) {
      if (p.toLowerCase() === lower) return n
    }
  }
  return null
}

/**
 * Fast lookup: find the network that owns a cookie name. Same semantic
 * as networkForUrlParam.
 */
export function networkForCookie(name: string): AffiliateNetwork | null {
  const lower = name.toLowerCase()
  for (const n of AFFILIATE_NETWORKS) {
    for (const c of n.cookieNames) {
      if (c.toLowerCase() === lower) return n
    }
  }
  return null
}

/**
 * Fast lookup: find the network by tracker host in a URL. Handles
 * host === match or endsWith(.match). Undefined return = we don't
 * recognize this host as an affiliate tracker.
 */
export function networkForHost(url: string): AffiliateNetwork | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  for (const n of AFFILIATE_NETWORKS) {
    for (const rx of n.trackerHosts) {
      if (rx.test(host)) return n
    }
  }
  return null
}
