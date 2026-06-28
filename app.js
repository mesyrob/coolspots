(() => {
  "use strict";

  // ---------------- Constants ----------------
  // PocketBase is served from the same origin in production (Talos cluster).
  // For local dev (file://, python http.server, etc.) it falls back to window.SEED_SPOTS.
  // Backend URL: prefer <meta name="api-base">, fall back to same-origin.
  const META_API_BASE = document.querySelector('meta[name="api-base"]')?.content?.trim() || "";
  const API_BASE = META_API_BASE.replace(/\/$/, "") || location.origin;
  const API_SPOTS = `${API_BASE}/api/collections/spots/records`;
  const API_FAVS  = `${API_BASE}/api/collections/favorites/records`;
  let usingApi = false; // flipped to true if the API responds on boot

  // Anonymous device identity for server-side favorites.
  // Random UUID, persisted in localStorage. No PII. If the user clears storage, their
  // favorites are orphaned (still in the DB but no longer reachable).
  const getDeviceId = () => {
    let id = localStorage.getItem("coolspots:device-id");
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
           ("d-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem("coolspots:device-id", id);
    }
    return id;
  };
  const deviceId = getDeviceId();

  const STORAGE = {
    spots: "coolspots:user-spots",      // legacy local-only spots (offline fallback)
    favs: "coolspots:favorites",        // user's favorites (always local — personal)
    votes: "coolspots:votes",           // user's own vote per spot (always local — prevents double-voting in UI)
    voteDelta: "coolspots:vote-delta",  // legacy offline-mode delta (kept for graceful offline degradation)
  };
  const CAT_META = {
    cafe:       { label: "Café",           emoji: "☕", class: "cat-cafe" },
    library:    { label: "Library",        emoji: "📚", class: "cat-library" },
    shopping:   { label: "Shopping",       emoji: "🛍️", class: "cat-shopping" },
    coworking:  { label: "Coworking",      emoji: "💻", class: "cat-coworking" },
    public:     { label: "Public building",emoji: "🏛️", class: "cat-public" },
    restaurant: { label: "Food",           emoji: "🍽️", class: "cat-restaurant" },
  };
  const AMEN_META = {
    wifi:       { label: "Wi-Fi",         emoji: "📶" },
    seats:      { label: "Seats",         emoji: "🪑" },
    power:      { label: "Power outlets", emoji: "🔌" },
    quiet:      { label: "Quiet",         emoji: "🤫" },
    accessible: { label: "Accessible",    emoji: "♿" },
    food:       { label: "Food & drinks", emoji: "🍴" },
  };
  const AC_META = {
    strong:     { label: "Strong AC",   short: "Strong", emoji: "❄️",  rank: 3 },
    weak:       { label: "Weak AC",     short: "Weak",   emoji: "🌬️", rank: 2 },
    none:       { label: "No AC",       short: "None",   emoji: "🥵",  rank: 1 },
    unverified: { label: "Unverified",  short: "Unverified", emoji: "❄️", rank: 0 },
  };
  const PROMOTE_THRESHOLD = 3;  // net votes to flip unverified → strong/none
  const acOf = (spot) => {
    // Legacy migration: old `temp` field
    if (typeof spot.temp === "number" && !spot.ac) {
      if (spot.temp <= 19) return "strong";
      if (spot.temp <= 22) return "weak";
      return "none";
    }
    // Auto-promote unverified spots based on community votes
    if (!spot.ac || spot.ac === "unverified") {
      const confirms = spot.confirms || 0;
      const denies = spot.denies || 0;
      const net = confirms - denies;
      if (net >= PROMOTE_THRESHOLD) return "strong";
      if (denies >= PROMOTE_THRESHOLD && net <= 0) return "none";
      return "unverified";
    }
    return AC_META[spot.ac] ? spot.ac : "unverified";
  };

  // ---------------- State ----------------
  const state = {
    spots: [],
    filters: { category: "all", sort: "nearest", search: "" },
    selectedId: null,
    hoverId: null,
    bounds: null,
    userLoc: null,                                  // set only when geolocation succeeds
    origin: { lat: 50.8798, lng: 4.7005 },          // stable reference for distance/"nearest" sort
    view: "list",
  };

  // ---------------- Storage helpers ----------------
  const load = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  };
  const save = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  };

  const userSpots = load(STORAGE.spots, []);
  const favorites = new Set(load(STORAGE.favs, []));
  const votes = load(STORAGE.votes, {});       // { id: "up" | "down" }
  const voteDelta = load(STORAGE.voteDelta, {}); // { id: { confirms: n, denies: n } }

  // ---------------- Helpers ----------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const haversineKm = (a, b) => {
    const toRad = (x) => x * Math.PI / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat/2)**2 + Math.sin(dLng/2)**2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const fmtKm = (km) => km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`;
  const acBadge = (spot) => {
    const a = AC_META[acOf(spot)];
    return `${a.emoji} ${a.short}`;
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const showToast = (msg) => {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.hidden = true; }, 2400);
  };

  // Holds the server's view of spots when API is up. Empty when offline (we fall back to seed).
  let serverSpots = [];

  const allSpots = () => {
    if (usingApi) return serverSpots.map((s) => ({ ...s }));
    // Offline fallback: merge bundled seed with locally-added spots, then apply local vote delta.
    const merged = [...(window.SEED_SPOTS || []), ...userSpots];
    return merged.map((s) => {
      const d = voteDelta[s.id] || { confirms: 0, denies: 0 };
      return {
        ...s,
        confirms: (s.confirms || 0) + d.confirms,
        denies: (s.denies || 0) + d.denies,
      };
    });
  };

  // ---------------- PocketBase API ----------------
  const recordToSpot = (r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    lat: r.lat,
    lng: r.lng,
    address: r.address || "",
    ac: r.ac,
    amenities: Array.isArray(r.amenities) ? r.amenities : [],
    description: r.description || "",
    nickname: r.nickname || "",
    photo: r.photo || "",
    confirms: r.confirms || 0,
    denies: r.denies || 0,
    likes_count: r.likes_count || 0,
    source: r.source,
    osm_id: r.osm_id,
  });

  const apiListSpots = async () => {
    const out = [];
    let page = 1;
    while (true) {
      const r = await fetch(`${API_SPOTS}?perPage=200&page=${page}`, { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error(`list ${r.status}`);
      const j = await r.json();
      out.push(...j.items.map(recordToSpot));
      if (page >= j.totalPages || j.items.length === 0) break;
      page++;
    }
    return out;
  };

  const apiCreateSpot = async (spot) => {
    const r = await fetch(API_SPOTS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: spot.name,
        category: spot.category,
        lat: spot.lat,
        lng: spot.lng,
        address: spot.address || "",
        ac: spot.ac || "unverified",
        amenities: spot.amenities || [],
        description: spot.description || "",
        nickname: spot.nickname || "",
        photo: spot.photo || "",
        confirms: 0,
        denies: 0,
        source: "user",
      }),
    });
    if (!r.ok) throw new Error(`create ${r.status}`);
    return recordToSpot(await r.json());
  };

  // Server-side counts are authoritative. We compute the next totals on the client
  // and PATCH them in. Race conditions are possible under concurrent edits but
  // acceptable for a single-cluster homelab demo.
  const apiPatchCounts = async (id, confirms, denies) => {
    const r = await fetch(`${API_SPOTS}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirms, denies }),
    });
    if (!r.ok) throw new Error(`patch ${r.status}`);
    return recordToSpot(await r.json());
  };

  // favoriteRecords: spotId -> favorite record id, so we know what to DELETE on unfavorite
  const favoriteRecords = new Map();

  const apiListMyFavorites = async () => {
    // The collection's listRule restricts to rows matching the query's device_id, so this
    // returns exactly THIS device's favorites — anyone else's are invisible.
    const r = await fetch(`${API_FAVS}?perPage=500&device_id=${encodeURIComponent(deviceId)}`);
    if (!r.ok) throw new Error(`favs list ${r.status}`);
    const j = await r.json();
    return j.items; // [{ id, device_id, spot, ... }]
  };

  const apiCreateFavorite = async (spotId) => {
    const r = await fetch(API_FAVS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, spot: spotId }),
    });
    if (!r.ok) throw new Error(`fav create ${r.status}`);
    return await r.json();
  };

  const apiDeleteFavorite = async (favRecordId) => {
    const r = await fetch(`${API_FAVS}/${favRecordId}?device_id=${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    });
    if (!r.ok && r.status !== 404) throw new Error(`fav delete ${r.status}`);
  };

  const getDistance = (spot) => {
    const origin = state.userLoc || state.origin;
    return haversineKm(origin, { lat: spot.lat, lng: spot.lng });
  };

  // ---------------- Map ----------------
  let map;
  let miniMap;       // for Add Spot
  let detailMap;     // for detail panel
  let addPinMarker;
  const markers = new Map(); // id -> { marker, el }

  const initialView = () => {
    const params = new URLSearchParams(location.search);
    const lat = parseFloat(params.get("lat"));
    const lng = parseFloat(params.get("lng"));
    const zoom = parseFloat(params.get("zoom"));
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      return { lat, lng, zoom: Number.isNaN(zoom) ? 15 : zoom };
    }
    return window.LEUVEN_CENTER;
  };

  const buildMarkerIcon = (spot) => {
    const fav = favorites.has(spot.id) ? " is-fav" : "";
    return L.divIcon({
      className: "cs-marker-wrap",
      html: `<div class="cs-marker${fav}" data-id="${spot.id}" title="${spot.name}">${CAT_META[spot.category]?.emoji || "📍"}</div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
  };

  const setupMap = () => {
    const start = initialView();
    map = L.map("map", { zoomControl: true, attributionControl: true })
      .setView([start.lat, start.lng], start.zoom);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);

    // Render all markers
    state.spots.forEach(addSpotMarker);

    map.on("moveend", onMapMove);
    map.on("zoomend", onMapMove);

    // Sync bounds on first frame
    requestAnimationFrame(onMapMove);
  };

  const addSpotMarker = (spot) => {
    const marker = L.marker([spot.lat, spot.lng], { icon: buildMarkerIcon(spot) }).addTo(map);
    marker.on("click", () => {
      selectSpot(spot.id, { panTo: false });
      scrollCardIntoView(spot.id);
    });
    marker.on("mouseover", () => setHover(spot.id, true));
    marker.on("mouseout", () => setHover(spot.id, false));
    markers.set(spot.id, marker);
  };

  const removeSpotMarker = (id) => {
    const m = markers.get(id);
    if (m) { map.removeLayer(m); markers.delete(id); }
  };

  const refreshMarker = (id) => {
    const spot = state.spots.find((s) => s.id === id);
    if (!spot) return;
    removeSpotMarker(id);
    addSpotMarker(spot);
  };

  const setMarkerActive = (id, active) => {
    const m = markers.get(id);
    if (!m) return;
    const el = m.getElement()?.querySelector(".cs-marker");
    if (!el) return;
    el.classList.toggle("is-active", active);
  };
  const setMarkerHover = (id, hover) => {
    const m = markers.get(id);
    const el = m?.getElement()?.querySelector(".cs-marker");
    if (el) el.style.transform = hover ? "scale(1.12)" : "";
  };

  const onMapMove = () => {
    state.bounds = map.getBounds();
    syncUrlFromMap();
    renderList();
    $("#map-search-here").hidden = true; // keep simple — we filter live
  };

  const syncUrlFromMap = debounce(() => {
    const c = map.getCenter();
    const params = new URLSearchParams(location.search);
    params.set("lat", c.lat.toFixed(5));
    params.set("lng", c.lng.toFixed(5));
    params.set("zoom", String(Math.round(map.getZoom())));
    if (state.selectedId) params.set("spot", state.selectedId);
    history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  }, 200);

  // ---------------- List rendering ----------------
  const visibleSpots = () => {
    const { category, sort, search } = state.filters;
    const q = search.trim().toLowerCase();
    let out = state.spots.filter((s) => {
      if (category !== "all" && s.category !== category) return false;
      if (q && !s.name.toLowerCase().includes(q) && !s.address.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
      if (state.bounds && !state.bounds.contains([s.lat, s.lng])) return false;
      return true;
    });
    if (sort === "nearest") out.sort((a, b) => getDistance(a) - getDistance(b));
    if (sort === "coolest") out.sort((a, b) => AC_META[acOf(b)].rank - AC_META[acOf(a)].rank);
    if (sort === "confirmed") out.sort((a, b) => b.confirms - a.confirms);
    if (sort === "loved") out.sort((a, b) => (b.likes_count || 0) - (a.likes_count || 0));
    return out;
  };

  const cardHTML = (spot) => {
    const cat = CAT_META[spot.category] || CAT_META.public;
    const dist = fmtKm(getDistance(spot));
    const fav = favorites.has(spot.id);
    const amenChips = (spot.amenities || []).slice(0, 4).map((a) => `<span class="amen">${AMEN_META[a]?.label || a}</span>`).join("");
    const photoHTML = spot.photo
      ? `<img class="card-img" src="${spot.photo}" alt="" loading="lazy" onerror="this.remove()" />`
      : "";
    return `
      <article class="card ${cat.class}" data-id="${spot.id}">
        <button class="heart ${fav ? "is-fav" : ""}" data-fav="${spot.id}" aria-label="${fav ? "Unfavorite" : "Favorite"}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
        <div class="card-art">
          ${photoHTML}
          <div class="card-icon">${cat.emoji}</div>
        </div>
        <div class="card-body">
          <h3 class="card-name">${escapeHtml(spot.name)}</h3>
          <div class="card-meta">
            <span class="meta-chip ac-${acOf(spot)}">${acBadge(spot)}</span>
            <span class="meta-sep">·</span>
            <span class="meta-dist">${dist}</span>
            ${spot.likes_count > 0 ? `<span class="meta-sep">·</span><span class="meta-likes">❤️ ${spot.likes_count}</span>` : ""}
          </div>
          <p class="card-desc">${escapeHtml(spot.description || "")}</p>
          <div class="amen-row">${amenChips}</div>
          <div class="card-foot">
            <span class="confirms">✓ ${spot.confirms} confirms</span>
            <button class="card-cta" data-view-id="${spot.id}">View</button>
          </div>
        </div>
      </article>
    `;
  };

  const escapeHtml = (s) => (s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

  const renderList = () => {
    const spots = visibleSpots();
    const list = $("#list");
    list.innerHTML = spots.map(cardHTML).join("");
    $("#list-count").textContent = `${spots.length} ${spots.length === 1 ? "spot" : "spots"}`;
    $("#list-empty").hidden = spots.length !== 0;
    list.style.display = spots.length === 0 ? "none" : "";

    // Restore active/hover state in DOM
    if (state.selectedId) {
      list.querySelector(`.card[data-id="${state.selectedId}"]`)?.classList.add("is-active");
    }
  };

  // ---------------- Selection / hover ----------------
  const selectSpot = (id, { panTo = true } = {}) => {
    state.selectedId = id;
    // Update card states
    $$(".card").forEach((c) => c.classList.toggle("is-active", c.dataset.id === id));
    // Update markers
    markers.forEach((m, mid) => setMarkerActive(mid, mid === id));
    if (id) {
      openDetail(id);
      const spot = state.spots.find((s) => s.id === id);
      if (spot && panTo) {
        map.flyTo([spot.lat, spot.lng], Math.max(map.getZoom(), 16), { duration: 0.4 });
      }
    }
    syncUrlFromMap();
  };

  const setHover = (id, on) => {
    state.hoverId = on ? id : null;
    $$(".card").forEach((c) => c.classList.toggle("is-hover", on && c.dataset.id === id));
    setMarkerHover(id, on);
  };

  const scrollCardIntoView = (id) => {
    const card = $(`.card[data-id="${id}"]`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // ---------------- Favorites ----------------
  // Optimistic toggle: flip UI immediately, sync to server, roll back on failure.
  const bumpLocalLikeCount = (id, delta) => {
    const idx = serverSpots.findIndex((s) => s.id === id);
    if (idx >= 0) serverSpots[idx] = { ...serverSpots[idx], likes_count: Math.max(0, (serverSpots[idx].likes_count || 0) + delta) };
    const sidx = state.spots.findIndex((s) => s.id === id);
    if (sidx >= 0) state.spots[sidx] = { ...state.spots[sidx], likes_count: Math.max(0, (state.spots[sidx].likes_count || 0) + delta) };
  };

  const toggleFav = async (id) => {
    const wasFav = favorites.has(id);

    // Optimistic UI update
    if (wasFav) {
      favorites.delete(id);
    } else {
      favorites.add(id);
    }
    if (usingApi) bumpLocalLikeCount(id, wasFav ? -1 : +1);
    save(STORAGE.favs, Array.from(favorites)); // localStorage still mirrors current set
    refreshMarker(id);
    renderList(); // re-render so the heart-count chip updates inline
    $$(`.heart[data-fav="${id}"]`).forEach((el) => el.classList.toggle("is-fav", favorites.has(id)));
    if (state.selectedId === id) $(".detail-fav")?.classList.toggle("is-fav", favorites.has(id));

    // Server sync (no-op when offline)
    if (!usingApi) return;
    try {
      if (wasFav) {
        const favRecId = favoriteRecords.get(id);
        if (favRecId) {
          await apiDeleteFavorite(favRecId);
          favoriteRecords.delete(id);
        }
      } else {
        const created = await apiCreateFavorite(id);
        favoriteRecords.set(id, created.id);
      }
    } catch (err) {
      // Roll back the optimistic flip
      if (wasFav) favorites.add(id);
      else favorites.delete(id);
      if (usingApi) bumpLocalLikeCount(id, wasFav ? +1 : -1);
      save(STORAGE.favs, Array.from(favorites));
      refreshMarker(id);
      renderList();
      $$(`.heart[data-fav="${id}"]`).forEach((el) => el.classList.toggle("is-fav", favorites.has(id)));
      if (state.selectedId === id) $(".detail-fav")?.classList.toggle("is-fav", favorites.has(id));
      showToast("Couldn't save favorite — try again");
    }
  };

  // ---------------- Detail panel ----------------
  const openDetail = (id) => {
    const spot = state.spots.find((s) => s.id === id);
    if (!spot) return;
    const cat = CAT_META[spot.category] || CAT_META.public;
    const fav = favorites.has(id);
    const myVote = votes[id];

    const amenItems = Object.entries(AMEN_META).map(([key, meta]) => {
      const has = (spot.amenities || []).includes(key);
      return `<div class="amen-item ${has ? "" : "off"}"><span class="dot"></span>${meta.label}</div>`;
    }).join("");

    const presentAmen = (spot.amenities || []);
    const amenChips = presentAmen.length
      ? presentAmen.map((a) => `<span class="amen-chip">${AMEN_META[a]?.emoji || "·"} ${AMEN_META[a]?.label || a}</span>`).join("")
      : `<span class="amen-chip muted">No amenities listed</span>`;

    const heroHTML = spot.photo
      ? `<div class="detail-hero-img ${cat.class}"><img src="${spot.photo}" alt="" onerror="this.parentNode.classList.add('no-img'); this.remove()" /></div>`
      : `<div class="detail-hero-img no-img ${cat.class}"><span class="hero-fallback-icon">${cat.emoji}</span></div>`;

    const inner = `
      <div class="detail-top">
        <button class="detail-close" aria-label="Close detail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
        <span class="detail-cat-chip ${cat.class}">${cat.emoji} ${cat.label}</span>
        <button class="detail-fav ${fav ? "is-fav" : ""}" aria-label="Favorite">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
      </div>
      ${heroHTML}
      <div class="detail-body">
        <h2 class="detail-title">${escapeHtml(spot.name)}</h2>
        <div class="detail-stats">
          <span class="stat"><span class="stat-icon">${AC_META[acOf(spot)].emoji}</span><span><b>${AC_META[acOf(spot)].short}</b><span class="stat-sub">AC level</span></span></span>
          <span class="stat"><span class="stat-icon">📍</span><span><b>${fmtKm(getDistance(spot))}</b><span class="stat-sub">away</span></span></span>
          <span class="stat"><span class="stat-icon">❤️</span><span><b>${spot.likes_count || 0}</b><span class="stat-sub">liked it</span></span></span>
        </div>

        <p class="detail-desc">${escapeHtml(spot.description || "")}</p>

        <div class="detail-actions">
          <a class="action-btn primary" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
            Directions
          </a>
          <button class="action-btn" data-share>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>
            Share
          </button>
        </div>

        <div class="detail-section">
          <h4>Amenities</h4>
          <div class="amen-chips">${amenChips}</div>
        </div>

        <div class="detail-section">
          <h4>Address</h4>
          <div class="detail-address-row">
            <span class="addr-text">${escapeHtml(spot.address)}</span>
          </div>
          <div class="detail-mini-map" id="detail-mini-map"></div>
        </div>

        <div class="confirm-box">
          <div class="confirm-q">
            <span>${acOf(spot) === "unverified" ? "Help verify — does this place have AC?" : "Still has AC today?"}</span>
            <span class="confirm-meta">added by ${escapeHtml(spot.nickname || "anon")}</span>
          </div>
          <div class="confirm-actions">
            <button class="vote-btn up ${myVote === "up" ? "is-active" : ""}" data-vote="up">
              <span>👍 Yes, cold</span><span class="count">${spot.confirms}</span>
            </button>
            <button class="vote-btn down ${myVote === "down" ? "is-active" : ""}" data-vote="down">
              <span>👎 Not really</span><span class="count">${spot.denies}</span>
            </button>
          </div>
        </div>
      </div>
    `;
    const host = $("#detail-inner");
    host.innerHTML = inner;
    $("#detail").classList.add("open");
    $("#detail").setAttribute("aria-hidden", "false");

    // Mini map
    if (detailMap) { detailMap.remove(); detailMap = null; }
    detailMap = L.map("detail-mini-map", {
      zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, attributionControl: false,
    }).setView([spot.lat, spot.lng], 15);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20, subdomains: "abcd",
    }).addTo(detailMap);
    L.marker([spot.lat, spot.lng], { icon: buildMarkerIcon(spot) }).addTo(detailMap);

    // Wire detail actions
    host.querySelector(".detail-close").addEventListener("click", closeDetail);
    host.querySelector(".detail-fav").addEventListener("click", () => toggleFav(spot.id));
    host.querySelectorAll(".vote-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyVote(spot.id, btn.dataset.vote);
      });
    });
    host.querySelector("[data-share]")?.addEventListener("click", async () => {
      const url = `${location.origin}${location.pathname}?spot=${spot.id}&lat=${spot.lat}&lng=${spot.lng}&zoom=16`;
      try {
        if (navigator.share) {
          await navigator.share({ title: spot.name, text: spot.description, url });
        } else {
          await navigator.clipboard.writeText(url);
          showToast("Link copied");
        }
      } catch { /* user cancelled */ }
    });
  };

  const closeDetail = () => {
    $("#detail").classList.remove("open");
    $("#detail").setAttribute("aria-hidden", "true");
    state.selectedId = null;
    $$(".card").forEach((c) => c.classList.remove("is-active"));
    markers.forEach((m, mid) => setMarkerActive(mid, false));
    if (detailMap) { detailMap.remove(); detailMap = null; }
    syncUrlFromMap();
  };

  const applyVote = async (id, kind) => {
    const prev = votes[id];
    const spot = state.spots.find((s) => s.id === id);
    if (!spot) return;

    if (usingApi) {
      // Compute next counts from the current server view and PATCH.
      let confirms = spot.confirms || 0;
      let denies = spot.denies || 0;
      if (prev === "up")   confirms = Math.max(0, confirms - 1);
      if (prev === "down") denies   = Math.max(0, denies - 1);
      if (prev !== kind) {
        if (kind === "up") confirms += 1;
        else denies += 1;
      }
      let updated;
      try { updated = await apiPatchCounts(id, confirms, denies); }
      catch (err) { showToast("Couldn't save vote"); return; }
      // Update local server view + per-user vote record
      const idx = serverSpots.findIndex((s) => s.id === id);
      if (idx >= 0) serverSpots[idx] = updated;
      if (prev === kind) delete votes[id]; else votes[id] = kind;
      save(STORAGE.votes, votes);
    } else {
      // Offline fallback — old local-delta logic.
      if (!voteDelta[id]) voteDelta[id] = { confirms: 0, denies: 0 };
      if (prev === "up")   voteDelta[id].confirms -= 1;
      if (prev === "down") voteDelta[id].denies   -= 1;
      if (prev === kind) {
        delete votes[id];
      } else {
        votes[id] = kind;
        if (kind === "up") voteDelta[id].confirms += 1;
        else voteDelta[id].denies += 1;
      }
      save(STORAGE.votes, votes);
      save(STORAGE.voteDelta, voteDelta);
    }

    state.spots = allSpots();
    renderList();
    openDetail(id); // re-render detail to reflect new counts
  };

  // ---------------- Filters / search / sort ----------------
  const wireFilters = () => {
    $("#filter-pills").addEventListener("click", (e) => {
      const pill = e.target.closest(".pill");
      if (!pill) return;
      $$("#filter-pills .pill").forEach((p) => p.classList.toggle("active", p === pill));
      state.filters.category = pill.dataset.cat;
      renderList();
      updateMarkersForCategory();
    });
    $("#sort-select").addEventListener("change", (e) => {
      state.filters.sort = e.target.value;
      renderList();
    });
    $("#location-input").addEventListener("input", debounce((e) => {
      state.filters.search = e.target.value;
      renderList();
    }, 150));
    $("#location-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        geocodeAndFly(e.target.value);
      }
    });
  };

  const updateMarkersForCategory = () => {
    const cat = state.filters.category;
    state.spots.forEach((s) => {
      const m = markers.get(s.id);
      if (!m) return;
      const visible = cat === "all" || s.category === cat;
      const el = m.getElement();
      if (el) el.style.display = visible ? "" : "none";
    });
  };

  // ---------------- List interactions ----------------
  const wireListEvents = () => {
    const list = $("#list");
    list.addEventListener("click", (e) => {
      const favBtn = e.target.closest("[data-fav]");
      if (favBtn) {
        e.stopPropagation();
        toggleFav(favBtn.dataset.fav);
        return;
      }
      const viewBtn = e.target.closest("[data-view-id]");
      if (viewBtn) {
        e.stopPropagation();
        selectSpot(viewBtn.dataset.viewId);
        return;
      }
      const card = e.target.closest(".card");
      if (card) selectSpot(card.dataset.id);
    });
    list.addEventListener("mouseover", (e) => {
      const card = e.target.closest(".card");
      if (card) setHover(card.dataset.id, true);
    });
    list.addEventListener("mouseout", (e) => {
      const card = e.target.closest(".card");
      if (card) setHover(card.dataset.id, false);
    });
  };

  // ---------------- Add Spot modal ----------------
  let addPin = null;
  const openAddModal = () => {
    $("#add-modal").classList.add("open");
    $("#add-modal").setAttribute("aria-hidden", "false");
    setTimeout(() => {
      if (!miniMap) {
        miniMap = L.map("add-map").setView([window.LEUVEN_CENTER.lat, window.LEUVEN_CENTER.lng], 14);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
          maxZoom: 20, subdomains: "abcd",
        }).addTo(miniMap);
        miniMap.on("click", (e) => placeAddPin(e.latlng));
      } else {
        miniMap.invalidateSize();
      }
    }, 60);
  };
  const closeAddModal = () => {
    $("#add-modal").classList.remove("open");
    $("#add-modal").setAttribute("aria-hidden", "true");
  };

  const placeAddPin = (latlng) => {
    addPin = { lat: latlng.lat, lng: latlng.lng };
    if (addPinMarker) miniMap.removeLayer(addPinMarker);
    addPinMarker = L.marker([addPin.lat, addPin.lng], {
      icon: L.divIcon({
        className: "cs-marker-wrap",
        html: `<div class="cs-marker is-active">📍</div>`,
        iconSize: [36, 36], iconAnchor: [18, 18],
      }),
    }).addTo(miniMap);
    $("#coord-hint").textContent = `Pin placed at ${addPin.lat.toFixed(5)}, ${addPin.lng.toFixed(5)}`;
  };

  const geocode = async (q) => {
    if (!q || !q.trim()) return null;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    try {
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      const j = await r.json();
      if (j && j[0]) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), name: j[0].display_name };
    } catch (e) { /* network */ }
    return null;
  };

  const geocodeAndFly = async (q) => {
    if (!q.trim()) return;
    showToast("Finding location…");
    const r = await geocode(q + " Belgium");
    if (r) {
      state.origin = { lat: r.lat, lng: r.lng };
      map.flyTo([r.lat, r.lng], 14, { duration: 0.6 });
      renderList();
      showToast(`Showing ${q}`);
    } else {
      showToast("Couldn't find that place");
    }
  };

  const wireAddModal = () => {
    $("#open-add-modal-top").addEventListener("click", openAddModal);
    $("#add-modal").querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeAddModal));
    $("#geocode-btn").addEventListener("click", async () => {
      const r = await geocode($("#add-address").value);
      if (r) {
        placeAddPin({ lat: r.lat, lng: r.lng });
        miniMap.flyTo([r.lat, r.lng], 16, { duration: 0.5 });
      } else {
        showToast("Couldn't find address");
      }
    });
    $("#add-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!addPin) {
        showToast("Drop a pin on the map first");
        return;
      }
      const amenities = Array.from(document.querySelectorAll("#add-form .check input:checked")).map((i) => i.value);
      const acVal = document.querySelector("#add-form input[name='ac']:checked")?.value || "weak";
      const draft = {
        name: $("#add-name").value.trim() || "New spot",
        category: $("#add-category").value,
        lat: addPin.lat, lng: addPin.lng,
        address: $("#add-address").value.trim() || `${addPin.lat.toFixed(5)}, ${addPin.lng.toFixed(5)}`,
        ac: acVal,
        amenities,
        description: $("#add-desc").value.trim(),
        nickname: $("#add-nick").value.trim() || "Anonymous Penguin",
      };

      let saved;
      if (usingApi) {
        try {
          saved = await apiCreateSpot(draft);
          serverSpots.push(saved);
        } catch (err) {
          showToast("Couldn't save — try again");
          return;
        }
      } else {
        // Offline path: same behavior as before — local-only persistence
        saved = { ...draft, id: `u-${Date.now().toString(36)}`, confirms: 1, denies: 0, source: "user", createdAt: new Date().toISOString().slice(0, 10) };
        userSpots.push(saved);
        save(STORAGE.spots, userSpots);
      }

      state.spots = allSpots();
      addSpotMarker(saved);
      renderList();
      closeAddModal();
      showToast(usingApi ? "Spot saved — visible to everyone" : "Spot added (offline — won't sync)");

      // Reset form
      $("#add-form").reset();
      addPin = null;
      if (addPinMarker) { miniMap.removeLayer(addPinMarker); addPinMarker = null; }
      $("#coord-hint").textContent = "No pin placed yet";
      // Highlight in map
      map.flyTo([saved.lat, saved.lng], 16, { duration: 0.6 });
      setTimeout(() => selectSpot(saved.id, { panTo: false }), 500);
    });
  };

  // ---------------- Mobile UI ----------------
  const wireMobile = () => {
    $("#fab-toggle").addEventListener("click", () => {
      const isMap = document.body.classList.toggle("view-map");
      $("#fab-icon-map").hidden = isMap;
      $("#fab-icon-list").hidden = !isMap;
      $("#fab-label").textContent = isMap ? "List" : "Map";
      if (isMap && map) setTimeout(() => map.invalidateSize(), 100);
      // Update bottom nav state
      $$(".mnav").forEach((b) => b.classList.toggle("active", b.dataset.view === (isMap ? "map" : "explore")));
    });
    $$(".mnav").forEach((b) => {
      b.addEventListener("click", () => {
        const v = b.dataset.view;
        $$(".mnav").forEach((x) => x.classList.toggle("active", x === b));
        if (v === "add") { openAddModal(); return; }
        if (v === "favorites") {
          state.filters.category = "all";
          state.filters.search = "";
          $("#location-input").value = "";
          $$("#filter-pills .pill").forEach((p) => p.classList.toggle("active", p.dataset.cat === "all"));
          renderList();
          // Filter to favorites only
          const favSpots = state.spots.filter((s) => favorites.has(s.id));
          const list = $("#list");
          if (favSpots.length === 0) {
            list.innerHTML = `<div class="list-empty" style="display:block"><div class="empty-emoji">💙</div><h3>No favorites yet</h3><p>Tap the heart on any card to save it.</p></div>`;
          } else {
            list.innerHTML = favSpots.map(cardHTML).join("");
          }
          $("#list-count").textContent = `${favSpots.length} ${favSpots.length === 1 ? "favorite" : "favorites"}`;
          document.body.classList.remove("view-map");
          return;
        }
        if (v === "map") {
          document.body.classList.add("view-map");
          $("#fab-icon-map").hidden = true;
          $("#fab-icon-list").hidden = false;
          $("#fab-label").textContent = "List";
          if (map) setTimeout(() => map.invalidateSize(), 100);
        } else {
          document.body.classList.remove("view-map");
          $("#fab-icon-map").hidden = false;
          $("#fab-icon-list").hidden = true;
          $("#fab-label").textContent = "Map";
          renderList();
        }
      });
    });
  };

  // ---------------- Geolocate ----------------
  const wireGeo = () => {
    $("#locate-me").addEventListener("click", () => {
      if (!navigator.geolocation) { showToast("Geolocation not available"); return; }
      showToast("Locating…");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          map.flyTo([state.userLoc.lat, state.userLoc.lng], 15, { duration: 0.5 });
          renderList();
          showToast("Centered on you");
        },
        () => showToast("Couldn't get your location"),
        { enableHighAccuracy: false, timeout: 8000 }
      );
    });
  };

  // ---------------- Keyboard ----------------
  const wireKeys = () => {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("#add-modal").classList.contains("open")) closeAddModal();
        else if ($("#detail").classList.contains("open")) closeDetail();
      }
    });
  };

  // ---------------- Deep link ----------------
  const handleDeepLink = () => {
    const params = new URLSearchParams(location.search);
    const spotId = params.get("spot");
    if (spotId && state.spots.find((s) => s.id === spotId)) {
      // Wait a frame so map is settled
      setTimeout(() => selectSpot(spotId), 250);
    }
  };

  // ---------------- Boot ----------------
  const boot = async () => {
    // Try the API first; fall back to the bundled seed if PB isn't reachable.
    try {
      serverSpots = await apiListSpots();
      usingApi = true;
    } catch (e) {
      console.warn("[coolspots] PocketBase unreachable — using local seed only:", e.message);
      usingApi = false;
      showToast("Offline mode — your changes won't sync");
    }
    // Online → fetch this device's favorites from the server and prime the local set.
    // Offline → keep using whatever's in localStorage (already loaded into `favorites`).
    if (usingApi) {
      try {
        const myFavs = await apiListMyFavorites();
        favorites.clear();
        favoriteRecords.clear();
        for (const f of myFavs) {
          favorites.add(f.spot);
          favoriteRecords.set(f.spot, f.id);
        }
      } catch (e) {
        console.warn("[coolspots] couldn't load favorites from server:", e.message);
      }
    }
    state.spots = allSpots();
    setupMap();
    renderList();
    wireFilters();
    wireListEvents();
    wireAddModal();
    wireMobile();
    wireGeo();
    wireKeys();
    handleDeepLink();
  };

  document.addEventListener("DOMContentLoaded", boot);
})();
