/// <reference path="../pb_data/types.d.ts" />
// Creates the `spots` collection with open read/write rules for the homelab demo.
// Tighten the rules later (admin-only delete, rate-limit create) when this is live.

migrate((db) => {
  const collection = new Collection({
    name: "spots",
    type: "base",
    system: false,
    // Open public access for crowdsourced demo. Lock down for production.
    listRule:   "",
    viewRule:   "",
    createRule: "",
    updateRule: "",  // needed for vote increments
    deleteRule: null, // null = admin-only via /_/
    schema: [
      { name: "name",        type: "text",   required: true,  options: { min: 1, max: 200 } },
      { name: "category",    type: "select", required: true,  options: { maxSelect: 1, values: ["cafe","library","shopping","coworking","public","restaurant"] } },
      { name: "lat",         type: "number", required: true,  options: { noDecimal: false } },
      { name: "lng",         type: "number", required: true,  options: { noDecimal: false } },
      { name: "address",     type: "text",   options: { max: 300 } },
      { name: "ac",          type: "select", required: true,  options: { maxSelect: 1, values: ["strong","weak","none","unverified"] } },
      { name: "amenities",   type: "json",   options: { maxSize: 4096 } },
      { name: "description", type: "text",   options: { max: 500 } },
      { name: "nickname",    type: "text",   options: { max: 50 } },
      { name: "photo",       type: "url",    options: {} },
      { name: "confirms",    type: "number", options: { min: 0 } },
      { name: "denies",      type: "number", options: { min: 0 } },
      { name: "source",      type: "select", options: { maxSelect: 1, values: ["osm","user"] } },
      { name: "osm_id",      type: "text",   options: { max: 64 } },
    ],
    indexes: [
      "CREATE INDEX idx_spots_category ON spots (category)",
      "CREATE INDEX idx_spots_geo ON spots (lat, lng)",
      "CREATE INDEX idx_spots_osm_id ON spots (osm_id)",
    ],
  });

  return Dao(db).saveCollection(collection);
}, (db) => {
  const dao = new Dao(db);
  try {
    const collection = dao.findCollectionByNameOrId("spots");
    return dao.deleteCollection(collection);
  } catch (e) {
    return null;
  }
});
