/* =============================================================================
   /api/enrich  — Serverless proxy (Vercel / Netlify-compatible)
   -----------------------------------------------------------------------------
   WHY THIS EXISTS
   The front-end must never hold your provider API key. The browser calls THIS
   endpoint; this endpoint adds the secret key from an environment variable and
   forwards the request to Proxycurl/Apollo. The key never reaches the client,
   and CORS is handled here.

   DEPLOY (Vercel)
     1. Put this file at /api/enrich.js in your project.
     2. In Vercel project settings → Environment Variables, add:
          PROXYCURL_API_KEY = your_key
          APOLLO_API_KEY    = your_key   (optional)
          ALLOWED_ORIGIN    = https://your-frontend-domain.com
     3. Deploy. Front-end calls fetch("/api/enrich", {...}).

   DEPLOY (Netlify)
     Rename path to /netlify/functions/enrich.js and change the export to
     `exports.handler` style — or just use the Express version (server.js).

   REQUEST  (POST JSON)
     { "provider": "proxycurl", "action": "enrich", "profileUrl": "https://..." }
     { "provider": "proxycurl", "action": "discover", "params": {...} }
   RESPONSE
     Normalized lead object(s) matching the front-end shape.
   ============================================================================= */

const PROVIDERS = {
  proxycurl: {
    keyEnv: "PROXYCURL_API_KEY",
    enrich: async (key, { profileUrl }) => {
      if (!profileUrl) throw badRequest("profileUrl required");
      const url =
        "https://nubela.co/proxycurl/api/v2/linkedin" +
        `?linkedin_profile_url=${encodeURIComponent(profileUrl)}` +
        "&use_cache=if-recent";
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) throw upstream(r.status, await safeText(r));
      return normalizeProxycurl(await r.json(), profileUrl);
    },
    // Discovery via Person Search (LinkDB; US/UK/CA/IL/AU/IE/NZ/SG coverage).
    discover: async (key, { params = {} }) => {
      const qs = new URLSearchParams({ page_size: "10", ...params }).toString();
      const r = await fetch(
        `https://nubela.co/proxycurl/api/v2/search/person?${qs}`,
        { headers: { Authorization: `Bearer ${key}` } }
      );
      if (!r.ok) throw upstream(r.status, await safeText(r));
      const data = await r.json();
      const results = data.results || [];
      // Search returns profile URLs + light fields; enrich each for full data.
      return results.map((x) =>
        normalizeProxycurl(x.profile || x, x.linkedin_profile_url || x.profile_url)
      );
    },
  },

  apollo: {
    keyEnv: "APOLLO_API_KEY",
    // Apollo People Match — stronger India coverage. Fill in fields you need.
    enrich: async (key, { profileUrl, email, name }) => {
      const r = await fetch("https://api.apollo.io/v1/people/match", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": key },
        body: JSON.stringify({ linkedin_url: profileUrl, email, name }),
      });
      if (!r.ok) throw upstream(r.status, await safeText(r));
      return normalizeApollo((await r.json()).person, profileUrl);
    },
    discover: async () => {
      throw badRequest("Apollo discover not implemented — use /v1/mixed_people/search");
    },
  },
};

/* ---- Normalizers: map raw provider data → front-end lead shape ---- */
function normalizeProxycurl(d = {}, url) {
  const activities = d.activities || [];
  return {
    id: url || d.public_identifier || cryptoId(),
    name: d.full_name || `${d.first_name || ""} ${d.last_name || ""}`.trim(),
    headline: d.headline || d.occupation || "",
    followers: d.follower_count || 0,
    country: (d.country || "").toUpperCase(),
    domains: deriveDomains(d),
    pulsePostsLast90: activities.length, // public profiles expose ~10 recent
    avgEngagement: 0, // not provided by Proxycurl; estimate client-side
    profileUrl: url,
    avatarColor: pickColor(d.full_name || url || ""),
  };
}

function normalizeApollo(p = {}, url) {
  return {
    id: url || p.id || cryptoId(),
    name: p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
    headline: p.headline || p.title || "",
    followers: p.linkedin_num_followers || 0,
    country: (p.country || "").toUpperCase(),
    domains: p.industry ? [p.industry] : [],
    pulsePostsLast90: 0,
    avgEngagement: 0,
    profileUrl: url || p.linkedin_url,
    avatarColor: pickColor(p.name || url || ""),
  };
}

/* ---- helpers ---- */
function deriveDomains(d) {
  const out = new Set();
  if (d.industry) out.add(d.industry);
  (d.experiences || []).slice(0, 2).forEach((e) => e.company && out.add(e.company));
  return [...out];
}
function pickColor(seed) {
  const palette = ["#0a66c2", "#1d8a6e", "#b4530a", "#7a3ea3", "#0b6b78", "#a8324a"];
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
function cryptoId() { return "lead-" + Math.random().toString(36).slice(2, 9); }
function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function upstream(status, body) { const e = new Error(`Provider ${status}: ${body}`); e.status = 502; return e; }
async function safeText(r) { try { return await r.text(); } catch { return ""; } }

/* ---- The handler ---- */
export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { provider = "proxycurl", action = "enrich" } = body;

    const p = PROVIDERS[provider];
    if (!p) return res.status(400).json({ error: `Unknown provider: ${provider}` });

    const key = process.env[p.keyEnv];
    if (!key) return res.status(500).json({ error: `Missing env var ${p.keyEnv}` });

    if (!p[action]) return res.status(400).json({ error: `Unknown action: ${action}` });

    const data = await p[action](key, body);
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
