import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const DEFAULT_STARTING_BALANCE = 1000;
const SCRYPT_KEYLEN = 64;
const VALID_ROLES = new Set(["user", "admin"]);
const VALID_LANGUAGES = new Set(["en", "cs"]);

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
    role: account.role ?? "user",
    language: VALID_LANGUAGES.has(String(account.language ?? "").toLowerCase())
      ? String(account.language).toLowerCase()
      : null,
  };
}

/**
 * File-backed player account store with salted/hashed passwords (Node's built-in scrypt, no
 * external dependency required). Intended for a small self-hosted deployment, not enterprise use.
 */
export class AccountStore {
  constructor({ persistencePath = null, seedPath = null, startingBalance = DEFAULT_STARTING_BALANCE } = {}) {
    this.persistencePath = persistencePath;
    this.seedPath = seedPath;
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
      role: normalized === "dev" ? "admin" : "user",
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

  listAccounts() {
    return [...this.accounts.values()]
      .map((account) => toPublicAccount(account))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  setPassword(username, password) {
    const normalized = normalizeUsername(username);
    const account = this.accounts.get(normalized);
    if (!account) {
      throw new Error("Account not found.");
    }

    if (String(password ?? "").length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    account.passwordHash = hashPassword(String(password));
    this.saveToDisk();
  }

  deleteAccount(username) {
    const normalized = normalizeUsername(username);
    const deleted = this.accounts.delete(normalized);
    if (deleted) {
      this.saveToDisk();
    }

    return deleted;
  }

  setRole(username, role) {
    const normalized = normalizeUsername(username);
    const normalizedRole = String(role ?? "").trim().toLowerCase();
    if (!VALID_ROLES.has(normalizedRole)) {
      throw new Error("Role must be either 'user' or 'admin'.");
    }

    const account = this.accounts.get(normalized);
    if (!account) {
      throw new Error("Account not found.");
    }

    account.role = normalizedRole;
    this.saveToDisk();
    return toPublicAccount(account);
  }

  setLanguage(username, language) {
    const normalized = normalizeUsername(username);
    const normalizedLanguage = String(language ?? "").trim().toLowerCase();
    if (!VALID_LANGUAGES.has(normalizedLanguage)) {
      throw new Error("Language must be either 'en' or 'cs'.");
    }

    const account = this.accounts.get(normalized);
    if (!account) {
      throw new Error("Account not found.");
    }

    account.language = normalizedLanguage;
    this.saveToDisk();
    return toPublicAccount(account);
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

  adjustAllBalances(delta) {
    const numericDelta = Math.round(Number(delta) || 0);
    const updated = [];

    for (const account of this.accounts.values()) {
      account.balance = Math.max(0, Math.round(Number(account.balance) || 0) + numericDelta);
      updated.push({ username: account.username, balance: account.balance });
    }

    this.saveToDisk();
    return updated;
  }

  loadFromDisk() {
    const sourcePath = this.persistencePath && fs.existsSync(this.persistencePath)
      ? this.persistencePath
      : this.seedPath && fs.existsSync(this.seedPath)
        ? this.seedPath
        : null;

    if (!sourcePath) {
      return;
    }

    try {
      const raw = fs.readFileSync(sourcePath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed.accounts) ? parsed.accounts : [];

      for (const entry of entries) {
        if (!entry?.username) {
          continue;
        }

        entry.balance = Math.max(0, Math.round(Number(entry.balance) || 0));
        entry.role = VALID_ROLES.has(String(entry.role ?? "").toLowerCase())
          ? String(entry.role).toLowerCase()
          : entry.username === "dev"
            ? "admin"
            : "user";
        entry.language = VALID_LANGUAGES.has(String(entry.language ?? "").toLowerCase())
          ? String(entry.language).toLowerCase()
          : null;

        this.accounts.set(entry.username, entry);
      }

      const devAccount = this.accounts.get("dev");
      if (devAccount && devAccount.role !== "admin") {
        devAccount.role = "admin";
        this.saveToDisk();
      }

      if (sourcePath === this.seedPath && this.persistencePath && !fs.existsSync(this.persistencePath)) {
        this.saveToDisk();
      }
    } catch (error) {
      console.error(`Failed to load accounts from ${sourcePath}:`, error);
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
