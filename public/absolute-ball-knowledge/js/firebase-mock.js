// Test-only Firestore-shaped adapter. It is enabled solely by ?mock=1 and keeps
// data in memory; it never uses localStorage and is not the deployed data source.
const seed = {
  players: [
    { id: "alex", name: "Alex", normalizedName: "alex" },
    { id: "blair", name: "Blair", normalizedName: "blair" },
    { id: "casey", name: "Casey", normalizedName: "casey" },
  ],
  matches: [{ id: "opening-match", teamA: { playerIds: ["alex"] }, teamB: { playerIds: ["blair"] }, scoreA: 10, scoreB: 7, winner: "A", modelVersion: "score_logistic_v1" }],
};

class MockTimestamp {
  constructor(value = Date.now()) { this.value = value; }
  toDate() { return new Date(this.value); }
  toMillis() { return this.value; }
  isEqual(other) { return this.value === other?.toMillis?.(); }
}
const timestamp = () => new MockTimestamp();
function clone(value) {
  if (value instanceof MockTimestamp) return new MockTimestamp(value.value);
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}
const isServerTimestamp = (value) => value?.__mockServerTimestamp === true;
function hydrate(value) {
  if (Array.isArray(value)) return value.map(hydrate);
  if (!value || typeof value !== "object") return value;
  if (value.__mockTimestamp != null) return new MockTimestamp(value.__mockTimestamp);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item)]));
}
function dehydrate(value) {
  if (value instanceof MockTimestamp) return { __mockTimestamp: value.toMillis() };
  if (Array.isArray(value)) return value.map(dehydrate);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dehydrate(item)]));
}

export function createMockDb() {
  const now = timestamp();
  const db = { data: { players: new Map(), matches: new Map() }, listeners: new Set(), sequence: 1 };
  for (const [collectionName, rows] of Object.entries(seed)) for (const row of rows) {
    // The document ID is a key, never a stored field: Firestore documents do not
    // contain their own id, and the security rules reject the extra key.
    const { id, ...fields } = row;
    db.data[collectionName].set(id, { ...clone(fields), createdAt: now, updatedAt: now, _version: db.sequence++ });
  }
  db.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("abk-firestore-mock-v1") : null;
  if (db.channel) db.channel.onmessage = ({ data }) => { if (data?.type === "write") apply(db, hydrate(data.operation), false); };
  return db;
}
export const collection = (db, name) => ({ db, collection: name });
export const doc = (base, ...parts) => {
  if (typeof base?.collection === "string") return { db: base.db, collection: base.collection, id: parts[0] || `mock-${base.db.sequence++}` };
  return { db: base, collection: parts[0], id: parts[1] };
};
export const where = (field, op, value) => ({ field, op, value });
export const query = (base, condition) => ({ ...base, condition });
export const serverTimestamp = () => ({ __mockServerTimestamp: true });
function dataOf(item) { return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "_version")); }
// Deliberately the same surface as the Firestore Web SDK's DocumentSnapshot: id,
// exists(), data() and metadata. It must not expose the Admin SDK's updateTime,
// or client code could depend on a document version the browser never receives.
function snapshot(id, item) {
  return { id, exists: () => Boolean(item), data: () => item ? clone(dataOf(item)) : undefined, metadata: { hasPendingWrites: false, fromCache: false } };
}
function matches(item, condition) {
  if (!condition) return true;
  const value = condition.field.split(".").reduce((result, key) => result?.[key], item);
  return condition.op === "==" ? value === condition.value : Array.isArray(value) && value.includes(condition.value);
}
function snapshots(target) {
  const rows = [...target.db.data[target.collection].entries()].filter(([, item]) => matches(item, target.condition));
  return { docs: rows.map(([id, item]) => snapshot(id, item)) };
}
function resolve(value) {
  if (isServerTimestamp(value)) return timestamp();
  if (Array.isArray(value)) return value.map(resolve);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
}
function notify(db) { for (const listener of db.listeners) listener(); }
function apply(db, operation, broadcast = true) {
  const bucket = db.data[operation.collection];
  if (operation.type === "delete") bucket.delete(operation.id);
  else {
    const old = bucket.get(operation.id) || {};
    bucket.set(operation.id, { ...old, ...resolve(operation.change), _version: db.sequence++ });
  }
  notify(db);
  if (broadcast && db.channel) db.channel.postMessage({ type: "write", operation: dehydrate(operation) });
}
export async function getDocs(target) { return snapshots(target); }
export function onSnapshot(target, callback) {
  const listener = () => callback(snapshots(target));
  target.db.listeners.add(listener); queueMicrotask(listener);
  return () => target.db.listeners.delete(listener);
}
export async function setDoc(target, change) { apply(target.db, { type: "set", collection: target.collection, id: target.id, change }); }
export async function runTransaction(db, callback) {
  const transaction = {
    async get(target) {
      // The Firestore Web SDK's Transaction.get only accepts a DocumentReference and
      // fails on a query. Refusing it here too keeps mock-only code from reaching
      // production, where the same call throws.
      if (target.condition) throw new TypeError("Transaction.get() requires a DocumentReference; queries cannot be read in a transaction.");
      return snapshot(target.id, target.db.data[target.collection].get(target.id));
    },
    update(target, change) { apply(db, { type: "update", collection: target.collection, id: target.id, change }); },
    delete(target) { apply(db, { type: "delete", collection: target.collection, id: target.id }); },
    set(target, change) { apply(db, { type: "set", collection: target.collection, id: target.id, change }); },
  };
  return callback(transaction);
}
