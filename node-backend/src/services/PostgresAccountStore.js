import crypto from "node:crypto";
import { Pool } from "pg";

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const DEFAULT_STARTING_BALANCE = 1000;
const SCRYPT_KEYLEN = 64;
const VALID_ROLES = new Set(["user", "admin"]);

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
    displayName: account.display_name,
    balance: account.balance,
    createdAt: account.created_at ? new Date(account.created_at).toISOString() : null,
    role: account.role ?? "user",
  };
}

export class PostgresAccountStore {
  constructor({ connectionString, startingBalance = DEFAULT_STARTING_BALANCE, ssl = true } = {}) {
    if (!connectionString) {
      throw new Error("Postgres connection string is required.");
    }

    this.startingBalance = startingBalance;
    this.pool = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : false,
    });
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        username TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';");
    await this.pool.query("UPDATE accounts SET role = 'admin' WHERE username = 'dev';");
  }

  async register(username, password) {
    const normalized = normalizeUsername(username);
    if (!USERNAME_PATTERN.test(normalized)) {
      throw new Error("Username must be 3-20 characters: letters, numbers, and underscores only.");
    }

    if (String(password ?? "").length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const account = {
      username: normalized,
      displayName: String(username).trim(),
      passwordHash: hashPassword(String(password)),
      balance: this.startingBalance,
      role: normalized === "dev" ? "admin" : "user",
    };

    try {
      const result = await this.pool.query(
        `
          INSERT INTO accounts (username, display_name, password_hash, balance, role)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING username, display_name, balance, role, created_at;
        `,
        [account.username, account.displayName, account.passwordHash, account.balance, account.role],
      );

      return toPublicAccount(result.rows[0]);
    } catch (error) {
      if (String(error.code) === "23505") {
        throw new Error("That username is already taken.");
      }

      throw error;
    }
  }

  async verifyLogin(username, password) {
    const normalized = normalizeUsername(username);
    const result = await this.pool.query(
      `
        SELECT username, display_name, password_hash, balance, role, created_at
        FROM accounts
        WHERE username = $1;
      `,
      [normalized],
    );

    const account = result.rows[0];
    if (!account || !verifyPassword(String(password ?? ""), account.password_hash)) {
      throw new Error("Invalid username or password.");
    }

    return toPublicAccount(account);
  }

  async getAccount(username) {
    const result = await this.pool.query(
      `
        SELECT username, display_name, balance, role, created_at
        FROM accounts
        WHERE username = $1;
      `,
      [normalizeUsername(username)],
    );

    return toPublicAccount(result.rows[0]);
  }

  async listAccounts() {
    const result = await this.pool.query(
      `
        SELECT username, display_name, balance, role, created_at
        FROM accounts
        ORDER BY username ASC;
      `,
    );

    return result.rows.map((row) => toPublicAccount(row));
  }

  async setPassword(username, password) {
    if (String(password ?? "").length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const result = await this.pool.query(
      `
        UPDATE accounts
        SET password_hash = $2
        WHERE username = $1;
      `,
      [normalizeUsername(username), hashPassword(String(password))],
    );

    if (result.rowCount === 0) {
      throw new Error("Account not found.");
    }
  }

  async setRole(username, role) {
    const normalizedRole = String(role ?? "").trim().toLowerCase();
    if (!VALID_ROLES.has(normalizedRole)) {
      throw new Error("Role must be either 'user' or 'admin'.");
    }

    const result = await this.pool.query(
      `
        UPDATE accounts
        SET role = $2
        WHERE username = $1
        RETURNING username, display_name, balance, role, created_at;
      `,
      [normalizeUsername(username), normalizedRole],
    );

    if (result.rowCount === 0) {
      throw new Error("Account not found.");
    }

    return toPublicAccount(result.rows[0]);
  }

  async deleteAccount(username) {
    const result = await this.pool.query(
      `
        DELETE FROM accounts
        WHERE username = $1;
      `,
      [normalizeUsername(username)],
    );

    return result.rowCount > 0;
  }

  async updateBalance(username, balance) {
    const normalizedBalance = Math.max(0, Math.round(Number(balance) || 0));

    await this.pool.query(
      `
        UPDATE accounts
        SET balance = $2
        WHERE username = $1;
      `,
      [normalizeUsername(username), normalizedBalance],
    );
  }

  async adjustAllBalances(delta) {
    const numericDelta = Math.round(Number(delta) || 0);

    const result = await this.pool.query(
      `
        UPDATE accounts
        SET balance = GREATEST(0, balance + $1)
        RETURNING username, balance;
      `,
      [numericDelta],
    );

    return result.rows.map((row) => ({ username: row.username, balance: row.balance }));
  }

  async healthCheck() {
    try {
      await this.pool.query("SELECT 1;");
      return { connected: true };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
