const USERNAME_PATTERN = /^[A-Za-z0-9_]{4,24}$/;

function normalizedUsername(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : "";
}

function normalizedEmail(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.length <= 254 ? normalized : "";
}

function addIndex(index, key, userId) {
  if (!key || !userId) return;
  let ids = index.get(key);
  if (!ids) {
    ids = new Set();
    index.set(key, ids);
  }
  ids.add(userId);
}

function removeIndex(index, key, userId) {
  if (!key || !userId) return;
  const ids = index.get(key);
  if (!ids) return;
  ids.delete(userId);
  if (ids.size === 0) index.delete(key);
}

/**
 * Runtime-only account lookup accelerator. The users object remains the
 * authority; every indexed hit is rechecked against it, and a miss performs
 * one cold fallback scan before caching the discovered record. This makes a
 * stale/missed event a latency issue rather than an authentication bug.
 */
export class UserLookupIndex {
  constructor() {
    this.byUsername = new Map();
    this.byEmail = new Map();
    this.keysByUser = new Map();
    this.counters = { rebuilds: 0, upserts: 0, deletes: 0, indexedHits: 0, fallbackScans: 0 };
  }

  clear() {
    this.byUsername.clear();
    this.byEmail.clear();
    this.keysByUser.clear();
  }

  rebuild(users) {
    this.clear();
    for (const user of Object.values(users && typeof users === "object" ? users : {})) this.#indexUser(user);
    this.counters.rebuilds += 1;
    return this.diagnostics();
  }

  upsert(user) {
    if (!user || typeof user !== "object" || typeof user.id !== "string" || user.id.length === 0) return false;
    this.delete(user.id);
    this.#indexUser(user);
    this.counters.upserts += 1;
    return true;
  }

  delete(userId) {
    if (typeof userId !== "string" || userId.length === 0) return false;
    const keys = this.keysByUser.get(userId);
    if (!keys) return false;
    removeIndex(this.byUsername, keys.username, userId);
    removeIndex(this.byEmail, keys.email, userId);
    this.keysByUser.delete(userId);
    const removed = true;
    if (removed) this.counters.deletes += 1;
    return removed;
  }

  findByUsername(username, users) {
    return this.#find(this.byUsername, normalizedUsername(username), users, "username");
  }

  findByEmail(email, users) {
    return this.#find(this.byEmail, normalizedEmail(email), users, "email");
  }

  hasUsername(username, users) {
    return this.findByUsername(username, users) !== null;
  }

  diagnostics() {
    return {
      usernames: this.byUsername.size,
      emails: this.byEmail.size,
      indexedUsers: this.keysByUser.size,
      ...this.counters,
    };
  }

  #indexUser(user) {
    if (!user || typeof user !== "object" || typeof user.id !== "string" || user.id.length === 0) return;
    this.#removeIndexedUser(user.id);
    const keys = {
      username: normalizedUsername(user.username),
      email: normalizedEmail(user.email),
    };
    addIndex(this.byUsername, keys.username, user.id);
    addIndex(this.byEmail, keys.email, user.id);
    this.keysByUser.set(user.id, keys);
  }

  #removeIndexedUser(userId) {
    const keys = this.keysByUser.get(userId);
    if (!keys) return false;
    removeIndex(this.byUsername, keys.username, userId);
    removeIndex(this.byEmail, keys.email, userId);
    this.keysByUser.delete(userId);
    return true;
  }

  #find(index, key, users, field) {
    if (!key) return null;
    const records = users && typeof users === "object" ? users : {};
    const ids = index.get(key);
    if (ids) {
      for (const userId of ids) {
        const user = records[userId];
        if (user && (field === "username" ? normalizedUsername(user.username) : normalizedEmail(user.email)) === key) {
          this.counters.indexedHits += 1;
          return user;
        }
      }
    }
    // The map can be stale after an external import or a failed observer.
    // Preserve the old authoritative semantics with one fallback scan and
    // repair the index for the discovered record.
    this.counters.fallbackScans += 1;
    for (const user of Object.values(records)) {
      if (!user || typeof user !== "object") continue;
      const value = field === "username" ? normalizedUsername(user.username) : normalizedEmail(user.email);
      if (value !== key) continue;
      this.#indexUser(user);
      return user;
    }
    return null;
  }
}
