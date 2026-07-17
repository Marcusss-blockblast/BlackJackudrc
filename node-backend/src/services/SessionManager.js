import crypto from "node:crypto";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Minimal in-memory session token store. Tokens are opaque random strings mapped to a
 * username, with an expiry. Sessions do not survive a server restart by design (users
 * simply log in again), which keeps this dependency-free and simple to reason about.
 */
export class SessionManager {
  constructor({ sessionTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map();
  }

  createSession(username) {
    const token = crypto.randomBytes(32).toString("hex");
    this.sessions.set(token, { username, expiresAt: Date.now() + this.sessionTtlMs });
    return token;
  }

  getUsername(token) {
    const key = String(token ?? "").trim();
    if (!key) {
      return null;
    }

    const session = this.sessions.get(key);
    if (!session) {
      return null;
    }

    if (session.expiresAt < Date.now()) {
      this.sessions.delete(key);
      return null;
    }

    return session.username;
  }

  destroySession(token) {
    this.sessions.delete(String(token ?? "").trim());
  }
}
