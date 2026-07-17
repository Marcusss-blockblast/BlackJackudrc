import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const DEFAULT_STARTING_BALANCE = 1000;
const SCRYPT_KEYLEN = 64;

function normalizeUsername(username) {
  return String(username ?? "").trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored ?? "").split(":");
  if (!salt || !hash) {
    return false;
  }

  const hashBuffer = Buffer.from(hash, "hex");
  const candidateBuffer = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  if (hashBuffer.length !== candidateBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(hashBuffer, candidateBuffer);
}

function toPublicAccount(account) {
  if (!account) {
    return null;
  }

  return {
    username: account.username,
    displayName: account.displayName,
    balance: account.balance,
    createdAt: account.createdAt,
  };
}

/**
 * File-backed player account store with salted/hashed passwords (Node's built-in scrypt, no
 * external dependency required). Intended for a small self-hosted deployment, not enterprise use.
 */
export class AccountStore {
  constructor({ persistencePath = null, startingBalance = DEFAULT_STARTING_BALANCE } = {}) {
    this.persistencePath = persistencePath;
    this.startingBalance = startingBalance;
    this.accounts = new Map();
    this.loadFromDisk();
  }

  register(username, password) {
    const normalized = normalizeUsername(username);
    if (!USERNAME_PATTERN.test(normalized)) {
      throw new Error("Username must be 3-20 characters: letters, numbers, and underscores only.");
    }

    if (String(password ?? "").length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    if (this.accounts.has(normalized)) {
      throw new Error("That username is already taken.");
    }

    const account = {
      username: normalized,
      displayName: String(username).trim(),
      passwordHash: hashPassword(String(password)),
      balance: this.startingBalance,
      createdAt: new Date().toISOString(),
    };

    this.accounts.set(normalized, account);
    this.saveToDisk();
    return toPublicAccount(account);
  }

  verifyLogin(username, password) {
    const normalized = normalizeUsername(username);
    const account = this.accounts.get(normalized);

    // Use a generic error message for both "unknown user" and "wrong password" to avoid
    // leaking which usernames exist (basic protection against account enumeration).
    if (!account || !verifyPassword(String(password ?? ""), account.passwordHash)) {
      throw new Error("Invalid username or password.");
    }

    return toPublicAccount(account);
  }

  getAccount(username) {
    return toPublicAccount(this.accounts.get(normalizeUsername(username)));
  }

  updateBalance(username, balance) {
    const normalized = normalizeUsername(username);
    const account = this.accounts.get(normalized);
    if (!account) {
      return;
    }

    account.balance = Math.max(0, Math.round(Number(balance) || 0));
    this.saveToDisk();
  }

  loadFromDisk() {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.persistencePath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      let didNormalizeBalances = false;

      for (const entry of entries) {
        if (!entry?.username) {
          continue;
        }

        const normalizedBalance = Math.max(this.startingBalance, Math.round(Number(entry.balance) || 0));
        if (entry.balance !== normalizedBalance) {
          entry.balance = normalizedBalance;
          didNormalizeBalances = true;
        }

        this.accounts.set(entry.username, entry);
      }

      if (didNormalizeBalances) {
        this.saveToDisk();
      }
    } catch (error) {
      console.error(`Failed to load accounts from ${this.persistencePath}:`, error);
    }
  }

  saveToDisk() {
    if (!this.persistencePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      const snapshot = {
        savedAt: new Date().toISOString(),
        accounts: [...this.accounts.values()],
      };
      const tempPath = `${this.persistencePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
      fs.renameSync(tempPath, this.persistencePath);
    } catch (error) {
      console.error(`Failed to save accounts to ${this.persistencePath}:`, error);
    }
  }
}
