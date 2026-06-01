import React, { useState, useMemo, useCallback } from "react";
import { Search, Users, FileText, TrendingUp, Globe, Download, Filter, Star, Loader2, AlertTriangle, Settings, X, ExternalLink, Mail } from "lucide-react";

/* =============================================================================
   PulseScout — LinkedIn Pulse Influencer Lead Finder
   -----------------------------------------------------------------------------
   ARCHITECTURE
   This is a front-end filtering + scoring + lead-management layer. It does NOT
   scrape LinkedIn directly (that violates LinkedIn ToS and is blocked). Instead
   it talks to a COMPLIANT data provider via the `provider` abstraction below.

   To go live:
     1. Pick a provider (Proxycurl or Apollo are wired as examples).
     2. Put your API key in the Settings panel (stored in component state only —
        for production, proxy calls through YOUR backend so the key is never
        exposed to the browser. See note in fetchFromProvider()).
     3. Switch DATA_MODE from "demo" to "live".

   COVERAGE NOTE
     Proxycurl bulk DISCOVERY (LinkDB) covers US/UK/CA/IL/AU/IE/NZ/SG — NOT India.
     For India, supply known profile URLs to enrich, or use Apollo (better IN
     coverage). The UI exposes both: "Discover" and "Enrich URLs".
   ============================================================================= */

const DOMAINS = [
  "Technology / SaaS", "Artificial Intelligence", "Marketing", "Finance / Fintech",
  "Healthcare", "HR / Recruiting", "Sales", "Cybersecurity", "Data Science",
  "Product Management", "Startups / VC", "Sustainability", "Education", "Real Estate",
];

const COUNTRIES = [
  { code: "US", label: "United States", flag: "🇺🇸", discovery: true },
  { code: "IN", label: "India", flag: "🇮🇳", discovery: false },
];

/* ---- Scoring weights (user picked: all signals, weighted) ---- */
const WEIGHTS = { followers: 0.35, pulse: 0.4, engagement: 0.25 };

function qualifyScore(p) {
  // Normalize each signal to 0–100 then weight. When a signal is unverified
  // (null — e.g. Apollo doesn't supply post activity), it's dropped and the
  // remaining weights are renormalized so the score stays on a 0–100 scale
  // instead of being unfairly dragged down by a missing field.
  const parts = [];
  parts.push([Math.min(100, (p.followers / 20000) * 100), WEIGHTS.followers]);
  if (p.pulsePostsLast90 != null)
    parts.push([Math.min(100, (p.pulsePostsLast90 / 12) * 100), WEIGHTS.pulse]);
  if (p.avgEngagement != null) {
    const eRate = p.avgEngagement / Math.max(p.followers, 1);
    parts.push([Math.min(100, eRate * 4000), WEIGHTS.engagement]); // ~2.5% => 100
  }
  const wSum = parts.reduce((s, [, w]) => s + w, 0) || 1;
  const total = parts.reduce((s, [v, w]) => s + v * (w / wSum), 0);
  return Math.round(total);
}

/* =============================================================================
   PROVIDER ABSTRACTION
   Each provider maps its raw API response into our normalized lead shape:
   { id, name, headline, followers, country, domains[], pulsePostsLast90,
     avgEngagement, profileUrl, avatarColor }
   ============================================================================= */

// Front-end never holds the API key. Live mode calls YOUR backend proxy
// (api/enrich.js on Vercel/Netlify, or server.js Express). The proxy attaches
// the secret key server-side and returns already-normalized lead objects.
// Set this to your deployed proxy path/URL.
const PROXY_URL = "/api/enrich"; // e.g. "https://your-app.vercel.app/api/enrich"

const providers = {
  proxycurl: { label: "Proxycurl (US discovery + enrich)" },
  apollo: { label: "Apollo.io (better India coverage)" },
};

async function proxyEnrich(provider, profileUrl) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, action: "enrich", profileUrl }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Proxy ${res.status}`);
  return json.data;
}

// Credit-free discovery: search Apollo for people matching country + domains.
// Used when the user runs Live search with no URLs to enrich.
async function proxyDiscover(provider, params) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, action: "discover", params }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Proxy ${res.status}`);
  return json.data || [];
}

/* =============================================================================
   DEMO DATA  — realistic sample so the UI is fully usable without a key
   ============================================================================= */
const FIRST = ["Aarav","Priya","Jordan","Maya","Rohan","Elena","Devon","Sana","Marcus","Neha","Olivia","Vikram","Grace","Arjun","Tara","Liam","Ishaan","Chloe","Kabir","Diana"];
const LAST = ["Sharma","Patel","Reyes","Chen","Williams","Mehta","Okafor","Nguyen","Kapoor","Brooks","Iyer","Santos","Bose","Cohen","Rao","Fischer","Verma","Hughes","Nair","Lopez"];

function pickColor(seed) {
  const palette = ["#0a66c2","#1d8a6e","#b4530a","#7a3ea3","#0b6b78","#a8324a","#3d5a14","#5a4a8a"];
  let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function makeDemoData() {
  const rng = (n) => Math.floor(Math.random() * n);
  const out = [];
  for (let i = 0; i < 140; i++) {
    const country = Math.random() > 0.5 ? "US" : "IN";
    const followers = 4000 + rng(46000);
    const name = `${FIRST[rng(FIRST.length)]} ${LAST[rng(LAST.length)]}`;
    const nDomains = 1 + rng(2);
    const domains = [...new Set(Array.from({ length: nDomains }, () => DOMAINS[rng(DOMAINS.length)]))];
    const pulse = rng(18);
    const lead = {
      id: `demo-${i}`,
      name,
      headline: `${domains[0]} Leader · Writes weekly on LinkedIn`,
      followers,
      country,
      domains,
      pulsePostsLast90: pulse,
      avgEngagement: Math.floor(followers * (0.004 + Math.random() * 0.03)),
      profileUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, "-")}-${i}`,
      avatarColor: pickColor(name),
    };
    out.push(lead);
  }
  return out;
}

const DEMO = makeDemoData();

/* ============================================================================= */

export default function PulseScout() {
  const [country, setCountry] = useState("US");
  const [selectedDomains, setSelectedDomains] = useState([]);
  const [minFollowers, setMinFollowers] = useState(0);
  const [minPulse, setMinPulse] = useState(2);
  const [minScore, setMinScore] = useState(0);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [provider, setProvider] = useState("proxycurl");
  const [dataMode, setDataMode] = useState("demo");
  const [urlInput, setUrlInput] = useState("");
  const [enrichingId, setEnrichingId] = useState(null);

  // Enrich a single lead by its LinkedIn URL (costs 1 Apollo credit).
  // Used by the "Reveal email" button on each lead card.
  const enrichLead = useCallback(async (lead) => {
    if (!lead.profileUrl) {
      alert(
        "No LinkedIn URL on this lead — Apollo's free search doesn't include it. " +
        "Find the person's LinkedIn URL manually, paste it into the URL box above, and run a fresh search."
      );
      return;
    }
    if (!window.confirm(`Reveal full data for ${lead.name}? This spends 1 Apollo credit.`)) return;
    setEnrichingId(lead.id);
    try {
      const full = await proxyEnrich(provider, lead.profileUrl);
      // Merge enriched fields back into the existing lead, recompute score.
      setResults((prev) =>
        prev.map((r) => {
          if (r.id !== lead.id) return r;
          const merged = { ...r, ...full };
          merged.score = qualifyScore(merged);
          return merged;
        })
      );
    } catch (e) {
      alert("Enrich failed: " + e.message);
    } finally {
      setEnrichingId(null);
    }
  }, [provider]);

  const toggleDomain = (d) =>
    setSelectedDomains((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const runSearch = useCallback(async () => {
    setLoading(true);
    setHasSearched(true);
    try {
      let leads = [];
      if (dataMode === "demo") {
        await new Promise((r) => setTimeout(r, 650));
        leads = DEMO;
      } else {
        const urls = urlInput.split(/\s+/).filter(Boolean);
        if (urls.length) {
          // ENRICH path: user pasted profile URLs → look each up (costs 1 credit each)
          leads = await Promise.all(
            urls.map((u) => proxyEnrich(provider, u).catch(() => null))
          );
          leads = leads.filter(Boolean);
        } else {
          // DISCOVER path: no URLs → search the provider by country + domains.
          // Apollo's search endpoint is credit-free.
          leads = await proxyDiscover(provider, {
            country,
            domains: selectedDomains,
          });
        }
      }
      const scored = leads
        .map((l) => ({ ...l, score: qualifyScore(l) }))
        // Country: keep leads with no country set (Apollo discover doesn't supply it).
        // Only filter out leads whose country is set AND doesn't match.
        .filter((l) => !l.country || l.country === country)
        // Followers: keep leads with no follower count (Apollo discover doesn't supply it).
        .filter((l) => !l.followers || l.followers >= minFollowers)
        .filter((l) => l.pulsePostsLast90 == null || l.pulsePostsLast90 >= minPulse)
        .filter((l) => l.score >= minScore)
        .filter((l) => selectedDomains.length === 0 || l.domains.some((d) => selectedDomains.includes(d)))
        .sort((a, b) => b.score - a.score);
      setResults(scored);
    } catch (e) {
      alert(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [dataMode, country, minFollowers, minPulse, minScore, selectedDomains, provider, urlInput]);

  const exportCSV = () => {
    const head = ["Name", "Email", "Headline", "Company", "Followers", "Country", "Domains", "Pulse posts (90d)", "Avg engagement", "Score", "Profile URL"];
    const rows = results.map((r) => [
      r.name, r.email || "", r.headline, r.company || "", r.followers, r.country, r.domains.join(" | "),
      r.pulsePostsLast90 ?? "unverified", r.avgEngagement ?? "unverified", r.score, r.profileUrl,
    ]);
    const csv = [head, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pulsescout-leads.csv";
    a.click();
  };

  const stats = useMemo(() => {
    if (!results.length) return null;
    const totalFollowers = results.reduce((s, r) => s + r.followers, 0);
    const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
    return { count: results.length, totalFollowers, avgScore };
  }, [results]);

  return (
    <div style={S.app}>
      <style>{KEYFRAMES}</style>

      {/* ---- Header ---- */}
      <header style={S.header}>
        <div style={S.brandRow}>
          <div style={S.logo}>
            <div style={S.logoMark}>P</div>
            <div>
              <h1 style={S.brandName}>PulseScout</h1>
              <p style={S.brandTag}>LinkedIn Pulse influencer leads, scored & sorted</p>
            </div>
          </div>
          <button style={S.iconBtn} onClick={() => setShowSettings(true)} aria-label="Settings">
            <Settings size={18} /> <span style={{ fontSize: 13 }}>Data source</span>
          </button>
        </div>
        <div style={S.modeBadge(dataMode === "demo")}>
          {dataMode === "demo" ? "DEMO DATA — using sample leads" : `LIVE — ${providers[provider].label}`}
        </div>
      </header>

      <div style={S.layout}>
        {/* ---- Filter panel ---- */}
        <aside style={S.panel}>
          <div style={S.panelHead}><Filter size={15} /> Filters</div>

          <label style={S.label}>Country</label>
          <div style={S.countryRow}>
            {COUNTRIES.map((c) => (
              <button key={c.code}
                onClick={() => setCountry(c.code)}
                style={S.countryBtn(country === c.code)}>
                <span style={{ fontSize: 18 }}>{c.flag}</span> {c.label}
                {!c.discovery && <span style={S.noDisc}>enrich only</span>}
              </button>
            ))}
          </div>

          <label style={S.label}>Domains <span style={S.muted}>(any match)</span></label>
          <div style={S.domainGrid}>
            {DOMAINS.map((d) => (
              <button key={d} onClick={() => toggleDomain(d)} style={S.chip(selectedDomains.includes(d))}>
                {d}
              </button>
            ))}
          </div>

          <label style={S.label}>Min followers: <b>{minFollowers.toLocaleString()}</b></label>
          <input type="range" min={0} max={50000} step={500}
            value={minFollowers} onChange={(e) => setMinFollowers(+e.target.value)} style={S.range} />

          <label style={S.label}>Min Pulse posts (90d): <b>{minPulse}</b></label>
          <input type="range" min={0} max={15} value={minPulse}
            onChange={(e) => setMinPulse(+e.target.value)} style={S.range} />

          <label style={S.label}>Min qualify score: <b>{minScore}</b></label>
          <input type="range" min={0} max={100} value={minScore}
            onChange={(e) => setMinScore(+e.target.value)} style={S.range} />

          {dataMode === "live" && (
            <>
              <label style={S.label}>Profile URLs to enrich <span style={S.muted}>(one per line)</span></label>
              <textarea value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://www.linkedin.com/in/..." style={S.textarea} rows={4} />
            </>
          )}

          <button style={S.searchBtn} onClick={runSearch} disabled={loading}>
            {loading ? <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /> : <Search size={18} />}
            {loading ? "Searching…" : "Find influencers"}
          </button>
        </aside>

        {/* ---- Results ---- */}
        <main style={S.main}>
          {stats && (
            <div style={S.statsRow}>
              <Stat icon={<Users size={16} />} label="Leads" value={stats.count} />
              <Stat icon={<Globe size={16} />} label="Combined reach" value={stats.totalFollowers.toLocaleString()} />
              <Stat icon={<Star size={16} />} label="Avg score" value={stats.avgScore} />
              <button style={S.exportBtn} onClick={exportCSV}><Download size={15} /> Export CSV</button>
            </div>
          )}

          {!hasSearched && <Empty />}
          {hasSearched && !loading && results.length === 0 && (
            <div style={S.noResults}>No leads matched. Loosen filters or switch country.</div>
          )}

          <div style={S.cardGrid}>
            {results.map((r, i) => (
              <LeadCard
                key={r.id}
                lead={r}
                index={i}
                onEnrich={dataMode === "live" ? () => enrichLead(r) : null}
                isEnriching={enrichingId === r.id}
              />
            ))}
          </div>
        </main>
      </div>

      {showSettings && (
        <SettingsModal
          {...{ provider, setProvider, dataMode, setDataMode }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

/* ---- Sub-components ---- */
function Stat({ icon, label, value }) {
  return (
    <div style={S.stat}>
      <div style={S.statIcon}>{icon}</div>
      <div><div style={S.statValue}>{value}</div><div style={S.statLabel}>{label}</div></div>
    </div>
  );
}

function scoreColor(s) {
  if (s >= 75) return "#1d8a6e";
  if (s >= 50) return "#b4530a";
  return "#8a8a8a";
}

function LeadCard({ lead, index, onEnrich, isEnriching }) {
  const initials = (lead.name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("");
  return (
    <div style={{ ...S.card, animationDelay: `${Math.min(index, 12) * 40}ms` }}>
      <div style={S.cardTop}>
        <div style={{ ...S.avatar, background: lead.avatarColor }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.cardName}>{lead.name}{lead.company ? ` · ${lead.company}` : ""}</div>
          <div style={S.cardHeadline}>{lead.headline}</div>
        </div>
        <div style={{ ...S.scoreBadge, color: scoreColor(lead.score), borderColor: scoreColor(lead.score) }}>
          {lead.score}
        </div>
      </div>
      <div style={S.metrics}>
        <Metric icon={<Users size={13} />} v={lead.followers ? lead.followers.toLocaleString() : "—"} l="followers" />
        <Metric icon={<FileText size={13} />} v={lead.pulsePostsLast90 ?? "—"} l="posts/90d" />
        <Metric icon={<TrendingUp size={13} />} v={lead.avgEngagement != null ? lead.avgEngagement.toLocaleString() : "—"} l="avg eng." />
      </div>
      {lead.email && (
        <div style={S.emailRow} title={lead.email}>
          <Mail size={13} /> <span style={S.emailText}>{lead.email}</span>
        </div>
      )}
      <div style={S.tagRow}>
        {lead.domains.map((d) => <span key={d} style={S.tag}>{d}</span>)}
      </div>
      <div style={S.cardActions}>
        {lead.profileUrl ? (
          <a href={lead.profileUrl} target="_blank" rel="noreferrer" style={S.profileLink}>
            View <ExternalLink size={13} />
          </a>
        ) : (
          <span style={{ ...S.profileLink, opacity: 0.4, cursor: "default" }}>No URL</span>
        )}
        {onEnrich && !lead.email && (
          <button
            style={{ ...S.enrichBtn, opacity: isEnriching ? 0.6 : 1 }}
            onClick={onEnrich}
            disabled={isEnriching}
          >
            {isEnriching ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Mail size={13} />}
            {isEnriching ? "Revealing…" : "Reveal email (1 credit)"}
          </button>
        )}
      </div>
    </div>
  );
}

function Metric({ icon, v, l }) {
  return (
    <div style={S.metric}>
      <div style={S.metricTop}>{icon}<span style={S.metricVal}>{v}</span></div>
      <div style={S.metricLabel}>{l}</div>
    </div>
  );
}

function Empty() {
  return (
    <div style={S.empty}>
      <div style={S.emptyMark}>P</div>
      <h2 style={{ margin: "16px 0 6px", fontFamily: "Georgia, serif" }}>Find your next Pulse voices</h2>
      <p style={{ color: "#6b6b6b", maxWidth: 380, lineHeight: 1.5 }}>
        Pick a country and domains, set your thresholds, and hit search. Leads are
        scored on followers, posting consistency, and engagement.
      </p>
    </div>
  );
}

function SettingsModal({ provider, setProvider, dataMode, setDataMode, onClose }) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <h3 style={{ margin: 0 }}>Data source</h3>
          <button style={S.closeBtn} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={S.warn}>
          <AlertTriangle size={16} />
          <span>Your API key lives in the backend proxy (env var), never in the browser.
            Live mode calls <code>{`/api/enrich`}</code>; deploy the proxy and set
            PROXYCURL_API_KEY / APOLLO_API_KEY there.</span>
        </div>
        <label style={S.label}>Mode</label>
        <div style={S.countryRow}>
          <button style={S.countryBtn(dataMode === "demo")} onClick={() => setDataMode("demo")}>Demo data</button>
          <button style={S.countryBtn(dataMode === "live")} onClick={() => setDataMode("live")}>Live API</button>
        </div>
        <label style={S.label}>Provider</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} style={S.select}>
          {Object.entries(providers).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <button style={S.searchBtn} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/* ---- Styles ---- */
const ACCENT = "#0a66c2";
const INK = "#1a1d23";
const S = {
  app: { fontFamily: "'Helvetica Neue', Arial, sans-serif", background: "#f4f2ed", minHeight: "100vh", color: INK },
  header: { background: "#fff", borderBottom: "1px solid #e3e0d8", padding: "16px 24px" },
  brandRow: { display: "flex", justifyContent: "space-between", alignItems: "center", maxWidth: 1200, margin: "0 auto" },
  logo: { display: "flex", gap: 12, alignItems: "center" },
  logoMark: { width: 40, height: 40, borderRadius: 10, background: ACCENT, color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 22, fontFamily: "Georgia, serif" },
  brandName: { margin: 0, fontSize: 22, fontFamily: "Georgia, serif", letterSpacing: -0.5 },
  brandTag: { margin: 0, fontSize: 12.5, color: "#777" },
  iconBtn: { display: "flex", gap: 6, alignItems: "center", background: "#f4f2ed", border: "1px solid #e3e0d8", borderRadius: 8, padding: "8px 12px", cursor: "pointer", color: INK },
  modeBadge: (demo) => ({ maxWidth: 1200, margin: "10px auto 0", fontSize: 11.5, fontWeight: 700, letterSpacing: 0.5, color: demo ? "#b4530a" : "#1d8a6e", textAlign: "right" }),
  layout: { display: "flex", gap: 20, maxWidth: 1200, margin: "0 auto", padding: 24, alignItems: "flex-start" },
  panel: { width: 290, flexShrink: 0, background: "#fff", border: "1px solid #e3e0d8", borderRadius: 14, padding: 18, position: "sticky", top: 24 },
  panelHead: { display: "flex", gap: 7, alignItems: "center", fontWeight: 700, fontSize: 14, marginBottom: 14 },
  label: { display: "block", fontSize: 12.5, fontWeight: 600, margin: "16px 0 7px", color: "#444" },
  muted: { fontWeight: 400, color: "#999" },
  countryRow: { display: "flex", gap: 8 },
  countryBtn: (on) => ({ flex: 1, display: "flex", flexDirection: "column", gap: 2, alignItems: "center", padding: "9px 6px", borderRadius: 9, border: `1.5px solid ${on ? ACCENT : "#e3e0d8"}`, background: on ? "#eaf2fb" : "#fff", color: on ? ACCENT : INK, cursor: "pointer", fontSize: 12.5, fontWeight: 600 }),
  noDisc: { fontSize: 9, color: "#b4530a", fontWeight: 700 },
  domainGrid: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: (on) => ({ padding: "5px 9px", borderRadius: 20, border: `1.5px solid ${on ? ACCENT : "#e3e0d8"}`, background: on ? ACCENT : "#fff", color: on ? "#fff" : "#555", fontSize: 11.5, cursor: "pointer", fontWeight: 500 }),
  range: { width: "100%", accentColor: ACCENT },
  textarea: { width: "100%", boxSizing: "border-box", border: "1px solid #e3e0d8", borderRadius: 8, padding: 9, fontSize: 12, fontFamily: "monospace", resize: "vertical" },
  searchBtn: { width: "100%", marginTop: 18, display: "flex", gap: 8, alignItems: "center", justifyContent: "center", background: ACCENT, color: "#fff", border: "none", borderRadius: 10, padding: "12px", fontSize: 14.5, fontWeight: 700, cursor: "pointer" },
  main: { flex: 1, minWidth: 0 },
  statsRow: { display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap", alignItems: "center" },
  stat: { display: "flex", gap: 10, alignItems: "center", background: "#fff", border: "1px solid #e3e0d8", borderRadius: 11, padding: "11px 16px" },
  statIcon: { color: ACCENT },
  statValue: { fontWeight: 800, fontSize: 17, fontFamily: "Georgia, serif" },
  statLabel: { fontSize: 11, color: "#888" },
  exportBtn: { marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", background: "#1d8a6e", color: "#fff", border: "none", borderRadius: 9, padding: "10px 14px", fontWeight: 600, cursor: "pointer", fontSize: 13 },
  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 14 },
  card: { background: "#fff", border: "1px solid #e3e0d8", borderRadius: 14, padding: 16, animation: "rise .4s ease both" },
  cardTop: { display: "flex", gap: 11, alignItems: "flex-start" },
  avatar: { width: 42, height: 42, borderRadius: "50%", color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 15, flexShrink: 0 },
  cardName: { fontWeight: 700, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  cardHeadline: { fontSize: 12, color: "#777", lineHeight: 1.35, marginTop: 2 },
  scoreBadge: { width: 38, height: 38, borderRadius: 9, border: "2px solid", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 15, flexShrink: 0 },
  metrics: { display: "flex", gap: 8, margin: "14px 0 12px" },
  metric: { flex: 1, background: "#f7f5f0", borderRadius: 9, padding: "8px 6px", textAlign: "center" },
  metricTop: { display: "flex", gap: 4, alignItems: "center", justifyContent: "center", color: ACCENT },
  metricVal: { fontWeight: 700, fontSize: 13, color: INK },
  metricLabel: { fontSize: 10, color: "#999", marginTop: 2 },
  tagRow: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 },
  tag: { fontSize: 10.5, background: "#eaf2fb", color: ACCENT, padding: "3px 8px", borderRadius: 6, fontWeight: 600 },
  profileLink: { flex: 1, display: "flex", gap: 5, alignItems: "center", justifyContent: "center", fontSize: 13, color: ACCENT, textDecoration: "none", fontWeight: 600, padding: "8px", border: "1px solid #e3e0d8", borderRadius: 8 },
  cardActions: { display: "flex", gap: 8 },
  enrichBtn: { flex: 1, display: "flex", gap: 5, alignItems: "center", justifyContent: "center", fontSize: 12, color: "#fff", background: "#1d8a6e", border: "none", borderRadius: 8, padding: "8px", fontWeight: 600, cursor: "pointer" },
  emailRow: { display: "flex", gap: 6, alignItems: "center", background: "#eaf8f1", color: "#0a5d44", padding: "6px 10px", borderRadius: 7, fontSize: 12, marginBottom: 10, fontWeight: 600 },
  emailText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  empty: { textAlign: "center", padding: "70px 20px", display: "flex", flexDirection: "column", alignItems: "center" },
  emptyMark: { width: 60, height: 60, borderRadius: 16, background: ACCENT, color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 30, fontFamily: "Georgia, serif" },
  noResults: { background: "#fff", border: "1px dashed #d0ccc2", borderRadius: 12, padding: 40, textAlign: "center", color: "#888" },
  overlay: { position: "fixed", inset: 0, background: "rgba(20,18,14,.45)", display: "grid", placeItems: "center", zIndex: 50, padding: 20 },
  modal: { background: "#fff", borderRadius: 16, padding: 24, width: "100%", maxWidth: 440 },
  modalHead: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  closeBtn: { background: "none", border: "none", cursor: "pointer", color: "#888" },
  warn: { display: "flex", gap: 9, background: "#fdf3e7", border: "1px solid #f0d9b8", borderRadius: 9, padding: 11, fontSize: 12, color: "#7a4a10", margin: "14px 0", lineHeight: 1.4 },
  select: { width: "100%", boxSizing: "border-box", padding: 10, borderRadius: 8, border: "1px solid #e3e0d8", fontSize: 13 },
  input: { width: "100%", boxSizing: "border-box", padding: 10, borderRadius: 8, border: "1px solid #e3e0d8", fontSize: 13 },
};

const KEYFRAMES = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  input[type=range]::-webkit-slider-thumb { cursor: pointer; }
`;
