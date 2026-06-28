/// <reference path="../pb_data/types.d.ts" />
// `favorites` junction collection: each row is (device_id, spot).
// Unique constraint on (device_id, spot) prevents double-favoriting at the DB layer.
// API rules scope list/delete to "rows whose device_id matches the device_id you sent".
// No auth — anonymous demo. If you scale this beyond a homelab, replace device_id with an auth'd user_id.

migrate((db) => {
  const dao = new Dao(db);
  const spots = dao.findCollectionByNameOrId("spots");

  const favorites = new Collection({
    name: "favorites",
    type: "base",
    system: false,
    // Only show rows where the client-supplied device_id query param matches.
    listRule:   "device_id = @request.query.device_id",
    viewRule:   "device_id = @request.query.device_id",
    createRule: "",
    updateRule: null,  // immutable; toggle by delete + create
    deleteRule: "device_id = @request.query.device_id",
    schema: [
      { name: "device_id", type: "text", required: true, options: { max: 64 } },
      { name: "spot", type: "relation", required: true, options: {
        collectionId: spots.id,
        cascadeDelete: true,
        maxSelect: 1,
        minSelect: null,
      }},
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_fav_device_spot ON favorites (device_id, spot)",
      "CREATE INDEX idx_fav_device ON favorites (device_id)",
    ],
  });

  return dao.saveCollection(favorites);
}, (db) => {
  const dao = new Dao(db);
  try {
    const c = dao.findCollectionByNameOrId("favorites");
    return dao.deleteCollection(c);
  } catch (e) { return null; }
});
