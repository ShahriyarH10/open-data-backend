const express = require("express");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 300 });
app.use(cors({
  origin: [
    "https://open-data-frontend.onrender.com/",
    "http://localhost:3000",
    "http://localhost:5173",
    /\.vercel\.app$/,
    /\.pages\.dev$/,          // Cloudflare Pages preview URLs
    /\.cloudflare\.com$/,     // Cloudflare custom domains
    "https://open-data-frontend.pages.dev", // Cloudflare production
    process.env.FRONTEND_URL,
  ].filter(Boolean),
}));
app.use(express.json());

// ─── Safe fetch helper ────────────────────────────────────────────────────────
async function safeFetch(url, { timeout = 13000, headers = {} } = {}, label = "?") {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { Accept: "application/json", "User-Agent": "OpenDataSearch/1.0", ...headers },
  });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  if (!ct.includes("json")) {
    const txt = await res.text();
    throw new Error(`${label} non-JSON: ${txt.slice(0, 80)}`);
  }
  return res.json();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Safely coerce any value to a plain string
function str(v, limit = 500) {
  if (!v) return "";
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim().slice(0, limit);
  if (typeof v === "object") {
    const s = v.en || v.fr || v.de || v.nl || Object.values(v).find(x => typeof x === "string") || "";
    return s.replace(/\s+/g, " ").trim().slice(0, limit);
  }
  return String(v).slice(0, limit);
}

// ─── Query builders ──────────────────────────────────────────────────────────
// For CKAN/Solr: single word → plain, multi-word → phrase + term fallback
function buildCKANQuery(raw) {
  const q = raw.trim();
  const words = q.split(/\s+/);
  if (words.length === 1) return q;
  const phrase = `title:"${q}" text:"${q}"`;
  const terms  = words.map(w => `title:${w}`).join(" ");
  return `(${phrase}) OR (${terms})`;
}

// Generic CKAN package_search — uses smart Solr phrase query for multi-word searches
async function fetchCKAN(baseUrl, query, limit, sourceKey, extraHeaders = {}) {
  const q = buildCKANQuery(query);
  const url = `${baseUrl}/api/3/action/package_search?q=${encodeURIComponent(q)}&rows=${limit}`;
  const json = await safeFetch(url, { timeout: 14000, headers: extraHeaders }, sourceKey);
  return (json.result?.results || []).map(i => normalizeCKAN(sourceKey, i));
}

// ─── Source metadata ──────────────────────────────────────────────────────────
const SOURCE_META = {
  us:      { label:"data.gov",           flag:"🇺🇸", country:"United States",  urlBase:"https://catalog.data.gov/dataset/" },
  eu:      { label:"data.europa.eu",     flag:"🇪🇺", country:"European Union", urlBase:"https://data.europa.eu/data/datasets/" },
  uk:      { label:"data.gov.uk",        flag:"🇬🇧", country:"United Kingdom", urlBase:"https://data.gov.uk/dataset/" },
  ca:      { label:"open.canada.ca",     flag:"🇨🇦", country:"Canada",         urlBase:"https://open.canada.ca/data/en/dataset/" },
  au:      { label:"data.gov.au",        flag:"🇦🇺", country:"Australia",      urlBase:"https://data.gov.au/dataset/" },
  de:      { label:"govdata.de",         flag:"🇩🇪", country:"Germany",        urlBase:"https://www.govdata.de/ckan/dataset/" },
  fr:      { label:"data.gouv.fr",       flag:"🇫🇷", country:"France",         urlBase:"https://www.data.gouv.fr/en/datasets/" },
  nl:      { label:"data.overheid.nl",   flag:"🇳🇱", country:"Netherlands",    urlBase:"https://data.overheid.nl/dataset/" },
  it:      { label:"dati.gov.it",        flag:"🇮🇹", country:"Italy",          urlBase:"https://www.dati.gov.it/view-dataset/dataset?id=" },
  es:      { label:"datos.gob.es",       flag:"🇪🇸", country:"Spain",          urlBase:"https://datos.gob.es/en/catalogo/" },
  br:      { label:"dados.gov.br",       flag:"🇧🇷", country:"Brazil",         urlBase:"https://dados.gov.br/dados/conjuntos-dados/" },
  mx:      { label:"datos.gob.mx",       flag:"🇲🇽", country:"Mexico",         urlBase:"https://datos.gob.mx/busca/dataset/" },
  ar:      { label:"datos.gob.ar",       flag:"🇦🇷", country:"Argentina",      urlBase:"https://datos.gob.ar/dataset/" },
  in:      { label:"data.gov.in",        flag:"🇮🇳", country:"India",          urlBase:"https://data.gov.in/catalog/" },
  jp:      { label:"data.go.jp",         flag:"🇯🇵", country:"Japan",          urlBase:"https://www.data.go.jp/data/dataset/" },
  sg:      { label:"data.gov.sg",        flag:"🇸🇬", country:"Singapore",      urlBase:"https://data.gov.sg/datasets/" },
  nz:      { label:"data.govt.nz",       flag:"🇳🇿", country:"New Zealand",    urlBase:"https://catalogue.data.govt.nz/dataset/" },
  za:      { label:"data.gov.za",        flag:"🇿🇦", country:"South Africa",   urlBase:"https://data.gov.za/dataset/" },
  ke:      { label:"opendata.go.ke",     flag:"🇰🇪", country:"Kenya",          urlBase:"https://www.opendata.go.ke/dataset/" },
  pk:      { label:"data.gov.pk",        flag:"🇵🇰", country:"Pakistan",       urlBase:"https://data.gov.pk/dataset/" },
  wb:      { label:"World Bank",         flag:"🌍",  country:"Global",         urlBase:"https://data.worldbank.org/indicator/" },
  hf:      { label:"Hugging Face",       flag:"🤗",  country:"Global",         urlBase:"https://huggingface.co/datasets/" },
  zenodo:  { label:"Zenodo",             flag:"🔬",  country:"Global",         urlBase:"https://zenodo.org/records/" },
  kaggle:  { label:"Kaggle",             flag:"📊",  country:"Global",         urlBase:"https://www.kaggle.com/datasets/" },
  harvard: { label:"Harvard Dataverse",  flag:"🎓",  country:"Global",         urlBase:"https://dataverse.harvard.edu/dataset.xhtml?persistentId=" },
  who:     { label:"WHO",                flag:"🏥",  country:"Global",         urlBase:"https://www.who.int/data/gho/data/indicators/indicator-details/GHO/" },
  figshare:{ label:"Figshare",           flag:"📁",  country:"Global",         urlBase:"https://figshare.com/articles/" },
  dryad:   { label:"Dryad",              flag:"🌿",  country:"Global",         urlBase:"https://datadryad.org/stash/dataset/" },
  openml:  { label:"OpenML",             flag:"🤖",  country:"Global",         urlBase:"https://www.openml.org/search?type=data&id=" },
  gbif:    { label:"GBIF",               flag:"🦋",  country:"Global",         urlBase:"https://www.gbif.org/dataset/" },
  osf:     { label:"OSF",                flag:"📂",  country:"Global",         urlBase:"https://osf.io/" },
  pangaea: { label:"PANGAEA",            flag:"🌊",  country:"Global",         urlBase:"https://doi.pangaea.de/" },
  icpsr:   { label:"ICPSR",              flag:"📚",  country:"Global",         urlBase:"https://www.icpsr.umich.edu/web/ICPSR/studies/" },
  nasa:    { label:"NASA",               flag:"🚀",  country:"Global",         urlBase:"https://data.nasa.gov/dataset/" },
  uci:     { label:"UCI ML Repo",         flag:"🎯",  country:"Global",         urlBase:"https://archive.ics.uci.edu/dataset/" },
  noaa:    { label:"NOAA",                flag:"🌦️",  country:"Global",         urlBase:"https://www.ncei.noaa.gov/access/search/data-search/global-summary-of-the-month" },
  imf:     { label:"IMF",                 flag:"💹",  country:"Global",         urlBase:"https://data.imf.org/datasets/" },
  oecd:    { label:"OECD",                flag:"📈",  country:"Global",         urlBase:"https://data.oecd.org/" },
  fao:     { label:"FAO",                 flag:"🌾",  country:"Global",         urlBase:"https://www.fao.org/faostat/en/#data/" },
  unicef:  { label:"UNICEF",              flag:"👶",  country:"Global",         urlBase:"https://data.unicef.org/topic/" },
  cdc:     { label:"CDC",                 flag:"🏛️",  country:"Global",         urlBase:"https://data.cdc.gov/browse?q=" },
  eurostat:{ label:"Eurostat",            flag:"📉",  country:"Global",         urlBase:"https://ec.europa.eu/eurostat/databrowser/view/" },
};

// ─── Normalizers ──────────────────────────────────────────────────────────────
function normalizeCKAN(key, item) {
  const m = SOURCE_META[key] || {};
  return {
    id: `${key}_${item.id}`,
    title: str(item.title) || "Untitled",
    description: str(item.notes),
    source: m.label, sourceFlag: m.flag, country: m.country,
    tags: (item.tags || []).map(t => t.display_name || t.name).filter(Boolean).slice(0, 8),
    formats: [...new Set((item.resources || []).map(r => r.format).filter(Boolean).map(f => f.toUpperCase()))],
    url: (m.urlBase || "") + (item.name || item.id),
    updatedAt: item.metadata_modified || null,
    organization: str(item.organization?.title),
  };
}

function normalizeEU(item) {
  const m = SOURCE_META.eu;
  return {
    id: `eu_${item.id}`,
    title: str(item.title) || "Untitled",
    description: str(item.description),
    source: m.label, sourceFlag: m.flag, country: m.country,
    tags: (Array.isArray(item.keywords) ? item.keywords : (item.keywords?.en || [])).slice(0, 8).map(str),
    formats: (item.distributions || []).map(d => str(d.format?.label || d.format)).filter(Boolean).map(f => f.toUpperCase()),
    url: (Array.isArray(item.landingPage) ? item.landingPage[0] : item.landingPage) || "#",
    updatedAt: item.modified || null,
    organization: str(item.publisher?.name),
  };
}

// ─── Country Fetchers ─────────────────────────────────────────────────────────

// 🇺🇸 USA — new catalog.data.gov REST search API (no key needed, not rate-limited like GSA)
async function fetchUS(q, limit) {
  try {
    const json = await safeFetch(
      `https://catalog.data.gov/search?q=${encodeURIComponent(q.includes(" ") ? `"${q}"` : q)}&per_page=${limit}`,
      {}, "data.gov"
    );
    return (json.datasets || []).map(i => ({
      id: `us_${i.id || i.identifier}`,
      title: str(i.title) || "Untitled",
      description: str(i.description),
      source: SOURCE_META.us.label, sourceFlag: SOURCE_META.us.flag, country: "United States",
      tags: (i.keyword || i.tags || []).slice(0, 8),
      formats: (i.distribution || []).map(d => (d.mediaType || d.format || "").split("/").pop().toUpperCase()).filter(Boolean),
      url: i.landingPage || i.accessURL || `https://catalog.data.gov/dataset/${i.name || i.id}`,
      updatedAt: i.modified || null,
      organization: str(i.publisher?.name || i.bureauCode),
    }));
  } catch(e) { console.error("US:", e.message); return []; }
}

// 🇬🇧 UK
async function fetchUK(q, limit) {
  try { return await fetchCKAN("https://data.gov.uk", q, limit, "uk"); }
  catch(e) { console.error("UK:", e.message); return []; }
}

// 🇨🇦 Canada
async function fetchCA(q, limit) {
  try { return await fetchCKAN("https://open.canada.ca/data", q, limit, "ca"); }
  catch(e) { console.error("CA:", e.message); return []; }
}

// 🇦🇺 Australia
async function fetchAU(q, limit) {
  try { return await fetchCKAN("https://data.gov.au/data", q, limit, "au"); }
  catch(e) { console.error("AU:", e.message); return []; }
}

// 🇳🇿 New Zealand
async function fetchNZ(q, limit) {
  try { return await fetchCKAN("https://catalogue.data.govt.nz", q, limit, "nz"); }
  catch(e) { console.error("NZ:", e.message); return []; }
}

// 🇪🇺 EU — description/keywords can be objects or arrays, str() handles it
async function fetchEU(q, limit) {
  try {
    const json = await safeFetch(
      `https://data.europa.eu/api/hub/search/search?q=${encodeURIComponent(q)}&limit=${limit}&filter=dataset&facetOperator=AND`,
      {}, "data.europa.eu"
    );
    return (json.result?.results || []).map(normalizeEU);
  } catch(e) { console.error("EU:", e.message); return []; }
}

// 🇩🇪 Germany — CKAN lives at /ckan not root
async function fetchDE(q, limit) {
  try { return await fetchCKAN("https://www.govdata.de/ckan", q, limit, "de"); }
  catch(e) { console.error("DE:", e.message); return []; }
}

// 🇫🇷 France — uses its own REST API, not CKAN
async function fetchFR(q, limit) {
  try {
    const json = await safeFetch(
      `https://www.data.gouv.fr/api/1/datasets/?q=${encodeURIComponent(q)}&page_size=${limit}`,
      {}, "data.gouv.fr"
    );
    return (json.data || []).map(i => ({
      id: `fr_${i.id}`,
      title: str(i.title) || "Untitled",
      description: str(i.description),
      source: SOURCE_META.fr.label, sourceFlag: SOURCE_META.fr.flag, country: "France",
      tags: (i.tags || []).slice(0, 8),
      formats: (i.resources || []).map(r => (r.format || "").toUpperCase()).filter(Boolean),
      url: `https://www.data.gouv.fr/en/datasets/${i.id}/`,
      updatedAt: i.last_modified || null,
      organization: str(i.organization?.name),
    }));
  } catch(e) { console.error("FR:", e.message); return []; }
}

// 🇳🇱 Netherlands
async function fetchNL(q, limit) {
  try { return await fetchCKAN("https://data.overheid.nl", q, limit, "nl"); }
  catch(e) { console.error("NL:", e.message); return []; }
}

// 🇮🇹 Italy
async function fetchIT(q, limit) {
  try { return await fetchCKAN("https://www.dati.gov.it/opendata", q, limit, "it"); }
  catch(e) { console.error("IT:", e.message); return []; }
}

// 🇪🇸 Spain
async function fetchES(q, limit) {
  try { return await fetchCKAN("https://datos.gob.es", q, limit, "es"); }
  catch(e) { console.error("ES:", e.message); return []; }
}

// 🇧🇷 Brazil — requires token now; use World Bank Brazil data as fallback
async function fetchBR(q, limit) {
  try {
    // dados.gov.br now requires auth — use World Bank filtered to Brazil instead
    const json = await safeFetch(
      `https://api.worldbank.org/v2/country/BR/indicator?format=json&per_page=${limit}&searchTerm=${encodeURIComponent(q)}`,
      {}, "Brazil/WB"
    );
    const items = Array.isArray(json) ? json[1] || [] : [];
    return items.map(i => ({
      id: `br_wb_${i.indicator?.id || i.id}`,
      title: str(i.indicator?.value || i.name) || "Untitled",
      description: str(i.sourceNote || ""),
      source: SOURCE_META.br.label, sourceFlag: SOURCE_META.br.flag, country: "Brazil",
      tags: ["Brazil", "World Bank"].filter(Boolean),
      formats: ["JSON", "CSV"],
      url: `https://data.worldbank.org/indicator/${i.indicator?.id}?locations=BR`,
      updatedAt: null,
      organization: "World Bank / Brazil",
    }));
  } catch(e) { console.error("BR:", e.message); return []; }
}

// 🇲🇽 Mexico
async function fetchMX(q, limit) {
  try { return await fetchCKAN("https://datos.gob.mx", q, limit, "mx"); }
  catch(e) { console.error("MX:", e.message); return []; }
}

// 🇦🇷 Argentina
async function fetchAR(q, limit) {
  try { return await fetchCKAN("https://datos.gob.ar", q, limit, "ar"); }
  catch(e) { console.error("AR:", e.message); return []; }
}

// 🇮🇳 India — data.gov.in CKAN often fails; fallback to WB India
async function fetchIN(q, limit) {
  try { return await fetchCKAN("https://data.gov.in", q, limit, "in"); }
  catch(e) {
    console.error("IN (CKAN failed, trying WB):", e.message);
    try {
      const json = await safeFetch(
        `https://api.worldbank.org/v2/country/IN/indicator?format=json&per_page=${limit}&searchTerm=${encodeURIComponent(q)}`,
        {}, "India/WB"
      );
      const items = Array.isArray(json) ? json[1] || [] : [];
      return items.map(i => ({
        id: `in_wb_${i.indicator?.id}`,
        title: str(i.indicator?.value) || "Untitled",
        description: str(i.sourceNote),
        source: SOURCE_META.in.label, sourceFlag: SOURCE_META.in.flag, country: "India",
        tags: ["India", "World Bank"],
        formats: ["JSON", "CSV"],
        url: `https://data.worldbank.org/indicator/${i.indicator?.id}?locations=IN`,
        updatedAt: null, organization: "World Bank / India",
      }));
    } catch(e2) { console.error("IN/WB:", e2.message); return []; }
  }
}

// 🇯🇵 Japan — data.go.jp CKAN path changed to /data/
async function fetchJP(q, limit) {
  try { return await fetchCKAN("https://www.data.go.jp/data", q, limit, "jp"); }
  catch(e) {
    console.error("JP (CKAN failed, trying catalog API):", e.message);
    try {
      // Fallback: Japan's catalog search endpoint
      const json = await safeFetch(
        `https://www.data.go.jp/search/?q=${encodeURIComponent(q)}&lang=en&format=json&limit=${limit}`,
        {}, "Japan/catalog"
      );
      return (json.result?.results || json.results || []).map(i => normalizeCKAN("jp", i));
    } catch(e2) { console.error("JP/catalog:", e2.message); return []; }
  }
}

// 🇸🇬 Singapore — CKAN removed; use their dataset API instead
async function fetchSG(q, limit) {
  try {
    const json = await safeFetch(
      `https://api.data.gov.sg/v2/public/api/datasets?query=${encodeURIComponent(q)}&pageSize=${limit}`,
      {}, "data.gov.sg"
    );
    const items = json.data?.datasets || json.datasets || [];
    return items.map(i => ({
      id: `sg_${i.datasetId || i.id}`,
      title: str(i.name || i.title) || "Untitled",
      description: str(i.description),
      source: SOURCE_META.sg.label, sourceFlag: SOURCE_META.sg.flag, country: "Singapore",
      tags: (i.tags || i.keywords || []).slice(0, 8),
      formats: (i.formats || ["CSV"]),
      url: `https://data.gov.sg/datasets/${i.datasetId || i.id}`,
      updatedAt: i.updatedAt || i.lastUpdatedAt || null,
      organization: str(i.agencyName || i.organization),
    }));
  } catch(e) { console.error("SG:", e.message); return []; }
}

// 🇿🇦 South Africa
async function fetchZA(q, limit) {
  try { return await fetchCKAN("https://data.gov.za", q, limit, "za"); }
  catch(e) { console.error("ZA:", e.message); return []; }
}

// 🇰🇪 Kenya
async function fetchKE(q, limit) {
  try { return await fetchCKAN("https://www.opendata.go.ke", q, limit, "ke"); }
  catch(e) { console.error("KE:", e.message); return []; }
}

// 🇵🇰 Pakistan
async function fetchPK(q, limit) {
  try { return await fetchCKAN("https://data.gov.pk", q, limit, "pk"); }
  catch(e) { console.error("PK:", e.message); return []; }
}

// ─── Platform / Global Fetchers ───────────────────────────────────────────────

// 🌍 World Bank
async function fetchWB(q, limit) {
  try {
    const json = await safeFetch(
      `https://api.worldbank.org/v2/indicator?format=json&per_page=${limit}&searchTerm=${encodeURIComponent(q)}`,
      {}, "World Bank"
    );
    return (Array.isArray(json) ? json[1] || [] : []).map(i => ({
      id: `wb_${i.id}`,
      title: str(i.name) || "Untitled",
      description: str(i.sourceNote),
      source: SOURCE_META.wb.label, sourceFlag: SOURCE_META.wb.flag, country: "Global",
      tags: [i.topics?.[0]?.value].filter(Boolean),
      formats: ["JSON", "CSV", "XML"],
      url: SOURCE_META.wb.urlBase + i.id,
      updatedAt: i.lastUpdated || null,
      organization: str(i.sourceOrganization) || "World Bank",
    }));
  } catch(e) { console.error("WB:", e.message); return []; }
}

// 🤗 Hugging Face
async function fetchHF(q, limit) {
  try {
    const json = await safeFetch(
      `https://huggingface.co/api/datasets?search=${encodeURIComponent(q)}&limit=${limit}&sort=downloads&direction=-1`,
      {}, "Hugging Face"
    );
    return (Array.isArray(json) ? json : []).map(i => ({
      id: `hf_${i.id}`,
      title: str(i.id) || "Untitled",
      description: str(i.description),
      source: SOURCE_META.hf.label, sourceFlag: SOURCE_META.hf.flag, country: "Global",
      tags: (i.tags || []).slice(0, 8),
      formats: ["Parquet", "JSON"],
      url: SOURCE_META.hf.urlBase + i.id,
      updatedAt: i.lastModified || null,
      organization: str(i.author),
    }));
  } catch(e) { console.error("HF:", e.message); return []; }
}

// 🔬 Zenodo
async function fetchZenodo(q, limit) {
  try {
    const json = await safeFetch(
      `https://zenodo.org/api/records?q=${encodeURIComponent(q.includes(" ") ? `title:"${q}" OR description:"${q}"` : q)}&size=${limit}&sort=mostviewed&type=dataset`,
      {}, "Zenodo"
    );
    return (json.hits?.hits || []).map(i => ({
      id: `zen_${i.id}`,
      title: str(i.metadata?.title) || "Untitled",
      description: str((i.metadata?.description || "").replace(/<[^>]+>/g, "")),
      source: SOURCE_META.zenodo.label, sourceFlag: SOURCE_META.zenodo.flag, country: "Global",
      tags: (i.metadata?.keywords || []).slice(0, 8),
      formats: [...new Set((i.files || []).map(f => (f.type || f.key?.split(".").pop() || "").toUpperCase()).filter(Boolean))],
      url: i.links?.html || `${SOURCE_META.zenodo.urlBase}${i.id}`,
      updatedAt: i.updated || null,
      organization: str(i.metadata?.creators?.[0]?.name),
    }));
  } catch(e) { console.error("Zenodo:", e.message); return []; }
}

// 📊 Kaggle
async function fetchKaggle(q, limit) {
  try {
    const json = await safeFetch(
      `https://www.kaggle.com/api/v1/datasets/list?search=${encodeURIComponent(q)}&pageSize=${limit}&sortBy=votes`,
      {}, "Kaggle"
    );
    return (Array.isArray(json) ? json : []).map(i => ({
      id: `kg_${i.id || i.ref}`,
      title: str(i.title || i.ref) || "Untitled",
      description: str(i.subtitle || i.description),
      source: SOURCE_META.kaggle.label, sourceFlag: SOURCE_META.kaggle.flag, country: "Global",
      tags: (i.tags || []).map(t => t.name || t).slice(0, 8),
      formats: ["CSV"],
      url: `https://www.kaggle.com/datasets/${i.ref || ""}`,
      updatedAt: i.lastUpdated || null,
      organization: str(i.ownerName || i.creatorName),
    }));
  } catch(e) { console.error("Kaggle:", e.message); return []; }
}

// 🎓 Harvard Dataverse
async function fetchHarvard(q, limit) {
  try {
    const json = await safeFetch(
      `https://dataverse.harvard.edu/api/search?q=${encodeURIComponent(q.includes(" ") ? `"${q}"` : q)}&type=dataset&per_page=${limit}`,
      {}, "Harvard Dataverse"
    );
    return (json.data?.items || []).map(i => ({
      id: `hdv_${(i.global_id || "").replace(/[^a-z0-9]/gi, "_")}`,
      title: str(i.name) || "Untitled",
      description: str(i.description),
      source: SOURCE_META.harvard.label, sourceFlag: SOURCE_META.harvard.flag, country: "Global",
      tags: (i.subjects || []).slice(0, 8),
      formats: ["Tab", "CSV", "RData"],
      url: i.url || `${SOURCE_META.harvard.urlBase}${i.global_id || ""}`,
      updatedAt: i.updatedAt || null,
      organization: str(i.authors?.[0]),
    }));
  } catch(e) { console.error("Harvard:", e.message); return []; }
}

// 🏥 WHO
async function fetchWHO(q, limit) {
  try {
    const json = await safeFetch(
      `https://ghoapi.azureedge.net/api/Indicator?$filter=contains(tolower(IndicatorName),tolower('${q.replace(/'/g,"''")}'))&$top=${limit}`,
      {}, "WHO"
    );
    return (json.value || []).map(i => ({
      id: `who_${i.IndicatorCode || Math.random().toString(36).slice(2)}`,
      title: str(i.IndicatorName) || "Untitled",
      description: str(i.Definition),
      source: SOURCE_META.who.label, sourceFlag: SOURCE_META.who.flag, country: "Global",
      tags: [i.Category, i.IndicatorCode].filter(Boolean),
      formats: ["JSON", "CSV"],
      url: `${SOURCE_META.who.urlBase}${i.IndicatorCode || ""}`,
      updatedAt: null,
      organization: "World Health Organization",
    }));
  } catch(e) { console.error("WHO:", e.message); return []; }
}


// 📁 Figshare — public articles search
async function fetchFigshare(q, limit) {
  try {
    const json = await safeFetch(
      `https://api.figshare.com/v2/articles/search`,
      { timeout: 12000, headers: { "Content-Type": "application/json" } },
      "Figshare"
    );
    // Figshare search is POST, but let's try GET with query params
    const getJson = await safeFetch(
      `https://api.figshare.com/v2/articles?search_for=${encodeURIComponent(q)}&page_size=${limit}&item_type=3`,
      {}, "Figshare"
    );
    return (Array.isArray(getJson) ? getJson : []).map(i => ({
      id: `fig_${i.id}`,
      title: str(i.title) || "Untitled",
      description: str(i.description),
      source: SOURCE_META.figshare.label, sourceFlag: SOURCE_META.figshare.flag, country: "Global",
      tags: (i.tags || i.categories || []).slice(0, 8),
      formats: (i.files || []).map(f => (f.name?.split(".").pop() || "").toUpperCase()).filter(Boolean),
      url: i.url_public_html || i.figshare_url || `${SOURCE_META.figshare.urlBase}${i.id}`,
      updatedAt: i.modified_date || i.published_date || null,
      organization: str(i.authors?.[0]?.full_name),
    }));
  } catch(e) { console.error("Figshare:", e.message); return []; }
}

// 🌿 Dryad — scientific data repository
async function fetchDryad(q, limit) {
  try {
    const json = await safeFetch(
      `https://datadryad.org/api/v2/search?q=${encodeURIComponent(q)}&per_page=${limit}`,
      {}, "Dryad"
    );
    return (json._embedded?.["stash:datasets"] || []).map(i => ({
      id: `dry_${i.identifier}`,
      title: str(i.title) || "Untitled",
      description: str(i.abstract),
      source: SOURCE_META.dryad.label, sourceFlag: SOURCE_META.dryad.flag, country: "Global",
      tags: (i.keywords || []).slice(0, 8),
      formats: ["CSV", "ZIP"],
      url: i._links?.["stash:dataset"]?.href || `${SOURCE_META.dryad.urlBase}${i.identifier}`,
      updatedAt: i.lastModificationDate || null,
      organization: str(i.authors?.[0]?.lastName),
    }));
  } catch(e) { console.error("Dryad:", e.message); return []; }
}

// 🤖 OpenML — ML benchmark datasets
async function fetchOpenML(q, limit) {
  try {
    const json = await safeFetch(
      `https://www.openml.org/api/v1/json/data/list/data_name/${encodeURIComponent(q)}/limit/${limit}`,
      {}, "OpenML"
    );
    const items = json.data?.dataset || [];
    return items.map(i => ({
      id: `oml_${i.did}`,
      title: str(i.name) || "Untitled",
      description: str(i.description || `${i.NumberOfInstances} instances, ${i.NumberOfFeatures} features`),
      source: SOURCE_META.openml.label, sourceFlag: SOURCE_META.openml.flag, country: "Global",
      tags: [i.format, `${i.NumberOfClasses} classes`].filter(Boolean),
      formats: [i.format || "ARFF", "CSV"],
      url: `https://www.openml.org/search?type=data&id=${i.did}`,
      updatedAt: i.upload_date || null,
      organization: str(i.creator),
    }));
  } catch(e) { console.error("OpenML:", e.message); return []; }
}

// 🦋 GBIF — Global Biodiversity Information Facility
async function fetchGBIF(q, limit) {
  try {
    const json = await safeFetch(
      `https://api.gbif.org/v1/dataset/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      {}, "GBIF"
    );
    return (json.results || []).map(i => ({
      id: `gbif_${i.key}`,
      title: str(i.title) || "Untitled",
      description: str(i.description),
      source: SOURCE_META.gbif.label, sourceFlag: SOURCE_META.gbif.flag, country: "Global",
      tags: [i.type, i.subtype, ...(i.keywords || [])].filter(Boolean).slice(0, 8),
      formats: ["DwC-A", "CSV"],
      url: `https://www.gbif.org/dataset/${i.key}`,
      updatedAt: i.modified || i.created || null,
      organization: str(i.publishingOrganizationTitle),
    }));
  } catch(e) { console.error("GBIF:", e.message); return []; }
}

// 📂 OSF — Open Science Framework
async function fetchOSF(q, limit) {
  try {
    const json = await safeFetch(
      `https://api.osf.io/v2/nodes/?filter[title][icontains]=${encodeURIComponent(q)}&filter[public]=true&page[size]=${limit}`,
      {}, "OSF"
    );
    return (json.data || []).map(i => ({
      id: `osf_${i.id}`,
      title: str(i.attributes?.title) || "Untitled",
      description: str(i.attributes?.description),
      source: SOURCE_META.osf.label, sourceFlag: SOURCE_META.osf.flag, country: "Global",
      tags: (i.attributes?.tags || []).slice(0, 8),
      formats: ["Various"],
      url: i.links?.html || `https://osf.io/${i.id}`,
      updatedAt: i.attributes?.date_modified || null,
      organization: "",
    }));
  } catch(e) { console.error("OSF:", e.message); return []; }
}

// 🌊 PANGAEA — Earth & environmental science data
async function fetchPangaea(q, limit) {
  try {
    const json = await safeFetch(
      `https://ws.pangaea.de/es/dataportal/panmd/_search?q=${encodeURIComponent(q)}&size=${limit}`,
      {}, "PANGAEA"
    );
    return (json.hits?.hits || []).map(i => {
      const s = i._source || {};
      return {
        id: `pan_${i._id}`,
        title: str(s.citation || s.title) || "Untitled",
        description: str(s.abstract || s.supplement_to),
        source: SOURCE_META.pangaea.label, sourceFlag: SOURCE_META.pangaea.flag, country: "Global",
        tags: (s.keywords || s.parameters || []).slice(0, 8),
        formats: ["Tab", "CSV", "NetCDF"],
        url: s.URI || `https://doi.pangaea.de/${i._id}`,
        updatedAt: s.dateTime || null,
        organization: str(s.authors?.[0]),
      };
    });
  } catch(e) { console.error("PANGAEA:", e.message); return []; }
}

// 📚 ICPSR — social science data archive
async function fetchICPSR(q, limit) {
  try {
    const json = await safeFetch(
      `https://www.icpsr.umich.edu/web/ICPSR/api/v1/studies?q=${encodeURIComponent(q)}&start=0&rows=${limit}`,
      {}, "ICPSR"
    );
    return (json.response?.docs || json.studies || []).map(i => ({
      id: `icpsr_${i.STUDY_NUMBER || i.id}`,
      title: str(i.TITLE || i.title) || "Untitled",
      description: str(i.DESCRIPTION || i.abstract),
      source: SOURCE_META.icpsr.label, sourceFlag: SOURCE_META.icpsr.flag, country: "Global",
      tags: (i.KEYWORDS || i.subjects || []).slice(0, 8),
      formats: ["SPSS", "Stata", "R", "SAS"],
      url: `https://www.icpsr.umich.edu/web/ICPSR/studies/${i.STUDY_NUMBER || i.id}`,
      updatedAt: i.UPDATED || null,
      organization: str(i.PRINCIPAL_INVESTIGATOR || i.pi),
    }));
  } catch(e) { console.error("ICPSR:", e.message); return []; }
}

// 🚀 NASA — open data portal
async function fetchNASA(q, limit) {
  try {
    const json = await safeFetch(
      `https://data.nasa.gov/resource/gh4g-9sfh.json?$q=${encodeURIComponent(q)}&$limit=${limit}`,
      {}, "NASA"
    );
    // Also try catalog search
    const catalogJson = await safeFetch(
      `https://data.nasa.gov/api/catalog/v1?q=${encodeURIComponent(q)}&limit=${limit}`,
      {}, "NASA/catalog"
    ).catch(() => ({ results: [] }));
    const items = catalogJson.results || [];
    return items.map(i => ({
      id: `nasa_${i.resource?.id || Math.random().toString(36).slice(2)}`,
      title: str(i.resource?.name || i.name) || "Untitled",
      description: str(i.resource?.description || i.description),
      source: SOURCE_META.nasa.label, sourceFlag: SOURCE_META.nasa.flag, country: "Global",
      tags: (i.classification?.domain_tags || []).slice(0, 8),
      formats: ["CSV", "JSON", "API"],
      url: i.permalink || i.link || `https://data.nasa.gov/dataset/${i.resource?.id || ""}`,
      updatedAt: i.resource?.updatedAt || null,
      organization: "NASA",
    }));
  } catch(e) { console.error("NASA:", e.message); return []; }
}


// 🎯 UCI Machine Learning Repository
async function fetchUCI(q, limit) {
  try {
    const json = await safeFetch(
      `https://archive.ics.uci.edu/api/datasets?search=${encodeURIComponent(q)}&max=${limit}`,
      {}, "UCI ML"
    );
    return (json.datasets || json || []).map(i => ({
      id: `uci_${i.id || i.ID}`,
      title: str(i.name || i.Name) || "Untitled",
      description: str(i.abstract || i.Abstract),
      source: SOURCE_META.uci.label, sourceFlag: SOURCE_META.uci.flag, country: "Global",
      tags: [i.task || i.Task, i.types || i.Types].filter(Boolean),
      formats: ["CSV", "ARFF"],
      url: `https://archive.ics.uci.edu/dataset/${i.id || i.ID}`,
      updatedAt: i.dateCreated || null,
      organization: str(i.creators || i.source),
    }));
  } catch(e) { console.error("UCI:", e.message); return []; }
}

// 🌦️ NOAA — climate & weather data
async function fetchNOAA(q, limit) {
  try {
    const json = await safeFetch(
      `https://www.ncei.noaa.gov/cdo-web/api/v2/datasets?limit=${limit}`,
      { headers: { token: "demo" } }, "NOAA"
    );
    const items = (json.results || []).filter(i => 
      str(i.name).toLowerCase().includes(q.toLowerCase()) ||
      str(i.datacoverage).toLowerCase().includes(q.toLowerCase())
    );
    return items.map(i => ({
      id: `noaa_${i.id}`,
      title: str(i.name) || "Untitled",
      description: `Data coverage: ${i.mindate} to ${i.maxdate}`,
      source: SOURCE_META.noaa.label, sourceFlag: SOURCE_META.noaa.flag, country: "Global",
      tags: ["Climate", "Weather", i.id],
      formats: ["CSV", "JSON"],
      url: `https://www.ncei.noaa.gov/cdo-web/datasets/${i.id}`,
      updatedAt: i.maxdate || null,
      organization: "NOAA",
    }));
  } catch(e) { console.error("NOAA:", e.message); return []; }
}

// 💹 IMF — International Monetary Fund
async function fetchIMF(q, limit) {
  try {
    const json = await safeFetch(
      `https://www.imf.org/external/datamapper/api/v1/INDICATORS`,
      {}, "IMF"
    );
    const indicators = Object.entries(json.indicators || {}).slice(0, 100);
    const filtered = indicators.filter(([k, v]) => 
      k.toLowerCase().includes(q.toLowerCase()) || 
      str(v.label).toLowerCase().includes(q.toLowerCase())
    ).slice(0, limit);
    return filtered.map(([k, v]) => ({
      id: `imf_${k}`,
      title: str(v.label) || k,
      description: str(v.description || `IMF indicator: ${k}`),
      source: SOURCE_META.imf.label, sourceFlag: SOURCE_META.imf.flag, country: "Global",
      tags: [v.unit, "Economics"].filter(Boolean),
      formats: ["JSON", "CSV", "Excel"],
      url: `https://www.imf.org/external/datamapper/${k}`,
      updatedAt: null,
      organization: "International Monetary Fund",
    }));
  } catch(e) { console.error("IMF:", e.message); return []; }
}

// 📈 OECD — Organisation for Economic Co-operation and Development
async function fetchOECD(q, limit) {
  try {
    const json = await safeFetch(
      `https://sdmx.oecd.org/public/rest/dataflow/OECD?detail=allstubs`,
      { headers: { Accept: "application/json" } }, "OECD"
    );
    // OECD returns SDMX structure, extract dataflows
    const flows = json.Structure?.Dataflows?.Dataflow || [];
    const filtered = flows.filter(f => 
      str(f.Name?.[0]?.["#text"]).toLowerCase().includes(q.toLowerCase())
    ).slice(0, limit);
    return filtered.map(f => ({
      id: `oecd_${f.id}`,
      title: str(f.Name?.[0]?.["#text"]) || f.id,
      description: str(f.Description?.[0]?.["#text"]),
      source: SOURCE_META.oecd.label, sourceFlag: SOURCE_META.oecd.flag, country: "Global",
      tags: ["Economics", "Statistics"],
      formats: ["SDMX", "CSV", "JSON"],
      url: `https://data.oecd.org/searchresults/?q=${encodeURIComponent(f.id)}`,
      updatedAt: null,
      organization: "OECD",
    }));
  } catch(e) { console.error("OECD:", e.message); return []; }
}

// 🌾 FAO — Food and Agriculture Organization
async function fetchFAO(q, limit) {
  try {
    const json = await safeFetch(
      `https://fenixservices.fao.org/faostat/api/v1/en/domains`,
      {}, "FAO"
    );
    const domains = json.data || [];
    const filtered = domains.filter(d =>
      str(d.label).toLowerCase().includes(q.toLowerCase()) ||
      str(d.description).toLowerCase().includes(q.toLowerCase())
    ).slice(0, limit);
    return filtered.map(d => ({
      id: `fao_${d.code}`,
      title: str(d.label) || d.code,
      description: str(d.description),
      source: SOURCE_META.fao.label, sourceFlag: SOURCE_META.fao.flag, country: "Global",
      tags: ["Agriculture", "Food", d.group].filter(Boolean),
      formats: ["CSV", "JSON"],
      url: `https://www.fao.org/faostat/en/#data/${d.code}`,
      updatedAt: null,
      organization: "FAO",
    }));
  } catch(e) { console.error("FAO:", e.message); return []; }
}

// 👶 UNICEF — children's welfare data
async function fetchUNICEF(q, limit) {
  try {
    const json = await safeFetch(
      `https://sdmx.data.unicef.org/ws/public/sdmxapi/rest/dataflow/UNICEF/all/latest?format=jsondata&detail=allstubs`,
      {}, "UNICEF"
    );
    const flows = json.Dataflow || [];
    const filtered = flows.filter(f =>
      str(f.Name).toLowerCase().includes(q.toLowerCase()) ||
      str(f.Description).toLowerCase().includes(q.toLowerCase())
    ).slice(0, limit);
    return filtered.map(f => ({
      id: `unicef_${f.id}`,
      title: str(f.Name) || f.id,
      description: str(f.Description),
      source: SOURCE_META.unicef.label, sourceFlag: SOURCE_META.unicef.flag, country: "Global",
      tags: ["Children", "Health", "Education"].filter(Boolean),
      formats: ["SDMX", "CSV", "JSON"],
      url: `https://data.unicef.org/indicator/${f.id}`,
      updatedAt: null,
      organization: "UNICEF",
    }));
  } catch(e) { console.error("UNICEF:", e.message); return []; }
}

// 🏛️ CDC — Centers for Disease Control and Prevention
async function fetchCDC(q, limit) {
  try {
    const json = await safeFetch(
      `https://data.cdc.gov/api/catalog/v1?q=${encodeURIComponent(q)}&limit=${limit}`,
      {}, "CDC"
    );
    return (json.results || []).map(i => ({
      id: `cdc_${i.resource?.id || Math.random().toString(36).slice(2)}`,
      title: str(i.resource?.name) || "Untitled",
      description: str(i.resource?.description),
      source: SOURCE_META.cdc.label, sourceFlag: SOURCE_META.cdc.flag, country: "Global",
      tags: (i.classification?.domain_tags || []).slice(0, 5),
      formats: ["CSV", "JSON", "API"],
      url: i.permalink || `https://data.cdc.gov/d/${i.resource?.id}`,
      updatedAt: i.resource?.data_updated_at || null,
      organization: "CDC",
    }));
  } catch(e) { console.error("CDC:", e.message); return []; }
}

// 📉 Eurostat — EU statistics
async function fetchEurostat(q, limit) {
  try {
    const json = await safeFetch(
      `https://ec.europa.eu/eurostat/api/dissemination/catalogue/toc?lang=en&format=JSON`,
      {}, "Eurostat"
    );
    const items = [];
    function traverse(node) {
      if (items.length >= limit * 2) return;
      if (node.code && node.title) {
        if (str(node.title).toLowerCase().includes(q.toLowerCase())) {
          items.push(node);
        }
      }
      if (node.children) node.children.forEach(traverse);
    }
    traverse(json);
    return items.slice(0, limit).map(i => ({
      id: `estat_${i.code}`,
      title: str(i.title),
      description: str(i.shortDescription || i.title),
      source: SOURCE_META.eurostat.label, sourceFlag: SOURCE_META.eurostat.flag, country: "Global",
      tags: ["EU", "Statistics"],
      formats: ["CSV", "JSON", "SDMX"],
      url: `https://ec.europa.eu/eurostat/databrowser/view/${i.code}`,
      updatedAt: i.lastUpdate || null,
      organization: "Eurostat",
    }));
  } catch(e) { console.error("Eurostat:", e.message); return []; }
}

// ─── Source registry ──────────────────────────────────────────────────────────
const FETCHERS = {
  us: fetchUS, uk: fetchUK, ca: fetchCA, au: fetchAU, nz: fetchNZ,
  eu: fetchEU, de: fetchDE, fr: fetchFR, nl: fetchNL, it: fetchIT, es: fetchES,
  br: fetchBR, mx: fetchMX, ar: fetchAR,
  in: fetchIN, jp: fetchJP, sg: fetchSG, pk: fetchPK,
  za: fetchZA, ke: fetchKE,
  wb: fetchWB, hf: fetchHF, zenodo: fetchZenodo,
  kaggle: fetchKaggle, harvard: fetchHarvard, who: fetchWHO,
  figshare: fetchFigshare, dryad: fetchDryad, openml: fetchOpenML,
  gbif: fetchGBIF, osf: fetchOSF, pangaea: fetchPangaea,
  icpsr: fetchICPSR, nasa: fetchNASA,
  uci: fetchUCI, noaa: fetchNOAA, imf: fetchIMF, oecd: fetchOECD,
  fao: fetchFAO, unicef: fetchUNICEF, cdc: fetchCDC, eurostat: fetchEurostat,
};

// Worldwide default — most reliable sources
const WORLDWIDE = [
  fetchUK, fetchCA, fetchAU, fetchEU, fetchDE, fetchFR, fetchNZ,
  fetchNL, fetchES, fetchMX, fetchWB, fetchHF, fetchZenodo, fetchHarvard,
];

// ─── /api/search ─────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  const { q = "", sources = "", limit = 20 } = req.query;
  if (!q.trim()) return res.json({ results: [], total: 0 });

  const cacheKey = `${q}__${sources}__${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const keys = sources ? sources.split(",").map(s => s.trim()).filter(Boolean) : [];
  const fetchers = keys.length > 0 ? keys.map(k => FETCHERS[k]).filter(Boolean) : WORLDWIDE;
  const perSource = Math.max(5, Math.ceil(parseInt(limit) / fetchers.length) + 3);

  const settled = await Promise.allSettled(fetchers.map(fn => fn(q, perSource)));
  const results = settled.flatMap(r => r.status === "fulfilled" ? r.value : []).filter(Boolean);
  const unique = Array.from(new Map(results.map(r => [r.id, r])).values());

  // Relevance sort: exact title phrase match → title contains all words → anything else
  const qLower = q.toLowerCase().trim();
  const qWords = qLower.split(/\s+/);
  const scored = unique.map(r => {
    const t = (r.title || "").toLowerCase();
    const d = (r.description || "").toLowerCase();
    let score = 0;
    if (t === qLower)                                  score = 100; // exact title
    else if (t.startsWith(qLower))                     score = 90;  // title starts with phrase
    else if (t.includes(qLower))                       score = 80;  // phrase anywhere in title
    else if (d.includes(qLower))                       score = 60;  // phrase in description
    else if (qWords.every(w => t.includes(w)))         score = 50;  // all words in title
    else if (qWords.every(w => t.includes(w) || d.includes(w))) score = 30; // all words anywhere
    else if (qWords.some(w => t.includes(w)))          score = 10;  // some words in title
    return { ...r, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);

  const response = { results: scored.slice(0, parseInt(limit)), total: scored.length, query: q, sources: keys };
  cache.set(cacheKey, response);
  res.json(response);
});

app.get("/api/sources", (_, res) => res.json(SOURCE_META));
app.get("/api/health", (_, res) => res.json({ ok: true, sources: Object.keys(FETCHERS) }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Open Data API on port ${PORT} · ${Object.keys(FETCHERS).length} sources`));
