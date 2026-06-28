#!/usr/bin/env node
// One-time importer: pulls verified venues from OpenStreetMap for a city
// and writes them to ../seed.js. Re-runnable: stable IDs come from OSM IDs.
//
// Usage:  node scripts/import-osm.js [city]   (default: leuven)
//
// Filters to venue categories where AC is essentially guaranteed:
// libraries, cinemas, malls, supermarkets, electronics, department stores.

const fs = require("fs");
const path = require("path");

const CITIES = {
  leuven: { bbox: "50.85,4.68,50.91,4.74", center: { lat: 50.8798, lng: 4.7005, zoom: 14 } },
  brussels: { bbox: "50.79,4.30,50.92,4.48", center: { lat: 50.8503, lng: 4.3517, zoom: 13 } },
  antwerp: { bbox: "51.18,4.36,51.27,4.50", center: { lat: 51.2194, lng: 4.4025, zoom: 13 } },
  ghent: { bbox: "51.02,3.66,51.10,3.78", center: { lat: 51.0543, lng: 3.7174, zoom: 13 } },
};

const CITY = (process.argv[2] || "leuven").toLowerCase();
if (!CITIES[CITY]) { console.error(`Unknown city: ${CITY}. Options: ${Object.keys(CITIES).join(", ")}`); process.exit(1); }

const QUERY = `[out:json][timeout:25];
(
  node["amenity"~"library|cinema"](${CITIES[CITY].bbox});
  node["shop"~"mall|supermarket|electronics|department_store"](${CITIES[CITY].bbox});
  way["amenity"~"library|cinema"](${CITIES[CITY].bbox});
  way["shop"~"mall|supermarket|electronics|department_store"](${CITIES[CITY].bbox});
);
out center tags;`;

const DESCRIPTIONS = {
  library:       "Public library — quiet, air-conditioned, plenty of seats.",
  cinema:        "Cinema lobby — colder than your ex, even without buying a ticket.",
  mall:          "Indoor shopping — air-conditioned passage to wander.",
  supermarket:   "Supermarket — stand by the dairy aisle and rejoin the living.",
  electronics:   "Electronics store — demo screens and full-blast AC.",
  department_store: "Department store — multiple floors, all chilled.",
};
const AMENITIES = {
  library:       ["wifi", "seats", "quiet", "accessible"],
  cinema:        ["seats", "food", "accessible"],
  mall:          ["seats", "food", "accessible"],
  supermarket:   ["food", "accessible"],
  electronics:   ["accessible"],
  department_store: ["food", "accessible"],
};

function osmTypeOf(t) {
  if (t.amenity === "library") return "library";
  if (t.amenity === "cinema") return "cinema";
  if (t.shop === "mall") return "mall";
  if (t.shop === "supermarket") return "supermarket";
  if (t.shop === "electronics") return "electronics";
  if (t.shop === "department_store") return "department_store";
  return null;
}
function appCategoryOf(osmType) {
  if (osmType === "library") return "library";
  if (osmType === "cinema") return "shopping";
  return "shopping";
}
function slug(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
}

async function main() {
  console.log(`Importing ${CITY} from OSM…`);
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "CoolSpots/0.1 (one-time OSM importer)",
      "Accept": "application/json",
    },
    body: "data=" + encodeURIComponent(QUERY),
  });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  const j = await r.json();

  const spots = [];
  for (const el of j.elements) {
    const t = el.tags || {};
    if (!t.name) continue;
    const osmType = osmTypeOf(t);
    if (!osmType) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;

    if (!t["addr:street"]) continue; // skip entries without a real street address
    const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
    const cityPart = [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ");
    const address = [street, cityPart].filter(Boolean).join(", ");

    spots.push({
      id: `osm-${el.type[0]}${el.id}`,
      name: t.name,
      category: appCategoryOf(osmType),
      osmType,
      lat: +lat.toFixed(5), lng: +lng.toFixed(5),
      address,
      ac: "unverified",
      amenities: AMENITIES[osmType] || ["accessible"],
      description: DESCRIPTIONS[osmType] || "Likely air-conditioned — help verify.",
      nickname: "OSM",
      confirms: 0, denies: 0,
      createdAt: new Date().toISOString().slice(0, 10),
    });
  }

  // Dedup by name+coord (some OSM venues have both node & way representations)
  const seen = new Set();
  const deduped = spots.filter(s => {
    const k = `${s.name.toLowerCase()}|${s.lat.toFixed(3)}|${s.lng.toFixed(3)}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // Sort: libraries first (most reliable AC), then cinemas, then shops
  const typeRank = { library: 0, cinema: 1, mall: 2, department_store: 3, electronics: 4, supermarket: 5 };
  deduped.sort((a, b) => (typeRank[a.osmType] - typeRank[b.osmType]) || a.name.localeCompare(b.name));

  // Strip the osmType field before writing (used only for sorting)
  const final = deduped.map(({ osmType, ...rest }) => rest);

  const C = CITIES[CITY].center;

  // 1) Frontend fallback seed (used when the API is unreachable)
  const seedJs = `// Auto-imported from OpenStreetMap (${CITY}) on ${new Date().toISOString().slice(0, 10)}.
// Re-import:  node scripts/import-osm.js ${CITY}
// Used as a fallback if the PocketBase API can't be reached on page load.
window.SEED_SPOTS = ${JSON.stringify(final, null, 2)};

window.LEUVEN_CENTER = { lat: ${C.lat}, lng: ${C.lng}, zoom: ${C.zoom} };
`;
  fs.writeFileSync(path.join(__dirname, "..", "seed.js"), seedJs);

  // 2) PocketBase seed migration (runs once on first boot; idempotent guard skips if rows exist)
  const pbSeed = final.map((s) => ({ ...s, source: "osm", osm_id: s.id }));
  const migrationJs = `/// <reference path="../pb_data/types.d.ts" />
// Auto-generated by scripts/import-osm.js — seeds OSM-verified ${CITY} venues into the \`spots\` collection.
// Only inserts if the collection is empty (re-runs are no-ops).

migrate((db) => {
  const dao = new Dao(db);
  const collection = dao.findCollectionByNameOrId("spots");

  // Idempotency guard: skip if any rows already present
  const existing = dao.findRecordsByExpr("spots");
  if (existing.length > 0) return;

  const SPOTS = ${JSON.stringify(pbSeed, null, 2)};

  for (const s of SPOTS) {
    const record = new Record(collection);
    record.set("name",        s.name);
    record.set("category",    s.category);
    record.set("lat",         s.lat);
    record.set("lng",         s.lng);
    record.set("address",     s.address);
    record.set("ac",          s.ac);
    record.set("amenities",   s.amenities);
    record.set("description", s.description);
    record.set("nickname",    s.nickname);
    record.set("photo",       s.photo || "");
    record.set("confirms",    s.confirms);
    record.set("denies",      s.denies);
    record.set("source",      s.source);
    record.set("osm_id",      s.osm_id);
    dao.saveRecord(record);
  }
}, (db) => {
  // Down: delete OSM-sourced spots (leave user-added intact)
  const dao = new Dao(db);
  const records = dao.findRecordsByExpr("spots", $dbx.exp("source = 'osm'"));
  for (const r of records) dao.deleteRecord(r);
});
`;
  fs.writeFileSync(path.join(__dirname, "..", "deploy", "pb_migrations", "1700000002_seed_osm.js"), migrationJs);

  console.log(`Wrote ${final.length} spots to seed.js`);
  console.log(`Wrote PB seed migration: deploy/pb_migrations/1700000002_seed_osm.js`);
  console.log(`Breakdown: ${Object.entries(deduped.reduce((acc, s) => (acc[s.osmType] = (acc[s.osmType] || 0) + 1, acc), {})).map(([k,v]) => `${k}=${v}`).join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
