/// <reference path="../pb_data/types.d.ts" />
// Denormalized public counter: how many devices have favorited this spot.
// Kept in sync via a hook on the `favorites` collection (see pb_hooks/likes_count.pb.js).

migrate((db) => {
  const dao = new Dao(db);
  const collection = dao.findCollectionByNameOrId("spots");
  collection.schema.addField(new SchemaField({
    "system": false,
    "id":      "likescntfld00",
    "name":    "likes_count",
    "type":    "number",
    "required": false,
    "presentable": false,
    "unique": false,
    "options": { "min": 0, "max": null, "noDecimal": true }
  }));
  return dao.saveCollection(collection);
}, (db) => {
  const dao = new Dao(db);
  const collection = dao.findCollectionByNameOrId("spots");
  collection.schema.removeField("likescntfld00");
  return dao.saveCollection(collection);
});
