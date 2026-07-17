import random
import time
import json
import os
import sys
import base64
import hashlib
import secrets
from enum import Enum


_DEBUG = os.environ.get("BLACKJACK_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")


def _debug_log(message, exc=None):
    """Debug logger that is silent by default.

    Enable by setting env var BLACKJACK_DEBUG=1.
    """
    if not _DEBUG:
        return
    try:
        if exc is None:
            sys.stderr.write(f"[DEBUG] {message}\n")
        else:
            sys.stderr.write(f"[DEBUG] {message}: {exc}\n")
        sys.stderr.flush()
    except Exception:
        # Never let debug logging break the game.
        pass

# Make stdout/stderr Unicode-safe on Windows terminals that can't handle suits
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception as e:
    # Older Python or restricted environment may not allow reconfigure; ignore
    _debug_log("stdout/stderr reconfigure failed", e)

# ANSI color codes
class Color:
    RED = '\033[91m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    WHITE = '\033[97m'
    RESET = '\033[0m'

def type_text(text, color=None):
    """Print text with typing effect and optional color"""
    if color:
        text = f"{color}{text}{Color.RESET}"

    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        # Fast-path: emit ANSI escape sequences without delay.
        if ch == "\033" and i + 1 < n and text[i + 1] == "[":
            j = i + 2
            while j < n and text[j] != "m":
                j += 1
            # Include the trailing 'm' if present.
            j = min(j + 1, n)
            print(text[i:j], end='', flush=True)
            i = j
            continue

        print(ch, end='', flush=True)
        time.sleep(0.02)
        i += 1
    print(flush=True)

class PlayerDatabase:
    # Use a canonical players file located next to this script to avoid multiple files
    DB_FILE = os.path.join(os.path.dirname(__file__), "players.json")

    _cache_players = None
    _cache_mtime = None
    _cwd_merge_checked = False

    # Password hashing settings
    PASSWORD_ALGO = "pbkdf2_sha256"
    PASSWORD_ITERS = 200_000
    PASSWORD_SALT_BYTES = 16

    @staticmethod
    def _hash_password(password, *, salt_b64=None, iterations=None):
        """Return (salt_b64, hash_b64, iterations) for the given password."""
        if iterations is None:
            iterations = PlayerDatabase.PASSWORD_ITERS
        if salt_b64 is None:
            salt = secrets.token_bytes(PlayerDatabase.PASSWORD_SALT_BYTES)
            salt_b64 = base64.b64encode(salt).decode("ascii")
        else:
            salt = base64.b64decode(salt_b64.encode("ascii"))

        dk = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            int(iterations),
        )
        hash_b64 = base64.b64encode(dk).decode("ascii")
        return salt_b64, hash_b64, int(iterations)

    @staticmethod
    def _set_password_hash(pdata, password):
        """Set hashed password fields on pdata and clear legacy plaintext."""
        if not isinstance(pdata, dict):
            return False
        if not isinstance(password, str) or password == "":
            return False
        salt_b64, hash_b64, iters = PlayerDatabase._hash_password(password)
        pdata["password_algo"] = PlayerDatabase.PASSWORD_ALGO
        pdata["password_salt"] = salt_b64
        pdata["password_hash"] = hash_b64
        pdata["password_iters"] = iters
        # Remove plaintext password if present.
        if pdata.get("password"):
            pdata["password"] = ""
        return True

    @staticmethod
    def _verify_password_pdata(pdata, password):
        """Verify password against either hashed or legacy plaintext format."""
        if not isinstance(pdata, dict) or not isinstance(password, str):
            return False

        # Prefer hashed passwords when present.
        ph = pdata.get("password_hash")
        ps = pdata.get("password_salt")
        algo = pdata.get("password_algo")
        iters = pdata.get("password_iters", PlayerDatabase.PASSWORD_ITERS)
        if ph and ps and algo == PlayerDatabase.PASSWORD_ALGO:
            try:
                _, computed_b64, _ = PlayerDatabase._hash_password(password, salt_b64=ps, iterations=iters)
                if secrets.compare_digest(str(ph), str(computed_b64)):
                    return True
            except Exception as e:
                _debug_log("Password hash verification failed", e)

        # Legacy plaintext fallback also recovers accounts with stale hashes.
        return pdata.get("password", "") == password

    @staticmethod
    def _migrate_plaintext_password_if_needed(pdata):
        """If pdata stores a legacy plaintext password, hash it in-place."""
        if not isinstance(pdata, dict):
            return False
        if pdata.get("password_hash") and pdata.get("password_salt"):
            return False
        legacy = pdata.get("password")
        if isinstance(legacy, str) and legacy:
            return PlayerDatabase._set_password_hash(pdata, legacy)
        return False
    
    @staticmethod
    def load_players():
        """Load all players from database (UTF-8).

        If the main file is missing/corrupt but a .bak exists, restore from the backup.
        """
        # If a players.json exists in the current working directory (from prior runs),
        # and it's different from the canonical DB_FILE (script folder), merge it to the canonical file.
        # This only needs to happen once per process.
        if not PlayerDatabase._cwd_merge_checked:
            PlayerDatabase._cwd_merge_checked = True
            cwd_file = os.path.join(os.getcwd(), "players.json")
            canonical = PlayerDatabase.DB_FILE
            try:
                if os.path.exists(cwd_file) and os.path.abspath(cwd_file) != os.path.abspath(canonical):
                    # Load cwd players
                    try:
                        with open(cwd_file, 'r', encoding='utf-8') as f:
                            cwd_players = json.load(f)
                    except Exception as e:
                        _debug_log("Failed to load cwd players.json", e)
                        cwd_players = {}
                    # If canonical exists, load and merge; else move cwd to canonical
                    if os.path.exists(canonical):
                        try:
                            with open(canonical, 'r', encoding='utf-8') as f:
                                canon_players = json.load(f)
                        except Exception as e:
                            _debug_log("Failed to load canonical players.json for merge", e)
                            canon_players = {}
                        # Merge: add entries from cwd if missing in canonical
                        changed = False
                        if isinstance(cwd_players, dict) and isinstance(canon_players, dict):
                            for k, v in cwd_players.items():
                                if k not in canon_players:
                                    canon_players[k] = v
                                    changed = True
                        if changed:
                            PlayerDatabase.save_players(canon_players)
                        # Backup the cwd file to .bak to avoid duplicates
                        try:
                            os.replace(cwd_file, cwd_file + '.bak')
                        except Exception as e:
                            _debug_log("Failed to backup cwd players.json", e)
                    else:
                        try:
                            # Move cwd file to canonical location
                            os.replace(cwd_file, canonical)
                        except Exception as e:
                            _debug_log("Failed to move cwd players.json to canonical", e)
                            try:
                                with open(canonical, 'w', encoding='utf-8') as f:
                                    json.dump(cwd_players, f, indent=2, ensure_ascii=False)
                            except Exception as e2:
                                _debug_log("Failed to write canonical players.json during merge", e2)
            except Exception as e:
                # If merge fails, continue and try to load canonical directly
                _debug_log("players.json merge step failed", e)

        # Cache fast-path: if the canonical DB exists and hasn't changed, reuse it.
        # Return the cached object directly to avoid deep-copy overhead.
        try:
            db_file = PlayerDatabase.DB_FILE
            if os.path.exists(db_file):
                mtime = os.path.getmtime(db_file)
                if PlayerDatabase._cache_players is not None and PlayerDatabase._cache_mtime == mtime:
                    return PlayerDatabase._cache_players
        except Exception as e:
            _debug_log("Cache fast-path failed", e)

        db_file = PlayerDatabase.DB_FILE
        backup_file = db_file + '.bak'

        def _try_load(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                _debug_log(f"Failed to load JSON: {path}", e)
                return None

        # If main DB is missing but backup exists, restore it.
        if not os.path.exists(db_file) and os.path.exists(backup_file):
            players = _try_load(backup_file)
            if isinstance(players, dict):
                try:
                    PlayerDatabase.save_players(players)
                except Exception as e:
                    _debug_log("Failed to restore players.json from backup", e)
                # fall through into migration/return
            else:
                return {}

        if os.path.exists(db_file):
            players = _try_load(db_file)
            if players is None:
                # If main file is unreadable, try to recover from backup.
                backup_players = _try_load(backup_file) if os.path.exists(backup_file) else None
                if isinstance(backup_players, dict):
                    try:
                        PlayerDatabase.save_players(backup_players)
                    except Exception as e:
                        _debug_log("Failed to persist recovered backup players", e)
                    players = backup_players
                else:
                    # Preserve the corrupt file without overwriting the existing backup.
                    try:
                        corrupt_name = db_file + f".corrupt.{int(time.time())}"
                        os.replace(db_file, corrupt_name)
                    except Exception as e:
                        _debug_log("Failed to move corrupt players.json aside", e)
                    return {}
            # Sanity check: ensure it's a dict
            if isinstance(players, dict):
                # Migrate any missing fields
                changed = False
                for name, pdata in players.items():
                    if isinstance(pdata, dict):
                        if 'view' not in pdata:
                            pdata['view'] = 'classic'
                            changed = True
                        if 'win_chance' not in pdata:
                            pdata['win_chance'] = 50
                            changed = True
                        if 'beginner_mode' not in pdata:
                            # Existing accounts should not be auto-switched into beginner mode.
                            pdata['beginner_mode'] = False
                            changed = True
                        if 'coach_level' not in pdata:
                            # Tip verbosity: off | subtle | detailed
                            pdata['coach_level'] = 'off'
                            changed = True
                        if 'history' not in pdata or not isinstance(pdata.get('history'), list):
                            pdata['history'] = []
                            changed = True
                        if 'stats' not in pdata or not isinstance(pdata.get('stats'), dict):
                            pdata['stats'] = {}
                            changed = True
                        # Hash legacy plaintext passwords if present.
                        if PlayerDatabase._migrate_plaintext_password_if_needed(pdata):
                            changed = True
                    else:
                        # convert old string format to dict
                        players[name] = {'balance': pdata, 'password': '', 'view': 'classic', 'win_chance': 50, 'beginner_mode': False, 'coach_level': 'off', 'history': [], 'stats': {}}
                        changed = True
                if changed:
                    PlayerDatabase.save_players(players)
                # Populate cache after successful load/migration.
                try:
                    PlayerDatabase._cache_players = players
                    PlayerDatabase._cache_mtime = os.path.getmtime(db_file)
                except Exception as e:
                    _debug_log("Failed to update cache after load", e)
                return players
        return {}
    
    @staticmethod
    def save_players(players):
        """Save all players to database (atomically, UTF-8), and update backup."""
        temp_file = PlayerDatabase.DB_FILE + '.tmp'
        try:
            with open(temp_file, 'w', encoding='utf-8') as f:
                json.dump(players, f, indent=2, ensure_ascii=False)
            os.replace(temp_file, PlayerDatabase.DB_FILE)
        except Exception as e:
            _debug_log("Atomic save failed; falling back to direct write", e)
            # Fallback to direct write
            with open(PlayerDatabase.DB_FILE, 'w', encoding='utf-8') as f:
                json.dump(players, f, indent=2, ensure_ascii=False)
        # Always update backup after saving
        try:
            backup_file = PlayerDatabase.DB_FILE + '.bak'
            with open(backup_file, 'w', encoding='utf-8') as f:
                json.dump(players, f, indent=2, ensure_ascii=False)
        except Exception as e:
            _debug_log("Failed to update players.json.bak", e)

        # Refresh cache to match what we just persisted.
        try:
            PlayerDatabase._cache_players = players
            PlayerDatabase._cache_mtime = os.path.getmtime(PlayerDatabase.DB_FILE)
        except Exception as e:
            _debug_log("Failed to refresh cache after save", e)
            PlayerDatabase._cache_players = None
            PlayerDatabase._cache_mtime = None
    
    @staticmethod
    def get_player_balance(name):
        """Get balance for a player"""
        players = PlayerDatabase.load_players()
        player_data = players.get(name, None)
        if isinstance(player_data, dict):
            return player_data.get("balance", None)
        return player_data  # For backward compatibility
    
    @staticmethod
    def save_player_balance(name, balance):
        """Save player balance"""
        players = PlayerDatabase.load_players()
        if name in players and isinstance(players[name], dict):
            players[name]["balance"] = balance
            # Keep persisted stats in sync whenever we save the account.
            try:
                PlayerDatabase._update_stats_in_pdata(players[name])
            except Exception as e:
                _debug_log("Failed to update stats during save_player_balance", e)
        else:
            # If old format, convert to new format and set default view and win_chance
            password = players.get(name, "") if isinstance(players.get(name), str) else ""
            pdata = {"balance": balance, "password": password, "view": "classic", "win_chance": 50, "beginner_mode": False, "coach_level": "off", "history": [], "stats": {}}
            try:
                PlayerDatabase._update_stats_in_pdata(pdata)
            except Exception as e:
                _debug_log("Failed to update stats for converted player entry", e)
            players[name] = pdata
        PlayerDatabase.save_players(players)
    
    @staticmethod
    def player_exists(name):
        """Check if player exists"""
        players = PlayerDatabase.load_players()
        return name in players
    
    @staticmethod
    def verify_password(name, password):
        """Verify player password"""
        players = PlayerDatabase.load_players()
        player_data = players.get(name)
        if isinstance(player_data, dict):
            ok = PlayerDatabase._verify_password_pdata(player_data, password)
            # If this was a legacy plaintext password, migrate it now.
            if ok and isinstance(player_data.get("password"), str) and player_data.get("password"):
                if PlayerDatabase._set_password_hash(player_data, password):
                    try:
                        PlayerDatabase.save_players(players)
                    except Exception as e:
                        _debug_log("Failed to persist password hash migration", e)
            return ok
        return False
    
    @staticmethod
    def create_player(name, password, initial_balance=100):
        """Create a new player with password"""
        players = PlayerDatabase.load_players()
        # New accounts start in Beginner Mode by default.
        pdata = {"balance": initial_balance, "password": "", "view": "classic", "win_chance": 50, "beginner_mode": True, "coach_level": "subtle", "history": [], "stats": {}}
        PlayerDatabase._set_password_hash(pdata, password)
        try:
            PlayerDatabase._update_stats_in_pdata(pdata)
        except Exception as e:
            _debug_log("Failed to initialize stats for new player", e)
        players[name] = pdata
        try:
            PlayerDatabase.save_players(players)
        except Exception:
            # If save fails, raise to caller
            raise

    @staticmethod
    def compute_stats_from_history(history):
        """Compute summary stats from a history list."""
        if not isinstance(history, list):
            history = []

        wins = sum(1 for h in history if isinstance(h, dict) and h.get("result") in ("win", "blackjack"))
        losses = sum(1 for h in history if isinstance(h, dict) and h.get("result") in ("lose", "bust"))
        pushes = sum(1 for h in history if isinstance(h, dict) and h.get("result") == "push")
        surr = sum(1 for h in history if isinstance(h, dict) and h.get("result") == "surrender")
        total_net = 0
        for h in history:
            if not isinstance(h, dict):
                continue
            try:
                total_net += int(h.get("net", 0))
            except Exception as e:
                _debug_log("Failed to parse net value in history", e)

        played = wins + losses + pushes + surr
        win_rate = (wins / played * 100.0) if played else 0.0
        loss_for_ratio = losses + surr
        wl_ratio = (wins / loss_for_ratio) if loss_for_ratio else (float('inf') if wins else 0.0)

        biggest_win = None
        biggest_loss = None
        for h in history:
            if not isinstance(h, dict):
                continue
            try:
                net = int(h.get("net", 0))
            except Exception:
                continue
            if biggest_win is None or net > int(biggest_win.get("net", 0)):
                biggest_win = h
            if biggest_loss is None or net < int(biggest_loss.get("net", 0)):
                biggest_loss = h

        def _slim(entry):
            if not isinstance(entry, dict):
                return None
            return {
                "ts": entry.get("ts", ""),
                "bet": entry.get("bet", 0),
                "result": entry.get("result", ""),
                "net": int(entry.get("net", 0)) if str(entry.get("net", 0)).lstrip('-').isdigit() else entry.get("net", 0),
            }

        return {
            "wins": wins,
            "losses": losses,
            "pushes": pushes,
            "surr": surr,
            "played": played,
            "win_rate": round(win_rate, 1),
            "wl_ratio": ("inf" if wl_ratio == float('inf') else round(wl_ratio, 3)),
            "net": int(total_net),
            "biggest_win": _slim(biggest_win),
            "biggest_loss": _slim(biggest_loss),
            "updated_ts": time.strftime("%Y-%m-%d %H:%M:%S"),
        }

    @staticmethod
    def _update_stats_in_pdata(pdata):
        """In-place update of pdata['stats'] based on pdata['history']."""
        if not isinstance(pdata, dict):
            return
        history = pdata.get("history", [])
        pdata["stats"] = PlayerDatabase.compute_stats_from_history(history)

    @staticmethod
    def update_player_stats(name):
        """Recompute and persist stats for a single player."""
        players = PlayerDatabase.load_players()
        pdata = players.get(name)
        if not isinstance(pdata, dict):
            return False
        PlayerDatabase._update_stats_in_pdata(pdata)
        PlayerDatabase.save_players(players)
        return True

    @staticmethod
    def get_player_view(name):
        """Get a player's saved view style (classic or alt)"""
        players = PlayerDatabase.load_players()
        player_data = players.get(name, None)
        if isinstance(player_data, dict):
            return player_data.get("view", None)
        return None

    @staticmethod
    def save_player_view(name, view_style):
        """Save a player's view style (validates allowed styles)"""
        valid = ("classic", "nocolor", "alt", "stack")
        if view_style not in valid:
            return
        players = PlayerDatabase.load_players()
        if name in players and isinstance(players[name], dict):
            players[name]["view"] = view_style
        else:
            # Create or convert entry
            password = players.get(name, "") if isinstance(players.get(name), str) else ""
            players[name] = {"balance": 100, "password": password, "view": view_style, "win_chance": 50, "beginner_mode": False, "coach_level": "off", "history": [], "stats": {}}
        PlayerDatabase.save_players(players)

    @staticmethod
    def get_player_win_chance(name):
        """Get a player's saved win chance (0-100). Returns 50 if not set."""
        players = PlayerDatabase.load_players()
        player_data = players.get(name, None)
        if isinstance(player_data, dict):
            return player_data.get("win_chance", 50)
        return 50

    @staticmethod
    def save_player_win_chance(name, chance):
        """Save a player's win chance (clamped to 0-100)"""
        try:
            val = int(chance)
        except Exception:
            return
        val = max(0, min(100, val))
        players = PlayerDatabase.load_players()
        if name in players and isinstance(players[name], dict):
            players[name]["win_chance"] = val
        else:
            password = players.get(name, "") if isinstance(players.get(name), str) else ""
            players[name] = {"balance": 100, "password": password, "view": "classic", "win_chance": val, "beginner_mode": False, "coach_level": "off", "history": [], "stats": {}}
        PlayerDatabase.save_players(players)

    @staticmethod
    def get_player_beginner_mode(name):
        """Get a player's beginner mode flag (bool). Defaults to False for existing accounts."""
        players = PlayerDatabase.load_players()
        pdata = players.get(name)
        if isinstance(pdata, dict):
            return bool(pdata.get("beginner_mode", False))
        return False

    @staticmethod
    def save_player_beginner_mode(name, enabled):
        """Persist a player's beginner mode flag."""
        players = PlayerDatabase.load_players()
        if name in players and isinstance(players[name], dict):
            players[name]["beginner_mode"] = bool(enabled)
        else:
            password = players.get(name, "") if isinstance(players.get(name), str) else ""
            players[name] = {"balance": 100, "password": password, "view": "classic", "win_chance": 50, "beginner_mode": bool(enabled), "coach_level": "off", "history": [], "stats": {}}
        PlayerDatabase.save_players(players)

    @staticmethod
    def get_player_coach_level(name):
        """Get a player's coach tip verbosity: off | subtle | detailed."""
        players = PlayerDatabase.load_players()
        pdata = players.get(name)
        if isinstance(pdata, dict):
            level = pdata.get("coach_level", "off")
            if level in ("off", "subtle", "detailed"):
                return level
        return "off"

    @staticmethod
    def save_player_coach_level(name, level):
        """Persist a player's coach tip verbosity."""
        if level not in ("off", "subtle", "detailed"):
            return
        players = PlayerDatabase.load_players()
        if name in players and isinstance(players[name], dict):
            players[name]["coach_level"] = level
        else:
            password = players.get(name, "") if isinstance(players.get(name), str) else ""
            players[name] = {"balance": 100, "password": password, "view": "classic", "win_chance": 50, "beginner_mode": False, "coach_level": level, "history": [], "stats": {}}
        PlayerDatabase.save_players(players)

    @staticmethod
    def get_player_history(name):
        """Return the player's round history (list)."""
        players = PlayerDatabase.load_players()
        pdata = players.get(name, {})
        if isinstance(pdata, dict):
            hist = pdata.get("history", [])
            return hist if isinstance(hist, list) else []
        return []

    @staticmethod
    def append_player_history(name, entry, limit=25):
        """Append a history entry for a player and persist to players.json and players.json.bak."""
        players = PlayerDatabase.load_players()
        pdata = players.get(name)
        if not isinstance(pdata, dict):
            # Create/convert minimal entry
            password = players.get(name, "") if isinstance(players.get(name), str) else ""
            pdata = {"balance": 100, "password": password, "view": "classic", "win_chance": 50, "beginner_mode": False, "coach_level": "off", "history": [], "stats": {}}
            players[name] = pdata
        hist = pdata.get("history")
        if not isinstance(hist, list):
            hist = []
            pdata["history"] = hist
        hist.append(entry)
        if limit and len(hist) > limit:
            pdata["history"] = hist[-limit:]
        try:
            PlayerDatabase._update_stats_in_pdata(pdata)
        except Exception as e:
            _debug_log("Failed to update stats after appending history", e)
        PlayerDatabase.save_players(players)
    
    @staticmethod
    def delete_player(name):
        """Delete a player from the database"""
        players = PlayerDatabase.load_players()
        if name in players:
            del players[name]
            PlayerDatabase.save_players(players)
            return True
        return False

class Suit(Enum):
    HEARTS = "♥"
    DIAMONDS = "♦"
    CLUBS = "♣"
    SPADES = "♠"

class Rank(Enum):
    ACE = "A"
    TWO = "2"
    THREE = "3"
    FOUR = "4"
    FIVE = "5"
    SIX = "6"
    SEVEN = "7"
    EIGHT = "8"
    NINE = "9"
    TEN = "10"
    JACK = "J"
    QUEEN = "Q"
    KING = "K"

class Card:
    def __init__(self, rank, suit):
        self.rank = rank
        self.suit = suit
    
    def __str__(self):
        s = f"{self.rank.value}{self.suit.value}"
        try:
            enc = getattr(sys.stdout, "encoding", None) or "utf-8"
            s.encode(enc)
            return s
        except Exception:
            # Fallback to ASCII suit letters if terminal can't encode the suit
            suit_map = {
                Suit.HEARTS: 'H',
                Suit.DIAMONDS: 'D',
                Suit.CLUBS: 'C',
                Suit.SPADES: 'S'
            }
            return f"{self.rank.value}{suit_map.get(self.suit, '?')}"
    
    def get_value(self):
        if self.rank.value in ['J', 'Q', 'K']:
            return 10
        elif self.rank.value == 'A':
            return 11
        else:
            return int(self.rank.value)

class Hand:
    def __init__(self):
        self.cards = []
    
    def add_card(self, card):
        self.cards.append(card)
    
    def get_value(self):
        """Calculate hand value, automatically adjusting aces from 11 to 1 as needed"""
        total = 0
        aces = 0
        
        for card in self.cards:
            if card.rank == Rank.ACE:
                aces += 1
            total += card.get_value()
        
        # Automatically adjust for aces if hand is over 21
        while total > 21 and aces > 0:
            total -= 10
            aces -= 1
        
        return total
    
    def has_ace(self):
        return any(card.rank == Rank.ACE for card in self.cards)
    
    def get_soft_value(self):
        """Return the 'soft' total (counting one Ace as 11) if it is <= 21, else None."""
        if not self.has_ace():
            return None
        hard = self.get_hard_value()
        soft = hard + 10
        return soft if soft <= 21 else None

    def get_hard_value(self):
        """Return the 'hard' total (all Aces counted as 1)."""
        total = 0
        for card in self.cards:
            if card.rank == Rank.ACE:
                total += 1
            else:
                total += card.get_value()
        return total

    def get_alternate_value(self):
        """Return the alternate non-busting total for display (if applicable)."""
        soft = self.get_soft_value()
        if soft is None:
            return None
        hard = self.get_hard_value()
        best = self.get_value()
        if best == soft:
            return hard
        if best == hard:
            return soft
        return None
    
    def is_blackjack(self):
        """Check if hand is a natural blackjack (Ace + any 10-value card)."""
        if len(self.cards) != 2:
            return False
        has_ace = any(card.rank == Rank.ACE for card in self.cards)
        has_ten_value = any((card.rank != Rank.ACE and card.get_value() == 10) for card in self.cards)
        return has_ace and has_ten_value
    
    def __str__(self):
        return ", ".join(str(card) for card in self.cards)

class Deck:
    def __init__(self, num_decks=1):
        self.cards = []
        for _ in range(num_decks):
            for suit in Suit:
                for rank in Rank:
                    self.cards.append(Card(rank, suit))
        random.shuffle(self.cards)
    
    def deal_card(self):
        if len(self.cards) < 10:
            # Reshuffle if deck is running low
            self.__init__()
        return self.cards.pop()

class BlackjackGame:
    def __init__(self, player_name):
        self.deck = Deck(num_decks=1)
        self.player_hand = Hand()
        self.dealer_hand = Hand()
        self.player_name = player_name
        self.quick_play = False  # Quick play mode state
        self._quick_play_banner_shown = False
        self.last_bet = None
        # Load player balance from database or start with $100
        saved_balance = PlayerDatabase.get_player_balance(player_name)
        if saved_balance is not None:
            self.player_balance = saved_balance
        else:
            self.player_balance = 100
        self.current_bet = 0
        # Load view preference (persisted per-player) or default to 'classic'
        saved_view = PlayerDatabase.get_player_view(player_name)
        self.view_style = saved_view if saved_view in ("classic", "nocolor", "alt", "stack") else 'classic'
        # Load persistent win chance (0-100), default 50
        saved_win = PlayerDatabase.get_player_win_chance(player_name)
        try:
            self.base_win_chance = int(saved_win)
        except Exception:
            self.base_win_chance = 50
        # Clamp
        self.base_win_chance = max(0, min(100, self.base_win_chance))

        # Beginner mode: enabled by default for new accounts, but OFF for existing ones.
        self.beginner_mode = bool(PlayerDatabase.get_player_beginner_mode(player_name))
        self.coach_level = PlayerDatabase.get_player_coach_level(player_name)
        self._last_tip_line = None

    def get_effective_win_chance(self):
        """Return the win chance actually used for biasing results."""
        if getattr(self, "beginner_mode", False):
            return 70
        return getattr(self, "base_win_chance", 50)

    def show_hands(self, show_dealer_hole=False):
        """Dispatch to the selected hand view style."""
        style = getattr(self, "view_style", "classic")
        if style == "alt":
            self.show_hands_alt(show_dealer_hole)
        elif style == "nocolor":
            self.show_hands_nocolor(show_dealer_hole)
        elif style == "stack":
            self.show_hands_stack(show_dealer_hole)
        else:
            self.show_hands_classic(show_dealer_hole)

    def _value_color(self, value):
        """Return a color for a blackjack hand total."""
        try:
            v = int(value)
        except Exception:
            return Color.WHITE
        if v > 21:
            return Color.RED
        if v == 21:
            return Color.GREEN
        if v >= 17:
            return Color.CYAN
        if v >= 12:
            return Color.YELLOW
        return Color.WHITE

    def _format_hand_value(self, value, soft_value=None):
        """Format a value string with colors; optional soft alternative."""
        col = self._value_color(value)
        base = f"{col}{value}{Color.RESET}"
        if soft_value is None:
            return base
        try:
            sv = int(soft_value)
        except Exception:
            return base
        if sv == int(value) or sv > 21:
            return base
        scol = self._value_color(sv)
        return base + f" or {scol}{sv}{Color.RESET}"

    def show_hands_nocolor(self, show_dealer_hole=False):
        # Classic view but without any ANSI color codes
        print("\n" + "-" * 100)
        dealer_cards = " ".join(str(card) for card in self.dealer_hand.cards)
        if show_dealer_hole:
            dealer_value = self.dealer_hand.get_value()
            print("┌─ DEALER'S HAND")
            print(f"│  Cards: {dealer_cards}")
            print(f"│  Value: {dealer_value}")
        else:
            print("┌─ DEALER'S HAND")
            print(f"│  Cards: {str(self.dealer_hand.cards[0])} [hidden]")
            print("│  Value: ?")

        player_value = self.player_hand.get_value()
        player_cards = " ".join(str(card) for card in self.player_hand.cards)
        value_str = f"{player_value}"

        alt_value = self.player_hand.get_alternate_value()
        if alt_value is not None:
            value_str += f" or {alt_value}"

        print("└─ YOUR HAND")
        print(f"   Cards: {player_cards}")
        print(f"   Value: {value_str}")
        print("-" * 100)

    def show_hands_stack(self, show_dealer_hole=False):
        # Vertical stacked view
        print("\n" + "=" * 40)
        print("DEALER:")
        if show_dealer_hole:
            for card in self.dealer_hand.cards:
                print(f"  [{card}]")
            dval = self.dealer_hand.get_value()
            print(f"  Value: {self._format_hand_value(dval)}")
        else:
            if len(self.dealer_hand.cards) > 0:
                print(f"  [{self.dealer_hand.cards[0]}]")
                print("  [??]")
            else:
                print("  (no cards)")
            print("  Value: ?")

        print("\nPLAYER:")
        for card in self.player_hand.cards:
            print(f"  ({card})")
        player_value = self.player_hand.get_value()
        alt_value = self.player_hand.get_alternate_value()
        print(f"  Value: {self._format_hand_value(player_value, alt_value)}")
        print("=" * 40)

    def show_hands_classic(self, show_dealer_hole=False):
        print("\n" + "-" * 100)
        dealer_cards = " ".join(f"{Color.YELLOW}{str(card)}{Color.RESET}" for card in self.dealer_hand.cards)
        if show_dealer_hole:
            dealer_value = self.dealer_hand.get_value()
            print(f"┌─ DEALER'S HAND")
            print(f"│  Cards: {dealer_cards}")
            print(f"│  Value: {self._format_hand_value(dealer_value)}")
        else:
            print(f"┌─ DEALER'S HAND")
            print(f"│  Cards: {Color.YELLOW}{self.dealer_hand.cards[0]}{Color.RESET} [hidden]")
            print(f"│  Value: ?")
        
        player_value = self.player_hand.get_value()
        player_cards = " ".join(f"{Color.YELLOW}{str(card)}{Color.RESET}" for card in self.player_hand.cards)
        value_str = self._format_hand_value(player_value)
        
        alt_value = self.player_hand.get_alternate_value()
        if alt_value is not None:
            value_str = self._format_hand_value(player_value, alt_value)
        
        print(f"└─ YOUR HAND")
        print(f"   Cards: {player_cards}")
        print(f"   Value: {value_str}")
        print("-" * 100)

    def show_hands_alt(self, show_dealer_hole=False):
        # A compact alternative view with horizontal layout
        print("\n" + "=" * 60)
        # Dealer
        if show_dealer_hole:
            dealer_display = " | ".join(f"[{str(card)}]" for card in self.dealer_hand.cards)
            dealer_value = self.dealer_hand.get_value()
            print(f"DEALER => {dealer_display}   (Value: {self._format_hand_value(dealer_value)})")
        else:
            if len(self.dealer_hand.cards) > 0:
                first = f"[{str(self.dealer_hand.cards[0])}]"
                hidden = "[??]"
                print(f"DEALER => {first} {hidden}   (Value: ?)")
            else:
                print("DEALER => (no cards)")
        # Player
        player_display = " ".join(f"({str(card)})" for card in self.player_hand.cards)
        player_value = self.player_hand.get_value()
        alt_value = self.player_hand.get_alternate_value()
        print(f"PLAYER => {player_display}   (Value: {self._format_hand_value(player_value, alt_value)})")
        print("=" * 60)

    def toggle_view(self):
        self.view_style = "alt" if getattr(self, "view_style", "classic") == "classic" else "classic"
        type_text(f"[VIEW] Switched hand display to '{self.view_style.upper()}' mode.", Color.CYAN)
        # Persist the player's choice
        try:
            PlayerDatabase.save_player_view(self.player_name, self.view_style)
        except Exception as e:
            # Non-fatal - if saving fails, just keep the in-memory value
            _debug_log("Failed to persist view setting", e)

    def view_menu(self):
        options = [
            ("classic", "Classic — Colored box-style view (default)."),
            ("nocolor", "No Color — Same as classic but without ANSI colors."),
            ("alt", "Alt — Compact horizontal layout."),
            ("stack", "Stack — Vertical stacked layout, one card per line."),
        ] 
        current = getattr(self, "view_style", "classic")
        print("\n" + "-" * 60)
        print("VIEW & GAME SETTINGS")
        print("-" * 60)
        for i, (key, desc) in enumerate(options, start=1):
            marker = "  <-- current" if key == current else ""
            print(f"{i}. {key} - {desc}{marker}")
        print(f"Q. Quick Play Mode - {'ON' if self.quick_play else 'OFF'} (arrow keys for fast play)")
        print(f"B. Beginner Mode  - {'ON' if self.beginner_mode else 'OFF'} (tips + 70% bias while ON)")
        print(f"T. Coach Tips     - {self.coach_level.upper()} (cycle: OFF → SUBTLE → DETAILED)")
        print("\nPress a number to select a view, Q Quick Play, B Beginner, T Tips, or ENTER to cancel.")
        choice = input(">>> ").strip().upper()
        if choice == "":
            print(f"{Color.YELLOW}[CANCELLED] Settings unchanged.{Color.RESET}")
            return
        if choice == "Q":
            self.quick_play = not self.quick_play
            print(f"{Color.CYAN}[QUICK PLAY] Quick Play mode is now {'ON' if self.quick_play else 'OFF'}.{Color.RESET}")
            return
        if choice == "B":
            self.beginner_mode = not bool(self.beginner_mode)
            try:
                PlayerDatabase.save_player_beginner_mode(self.player_name, self.beginner_mode)
            except Exception as e:
                _debug_log("Failed to persist beginner_mode", e)
            # If beginner mode is enabled and tips were never configured, default to subtle.
            if self.beginner_mode and getattr(self, "coach_level", "off") not in ("subtle", "detailed"):
                self.coach_level = "subtle"
                try:
                    PlayerDatabase.save_player_coach_level(self.player_name, self.coach_level)
                except Exception as e:
                    _debug_log("Failed to persist coach_level default", e)
            state = 'ON' if self.beginner_mode else 'OFF'
            if self.beginner_mode:
                print(f"{Color.CYAN}[BEGINNER]{Color.RESET} Beginner Mode is now {Color.GREEN}{state}{Color.RESET} (tips enabled, bias set to 70%).")
            else:
                print(f"{Color.CYAN}[BEGINNER]{Color.RESET} Beginner Mode is now {Color.YELLOW}{state}{Color.RESET} (tips disabled, bias restored).")
            return
        if choice == "T":
            order = ("off", "subtle", "detailed")
            cur = getattr(self, "coach_level", "off")
            try:
                idx = order.index(cur)
            except ValueError:
                idx = 0
            self.coach_level = order[(idx + 1) % len(order)]
            try:
                PlayerDatabase.save_player_coach_level(self.player_name, self.coach_level)
            except Exception as e:
                _debug_log("Failed to persist coach_level", e)
            print(f"{Color.CYAN}[TIPS]{Color.RESET} Coach Tips set to {Color.WHITE}{self.coach_level.upper()}{Color.RESET}.")
            return
        try:
            idx = int(choice)
        except ValueError:
            print(f"{Color.RED}[!] Invalid input. Enter a number, Q, or ENTER.{Color.RESET}")
            return
        if 1 <= idx <= len(options):
            selected = options[idx - 1][0]
            self.view_style = selected
            PlayerDatabase.save_player_view(self.player_name, selected)
            type_text(f"[VIEW] Switched hand display to '{selected.upper()}' mode.", Color.CYAN)
        else:
            print(f"{Color.RED}[!] Invalid selection.{Color.RESET}")

    def _read_quick_action(self):
        """Read a single quick-play action key without requiring ENTER."""
        import msvcrt
        key = msvcrt.getch()
        if key in (b'\xe0', b'\x00'):
            arrow = msvcrt.getch()
            if arrow == b'M':
                return 'H'  # Right
            if arrow == b'K':
                return 'S'  # Left
            if arrow == b'P':
                return 'R'  # Down (Surrender)
            if arrow == b'H':
                return 'U'  # Up
            return None
        if key in (b'h', b'H'):
            return 'H'
        if key in (b's', b'S'):
            return 'S'
        if key in (b'r', b'R'):
            return 'R'
        return None

    def _read_quick_line(self, prompt):
        """Read a line of input using msvcrt so arrow keys can be captured.

        Returns:
        - a normal string when the user presses ENTER
        - the sentinel "__UP__" when the user presses Up Arrow
        - the sentinel "__DOWN__" when the user presses Down Arrow
        """
        import msvcrt
        import sys

        sys.stdout.write(prompt)
        sys.stdout.flush()

        buf = []
        while True:
            ch = msvcrt.getwch()
            if ch in ('\r', '\n'):
                sys.stdout.write('\n')
                sys.stdout.flush()
                return ''.join(buf)

            # Backspace
            if ch == '\x08':
                if buf:
                    buf.pop()
                    sys.stdout.write('\b \b')
                    sys.stdout.flush()
                continue

            # Special keys (arrows, etc.)
            if ch in ('\x00', '\xe0'):
                key = msvcrt.getwch()
                if key == 'H':
                    sys.stdout.write('\n')
                    sys.stdout.flush()
                    return "__UP__"
                if key == 'P':
                    sys.stdout.write('\n')
                    sys.stdout.flush()
                    return "__DOWN__"
                continue

            # Normal character
            buf.append(ch)
            sys.stdout.write(ch)
            sys.stdout.flush()


    
    def place_bet(self, amount):
        if amount > self.player_balance:
            print(f"Insufficient balance! You have ${self.player_balance}")
            return False
        if amount <= 0:
            print("Bet must be greater than 0!")
            return False
        self.current_bet = amount
        self.last_bet = amount
        self.player_balance -= amount
        return True

    def _clear_screen(self):
        try:
            os.system('cls' if os.name == 'nt' else 'clear')
        except Exception as e:
            _debug_log("Failed to clear screen", e)

    def _get_quick_stats(self):
        history = PlayerDatabase.get_player_history(self.player_name)
        wins = sum(1 for h in history if h.get("result") in ("win", "blackjack"))
        losses = sum(1 for h in history if h.get("result") in ("lose", "bust"))
        pushes = sum(1 for h in history if h.get("result") == "push")
        surr = sum(1 for h in history if h.get("result") == "surrender")
        total_net = 0
        for h in history:
            try:
                total_net += int(h.get("net", 0))
            except Exception as e:
                _debug_log("Failed to parse net value in quick stats", e)

        played = wins + losses + pushes + surr
        win_rate = (wins / played * 100.0) if played else 0.0
        loss_for_ratio = losses + surr
        wl_ratio = (wins / loss_for_ratio) if loss_for_ratio else (float('inf') if wins else 0.0)

        # Streak: consecutive wins or losses (surrender counts as loss; push breaks)
        streak = 0
        streak_kind = None
        for h in reversed(history):
            res = h.get("result")
            if res in ("push", None):
                break
            kind = "W" if res in ("win", "blackjack") else "L" if res in ("lose", "bust", "surrender") else None
            if kind is None:
                break
            if streak_kind is None:
                streak_kind = kind
            if kind != streak_kind:
                break
            streak += 1

        return {
            "wins": wins,
            "losses": losses,
            "pushes": pushes,
            "surr": surr,
            "net": total_net,
            "played": played,
            "win_rate": win_rate,
            "wl_ratio": wl_ratio,
            "streak": streak,
            "streak_kind": streak_kind,
        }

    def _print_quick_hud(self):
        stats = self._get_quick_stats()

        balance_color = Color.GREEN if self.player_balance > 0 else Color.RED
        net = stats["net"]
        net_color = Color.GREEN if net > 0 else Color.RED if net < 0 else Color.BLUE

        wl_ratio = stats["wl_ratio"]
        if wl_ratio == float('inf'):
            ratio_str = f"{Color.GREEN}W/L: ∞{Color.RESET}"
        else:
            ratio_color = Color.GREEN if wl_ratio >= 1.0 else Color.RED if wl_ratio > 0 else Color.BLUE
            ratio_str = f"{ratio_color}W/L: {wl_ratio:.2f}{Color.RESET}"

        win_rate = stats["win_rate"]
        wr_color = Color.GREEN if win_rate >= 50.0 else Color.RED if win_rate > 0 else Color.BLUE

        streak_kind = stats["streak_kind"]
        if stats["streak"] <= 0 or streak_kind is None:
            streak_str = f"{Color.BLUE}Streak: -{Color.RESET}"
        else:
            scol = Color.GREEN if streak_kind == "W" else Color.RED
            streak_str = f"{scol}Streak: {streak_kind}{stats['streak']}{Color.RESET}"

        print("=" * 70)
        print(
            f"{Color.CYAN}QUICK HUD{Color.RESET} | "
            f"User: {Color.CYAN}{self.player_name}{Color.RESET} | "
            f"Bal: {balance_color}${self.player_balance}{Color.RESET} | "
            f"Last bet: {Color.YELLOW}${self.last_bet}{Color.RESET} | "
            f"View: {Color.WHITE}{self.view_style}{Color.RESET} | "
            f"Beginner: {Color.WHITE}{'ON' if self.beginner_mode else 'OFF'}{Color.RESET} | "
            f"Tips: {Color.WHITE}{getattr(self, 'coach_level', 'off')}{Color.RESET} | "
            f"Bias: {Color.WHITE}{self.get_effective_win_chance()}%{Color.RESET}"
        )
        print(
            f"{Color.GREEN}W:{stats['wins']}{Color.RESET} "
            f"{Color.RED}L:{stats['losses']}{Color.RESET} "
            f"{Color.BLUE}P:{stats['pushes']}{Color.RESET} "
            f"{Color.CYAN}R:{stats['surr']}{Color.RESET}"
            f" | {ratio_str}"
            f" | {wr_color}Win%: {win_rate:.1f}%{Color.RESET}"
            f" | {net_color}Net: {net:+}{Color.RESET}"
            f" | {streak_str}"
        )
        print("=" * 70)

    def _print_quick_hud_bottom(self):
        """Small HUD meant to sit below the round output (2 lines)."""
        stats = self._get_quick_stats()
        net = stats["net"]
        net_color = Color.GREEN if net > 0 else Color.RED if net < 0 else Color.BLUE
        bal_color = Color.GREEN if self.player_balance > 0 else Color.RED

        wl_ratio = stats["wl_ratio"]
        if wl_ratio == float('inf'):
            ratio_str = f"{Color.GREEN}∞{Color.RESET}"
        else:
            ratio_color = Color.GREEN if wl_ratio >= 1.0 else Color.RED if wl_ratio > 0 else Color.BLUE
            ratio_str = f"{ratio_color}{wl_ratio:.2f}{Color.RESET}"

        win_rate = stats["win_rate"]
        wr_color = Color.GREEN if win_rate >= 50.0 else Color.RED if win_rate > 0 else Color.BLUE

        streak_kind = stats["streak_kind"]
        if stats["streak"] <= 0 or streak_kind is None:
            streak_str = f"{Color.BLUE}-{Color.RESET}"
        else:
            scol = Color.GREEN if streak_kind == "W" else Color.RED
            streak_str = f"{scol}{streak_kind}{stats['streak']}{Color.RESET}"

        # Line 1
        print(
            f"{Color.CYAN}[HUD]{Color.RESET} "
            f"Bal {bal_color}${self.player_balance}{Color.RESET} | "
            f"Bet {Color.YELLOW}${self.current_bet}{Color.RESET} | "
            f"Last {Color.YELLOW}${self.last_bet}{Color.RESET} | "
            f"Net {net_color}{net:+}{Color.RESET} | "
            f"Beg {Color.WHITE}{'ON' if self.beginner_mode else 'OFF'}{Color.RESET} | "
            f"Bias {Color.WHITE}{self.get_effective_win_chance()}%{Color.RESET}"
        )
        # Line 2
        print(
            f"      "
            f"{Color.GREEN}W{stats['wins']}{Color.RESET} "
            f"{Color.RED}L{stats['losses']}{Color.RESET} "
            f"{Color.BLUE}P{stats['pushes']}{Color.RESET} "
            f"{Color.CYAN}R{stats['surr']}{Color.RESET}"
            f" | W/L {ratio_str}"
            f" | {wr_color}Win% {win_rate:.1f}%{Color.RESET}"
            f" | Streak {streak_str}"
        )

    def show_round_history(self, limit=10):
        """Show recent round history + summary stats for the logged-in player."""
        history = PlayerDatabase.get_player_history(self.player_name)
        print("\n" + "-" * 70)
        print(f"STATS for {Color.CYAN}{self.player_name}{Color.RESET}")
        print("-" * 70)

        if not history:
            print(f"{Color.YELLOW}No rounds played yet.{Color.RESET}")
            print("-" * 70)
            return

        wins = sum(1 for h in history if h.get("result") in ("win", "blackjack"))
        losses = sum(1 for h in history if h.get("result") in ("lose", "bust"))
        pushes = sum(1 for h in history if h.get("result") == "push")
        surr = sum(1 for h in history if h.get("result") == "surrender")
        total_net = sum(int(h.get("net", 0)) for h in history)

        played = wins + losses + pushes + surr
        win_rate = (wins / played * 100.0) if played else 0.0
        loss_for_ratio = losses + surr
        wl_ratio = (wins / loss_for_ratio) if loss_for_ratio else (float('inf') if wins else 0.0)

        biggest_win = None
        biggest_loss = None
        for h in history:
            try:
                net = int(h.get("net", 0))
            except Exception:
                continue
            if biggest_win is None or net > int(biggest_win.get("net", 0)):
                biggest_win = h
            if biggest_loss is None or net < int(biggest_loss.get("net", 0)):
                biggest_loss = h

        def colorize(label, value, color):
            return f"{color}{label}: {value}{Color.RESET}"

        print(
            "  "
            + colorize("Wins", wins, Color.GREEN)
            + " | "
            + colorize("Losses", losses, Color.RED)
            + " | "
            + colorize("Pushes", pushes, Color.BLUE)
            + " | "
            + colorize("Surr", surr, Color.CYAN)
        )
        if wl_ratio == float('inf'):
            ratio_str = f"{Color.GREEN}W/L: ∞{Color.RESET}"
        else:
            ratio_color = Color.GREEN if wl_ratio >= 1.0 else Color.RED if wl_ratio > 0 else Color.BLUE
            ratio_str = f"{ratio_color}W/L: {wl_ratio:.2f}{Color.RESET}"
        wr_color = Color.GREEN if win_rate >= 50.0 else Color.RED if win_rate > 0 else Color.BLUE
        print(f"  {ratio_str} | {wr_color}Win%: {win_rate:.1f}%{Color.RESET}")

        net_color = Color.GREEN if total_net > 0 else Color.RED if total_net < 0 else Color.BLUE
        print(f"  {net_color}Net: {total_net:+}{Color.RESET}")

        if biggest_win is not None:
            ts = biggest_win.get("ts", "")
            bet = biggest_win.get("bet", "?")
            net = int(biggest_win.get("net", 0))
            print(f"  {Color.GREEN}Best:  {net:+}{Color.RESET} (bet ${bet}) {ts}")
        if biggest_loss is not None:
            ts = biggest_loss.get("ts", "")
            bet = biggest_loss.get("bet", "?")
            net = int(biggest_loss.get("net", 0))
            print(f"  {Color.RED}Worst: {net:+}{Color.RESET} (bet ${bet}) {ts}")

        print("\nRecent rounds:")
        for h in history[-limit:][::-1]:
            ts = h.get("ts", "")
            bet = h.get("bet", "?")
            res = h.get("result", "?")
            net = int(h.get("net", 0))
            if res in ("win", "blackjack"):
                rcol = Color.GREEN
            elif res in ("lose", "bust"):
                rcol = Color.RED
            elif res == "push":
                rcol = Color.BLUE
            else:
                rcol = Color.CYAN
            ncol = Color.GREEN if net > 0 else Color.RED if net < 0 else Color.BLUE
            print(f"  {ts} | bet ${bet} | {rcol}{res.upper()}{Color.RESET} | {ncol}{net:+}{Color.RESET}")
        print("-" * 70)
    
    def start_round(self):
        self.player_hand = Hand()
        self.dealer_hand = Hand()
        
        # Deal initial cards
        self.player_hand.add_card(self.deck.deal_card())
        self.dealer_hand.add_card(self.deck.deal_card())
        self.player_hand.add_card(self.deck.deal_card())
        self.dealer_hand.add_card(self.deck.deal_card())
    
    def player_hit(self):
        self.player_hand.add_card(self.deck.deal_card())
        return self.player_hand.get_value() <= 21
    
    def dealer_play(self):
        while self.dealer_hand.get_value() < 17:
            self.dealer_hand.add_card(self.deck.deal_card())
    
    def determine_winner(self):
        player_value = self.player_hand.get_value()
        dealer_value = self.dealer_hand.get_value()
        
        # Player busts
        if player_value > 21:
            return "bust"
        
        # Dealer busts
        if dealer_value > 21:
            return "win"
        
        # Compare values
        if player_value > dealer_value:
            return "win"
        elif player_value < dealer_value:
            return "lose"
        else:
            return "push"

    def apply_win_chance(self, result):
        """Apply player win chance bias silently.
        - If the player has busted, keep 'bust'.
        - Otherwise, with probability `effective win chance` (0-100) force a 'win'.
        """
        if result == "bust":
            return result
        try:
            p = int(self.get_effective_win_chance())
        except Exception:
            p = 50
        p = max(0, min(100, p))
        r = random.uniform(0, 100)
        if r < p:
            return "win"
        return result

    def _coach_tip_line(self):
        """Return a subtle beginner tip line, or None if tips are disabled."""
        if not getattr(self, "beginner_mode", False):
            return None
        level = getattr(self, "coach_level", "off")
        if level == "off":
            return None
        if not getattr(self, "dealer_hand", None) or not getattr(self, "player_hand", None):
            return None
        if not self.dealer_hand.cards or not self.player_hand.cards:
            return None

        upcard = self.dealer_hand.cards[0]
        dealer_val = 11 if upcard.rank == Rank.ACE else (10 if upcard.get_value() == 10 else upcard.get_value())

        total = self.player_hand.get_value()
        soft_total = self.player_hand.get_soft_value()
        is_soft = soft_total is not None and soft_total == total

        # Basic, beginner-friendly strategy heuristics (not exhaustive).
        rec = "H"  # default hit
        why = ""

        if is_soft:
            if total <= 17:
                rec = "H"
                why = "soft <=17"
            elif total == 18:
                if dealer_val in (9, 10, 11):
                    rec = "H"
                    why = "soft 18 vs 9/A/10"
                else:
                    rec = "S"
                    why = "soft 18 vs 2-8"
            else:
                rec = "S"
                why = "soft 19+"
        else:
            if total <= 11:
                rec = "H"
                why = "<=11"
            elif total >= 17:
                rec = "S"
                why = ">=17"
            elif total == 12:
                if 4 <= dealer_val <= 6:
                    rec = "S"
                    why = "12 vs 4-6"
                else:
                    rec = "H"
                    why = "12 vs 2-3/7+"
            elif 13 <= total <= 16:
                # Surrender spots (when available)
                if total == 16 and dealer_val in (9, 10, 11):
                    rec = "R"
                    why = "16 vs 9/A/10"
                elif total == 15 and dealer_val == 10:
                    rec = "R"
                    why = "15 vs 10"
                elif 2 <= dealer_val <= 6:
                    rec = "S"
                    why = f"{total} vs 2-6"
                else:
                    rec = "H"
                    why = f"{total} vs 7+"
            else:
                # 12-16 already handled; keep conservative default
                rec = "H" if total < 17 else "S"

        word = "HIT" if rec == "H" else "STAND" if rec == "S" else "SURRENDER"
        if level == "detailed":
            detail = f" — {why}" if why else ""
            soft_tag = " soft" if is_soft else ""
            return (
                f"{Color.WHITE}[TIP]{Color.RESET} {Color.CYAN}{word}{Color.RESET}"
                f"{detail} | you {total}{soft_tag} vs dealer {upcard}"
            )
        # subtle: show only when it really matters, and keep it tiny.
        show = False
        if rec == "R":
            show = True
        elif 12 <= total <= 16:
            show = True
        elif dealer_val in (10, 11):
            show = True
        if not show:
            return None

        tiny = rec  # H/S/R
        # Keep the line extremely short to avoid clutter, especially in quick play.
        return f"{Color.WHITE}[TIP]{Color.RESET} {Color.CYAN}{tiny}{Color.RESET}"
    
    def surrender(self):
        """Player surrenders and gets half of the bet back."""
        surrender_amount = (self.current_bet + 1) // 2
        self.player_balance += surrender_amount
        type_text(f"[SURRENDER] You surrender and get ${surrender_amount} back.", Color.BLUE)
        return True
    
    def play_round(self):
        round_bet = int(self.current_bet)
        round_ts = time.strftime("%Y-%m-%d %H:%M:%S")

        # In quick play, keep the terminal clean by overwriting the previous round.
        if getattr(self, "quick_play", False):
            self._clear_screen()

        try:
            self.start_round()
            self.show_hands()

            player_blackjack = self.player_hand.is_blackjack()
            dealer_blackjack = self.dealer_hand.is_blackjack()
            if player_blackjack or dealer_blackjack:
                print("\n" + "=" * 100)
                if player_blackjack and dealer_blackjack:
                    print(f"Dealer: {' '.join(str(card) for card in self.dealer_hand.cards)}")
                    print(f"You:    {' '.join(str(card) for card in self.player_hand.cards)}")
                    type_text("[BLACKJACK] Both have blackjack - PUSH!", Color.BLUE)
                    self.player_balance += self.current_bet
                    PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "push", "net": 0})
                elif player_blackjack:
                    print(f"Dealer: {self.dealer_hand.cards[0]} [hidden]")
                    print(f"You:    {' '.join(str(card) for card in self.player_hand.cards)}")
                    type_text("[BLACKJACK] YOU WIN! Natural Blackjack!", Color.GREEN)
                    winnings = int(self.current_bet * 2.5)  # 3:2 payout for blackjack
                    bonus = max(1, int(self.current_bet * 0.1)) if self.current_bet >= 10 else 0
                    total_winnings = winnings + bonus
                    if bonus > 0:
                        print(f"{Color.YELLOW}[BONUS] +${bonus} winner bonus!{Color.RESET}")
                    self.player_balance += total_winnings
                    net = total_winnings - round_bet
                    PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "blackjack", "net": int(net)})
                else:
                    dealer_cards = " ".join(str(card) for card in self.dealer_hand.cards)
                    print(f"Dealer: {dealer_cards}")
                    print(f"You:    {' '.join(str(card) for card in self.player_hand.cards)}")
                    type_text("[BLACKJACK] Dealer has Natural Blackjack - You lose!", Color.RED)
                    PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "lose", "net": -round_bet})
                print("=" * 100)
                return

            # Player's turn
            if self.quick_play:
                if not getattr(self, "_quick_play_banner_shown", False):
                    print(f"{Color.CYAN}[QUICK PLAY MODE ENABLED]{Color.RESET}")
                    print("  → Right: Hit | ← Left: Stand | ↓ Down: Surrender | ↑ Up: Repeat Last Bet")
                    print("  (H/S/R) also work.")
                    self._quick_play_banner_shown = True

            while True:
                # Beginner tip (subtle). Only print when it changes to avoid spam in quick play.
                tip_line = self._coach_tip_line()
                if tip_line and tip_line != getattr(self, "_last_tip_line", None):
                    print(tip_line)
                    self._last_tip_line = tip_line

                if self.quick_play:
                    action = self._read_quick_action()
                    if not action:
                        print(f"\n{Color.YELLOW}[!] Invalid key. Use arrows or H/S/R.{Color.RESET}")
                        continue
                else:
                    action = input("\n>>> Choose (H)it, (S)tand, or (R)esurrender? ").strip().upper()

                if action == 'H':
                    if not self.player_hit():
                        print("\n" + "-" * 100)
                        print(f"Your hand: {self.player_hand}")
                        print(f"Value: {self.player_hand.get_value()}")
                        type_text("\n[BUST] YOU BUST! Dealer wins!", Color.RED)
                        print("-" * 100)
                        PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "bust", "net": -round_bet})
                        return
                    self.show_hands()
                    continue

                if action == 'S':
                    break

                if action == 'R':
                    if self.surrender():
                        refund = (round_bet + 1) // 2
                        PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "surrender", "net": -round_bet + refund})
                        return
                    continue

                if self.quick_play and action == 'U':
                    if self.last_bet and self.last_bet > 0 and self.last_bet <= self.player_balance + self.current_bet:
                        self.player_balance += self.current_bet  # refund current bet
                        self.place_bet(self.last_bet)
                        print(f"{Color.GREEN}[OK] Repeated last bet: ${self.last_bet}{Color.RESET}")
                    else:
                        print(f"{Color.RED}[!] No valid last bet to repeat.{Color.RESET}")
                    continue

                print("[!] Invalid input. Please enter H, S, or R.")

            # Dealer's turn
            print("\n[>] Dealer's turn...")
            try:
                self.dealer_play()
            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f"{Color.RED}[ERROR] An error occurred during dealer's turn: {e}{Color.RESET}")
                PlayerDatabase.save_player_balance(self.player_name, self.player_balance)
                try:
                    PlayerDatabase.update_player_stats(self.player_name)
                except Exception as e2:
                    _debug_log("Failed to update stats after dealer-turn error", e2)
                return

            self.show_hands(show_dealer_hole=True)
            print("\n" + "=" * 50)
            print("RESULT")
            print("=" * 50)

            # Determine winner
            try:
                result = self.determine_winner()
                final_result = self.apply_win_chance(result)
            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f"{Color.RED}[ERROR] An error occurred while evaluating the result: {e}{Color.RESET}")
                PlayerDatabase.save_player_balance(self.player_name, self.player_balance)
                try:
                    PlayerDatabase.update_player_stats(self.player_name)
                except Exception as e2:
                    _debug_log("Failed to update stats after result-evaluation error", e2)
                return

            if final_result == "bust":
                type_text("[BUST] YOU BUST! Dealer wins!", Color.RED)
                PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "bust", "net": -round_bet})
            elif final_result == "win":
                winnings = self.current_bet * 2
                self.player_balance += winnings
                type_text(f"[WIN] YOU WIN! +${self.current_bet}", Color.GREEN)
                PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "win", "net": round_bet})
            elif final_result == "lose":
                type_text(f"[LOSS] Dealer wins! You lose ${self.current_bet}", Color.RED)
                PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "lose", "net": -round_bet})
            else:
                self.player_balance += self.current_bet
                type_text(f"[PUSH] It's a PUSH! Your ${self.current_bet} bet is returned.", Color.BLUE)
                PlayerDatabase.append_player_history(self.player_name, {"ts": round_ts, "bet": round_bet, "result": "push", "net": 0})
            print()
        finally:
            # Quick Play: show HUD once per round (not per turn)
            if getattr(self, "quick_play", False):
                self._print_quick_hud_bottom()
    
    def run(self):
        print("\n" + "=" * 100)
        type_text("                         BLACKJACK", Color.CYAN)
        print("=" * 100)
        
        # Display controls
        print("\n" + "-" * 100)
        print("CONTROLS:")
        print("-" * 100)
        print(f"{Color.CYAN}GAME START:{Color.RESET}")
        print(f"  (START)                - Begin playing blackjack")
        print()
        print(f"{Color.GREEN}DURING GAMEPLAY:{Color.RESET}")
        print(f"  (H) HIT                - Draw another card")
        print(f"  (S) STAND              - Keep your hand and end turn")
        print(f"  (R) SURRENDER          - Give up, get half your bet back")
        print()
        print(f"{Color.YELLOW}OTHER:{Color.RESET}")
        print(f"  (B) BONUS              - [DEV] Add $500 to balance")
        print(f"  (D) DELETE             - Delete your player profile")
        print(f"  (V) VIEW               - Cycle view styles (classic / nocolor / alt / stack)")
        print(f"  (O) OPTIONS            - Open view/game settings (Beginner Mode, Quick Play)")
        print(f"  (L) LOG/STATS          - Show your recent round history")
        print(f"  SPACEBAR               - Quit the game")
        print("-" * 100 + "\n")
        
        print(f"{Color.CYAN}Welcome, {self.player_name}!{Color.RESET}\n")
        
        # Wait for START command
        while True:
            start_input = input(">>> Type START to begin playing (or SPACEBAR to return to menu): ").strip().upper()
            if start_input == 'START':
                break
            elif start_input == 'V':
                # Open view settings before starting
                self.view_menu()
                continue
            elif start_input == 'O':
                self.view_menu()
                continue
            elif start_input == 'L':
                self.show_round_history()
                continue
            elif start_input == '':
                # Save balance and return to main menu
                PlayerDatabase.save_player_balance(self.player_name, self.player_balance)
                return
            else:
                print(f"{Color.RED}[!] Please type START to begin or press SPACEBAR to return to menu!{Color.RESET}")
        
        print(f"\n{Color.GREEN}[OK] Let's play!{Color.RESET}\n")
        
        while self.player_balance > 0:
            print(f"\n{Color.YELLOW}Current Balance: ${self.player_balance}{Color.RESET}")
            
            # Get bet
            while True:
                try:
                    if self.quick_play:
                        bet_input = self._read_quick_line("\n>>> Enter your bet (\u2191 repeat, \u2193 new bet): $")
                    else:
                        bet_input = input("\n>>> Enter your bet: $")

                    # Quick Play: Up Arrow = repeat last bet and immediately start round
                    if self.quick_play and bet_input == "__UP__":
                        if self.last_bet is None or self.last_bet <= 0:
                            print(f"{Color.RED}[!] No last bet to repeat yet.{Color.RESET}")
                            continue
                        if self.place_bet(self.last_bet):
                            print(f"{Color.GREEN}[OK] Bet placed: ${self.last_bet}{Color.RESET}")
                            break
                        print(f"{Color.RED}[!] Could not place last bet.{Color.RESET}")
                        continue

                    # Quick Play: Down Arrow = explicitly enter a new bet (between rounds)
                    if self.quick_play and bet_input == "__DOWN__":
                        bet_input = self._read_quick_line("\n>>> New bet: $")
                        if bet_input in ("__UP__", "__DOWN__"):
                            continue
                    
                    # Check for spacebar quit
                    if bet_input.strip() == '':
                        print(f"\n" + "-" * 100)
                        type_text(f"Final Balance: ${self.player_balance}", Color.CYAN)
                        type_text("Thanks for playing! Goodbye!", Color.CYAN)
                        print("-" * 100)
                        # Save balance before quitting
                        PlayerDatabase.save_player_balance(self.player_name, self.player_balance)
                        try:
                            PlayerDatabase.update_player_stats(self.player_name)
                        except Exception as e:
                            _debug_log("Failed to update stats on quit", e)
                        print(f"{Color.GREEN}[SAVED] Your balance has been saved!{Color.RESET}")
                        return
                    
                    # Check for delete player
                    if bet_input.lower() == 'd':
                        print(f"\n{Color.RED}[WARNING] Are you sure you want to delete your profile '{self.player_name}'?{Color.RESET}")
                        confirm_input = input(">>> Press D again to confirm deletion (or press ENTER to cancel): ").strip().upper()
                        if confirm_input == 'D':
                            if PlayerDatabase.delete_player(self.player_name):
                                type_text(f"[DELETED] Profile '{self.player_name}' has been permanently deleted!", Color.RED)
                                return
                        else:
                            print(f"{Color.GREEN}[CANCELLED] Deletion cancelled.{Color.RESET}")
                        continue
                    
                    # Check for development tool
                    if bet_input.lower() == 'b':
                        self.player_balance += 500
                        print(f"{Color.GREEN}[DEV] +$500 added! New balance: ${self.player_balance}{Color.RESET}")
                        continue

                    # Show stats
                    if bet_input.lower() == 'l':
                        self.show_round_history()
                        continue

                    # Toggle view
                    if bet_input.lower() == 'v':
                        self.toggle_view()
                        continue

                    # Options menu
                    if bet_input.lower() == 'o':
                        self.view_menu()
                        continue

                    bet = int(bet_input)
                    if self.place_bet(bet):
                        print(f"{Color.GREEN}[OK] Bet placed: ${bet}{Color.RESET}")
                        break
                except ValueError:
                    print(f"{Color.RED}[!] Invalid input. Please enter a number.{Color.RESET}")
            
            # Play round
            self.play_round()
            
            # Give player $10 if they go broke
            if self.player_balance <= 0:
                print(f"\n{Color.YELLOW}[!] You're out of money! Here's $10 to keep playing.{Color.RESET}")
                self.player_balance = 10
        
        print(f"\nGame Over! Final balance: ${self.player_balance}")
        
        # Save player balance to database
        PlayerDatabase.save_player_balance(self.player_name, self.player_balance)
        try:
            PlayerDatabase.update_player_stats(self.player_name)
        except Exception as e:
            _debug_log("Failed to update stats at game end", e)
        print(f"{Color.GREEN}[SAVED] Your balance has been saved!{Color.RESET}")

def main():
    print("\n" + "=" * 100)
    type_text("                   BLACKJACK PLAYER SYSTEM", Color.CYAN)
    print("=" * 100)
    
    while True:
        print("\n" + "-" * 100)
        print(f"{Color.CYAN}(E) EXISTING PLAYER{Color.RESET}")
        print(f"{Color.GREEN}(P) REGISTER NEW PLAYER{Color.RESET}")
        print(f"{Color.RED}(Q) QUIT{Color.RESET}")
        print("-" * 100)
        
        choice = input("\n>>> Choose (E)xisting, (P)lay as new, or (Q)uit? ").strip().upper()
        
        if choice == 'Q':
            type_text("Thanks for playing! Goodbye!", Color.CYAN)
            break
        elif choice == 'E':
            players = PlayerDatabase.load_players()
            if not (isinstance(players, dict) and players):
                print(f"{Color.YELLOW}No players registered yet. Choose (P) to create one.{Color.RESET}")

            player_name = input("\n>>> Enter your name: ").strip()
            if player_name == '':
                print(f"{Color.RED}[!] Name cannot be empty!{Color.RESET}")
                continue

            # Allow case-insensitive login (common typo on Windows terminals).
            if not PlayerDatabase.player_exists(player_name):
                matches = []
                if isinstance(players, dict):
                    try:
                        matches = [k for k in players.keys() if k.lower() == player_name.lower()]
                    except Exception:
                        matches = []

                if len(matches) == 1:
                    player_name = matches[0]
                else:
                    print(f"{Color.RED}[!] Player '{player_name}' not found!{Color.RESET}")
                    continue

            password = input(">>> Enter your password: ").strip()
            if not PlayerDatabase.verify_password(player_name, password):
                print(f"{Color.RED}[!] Incorrect password!{Color.RESET}")
                continue

            balance = PlayerDatabase.get_player_balance(player_name)
            print(f"{Color.GREEN}[OK] Welcome back! Your balance: ${balance}{Color.RESET}")
            game = BlackjackGame(player_name)
            game.run()
        elif choice == 'P':
            players = PlayerDatabase.load_players()

            player_name = input("\n>>> Enter your new player name: ").strip()
            if player_name == '':
                print(f"{Color.RED}[!] Name cannot be empty!{Color.RESET}")
                continue

            # Prevent confusing duplicates like 'Dev' vs 'dev'.
            existing_match = None
            if isinstance(players, dict):
                for k in players.keys():
                    if k.lower() == player_name.lower():
                        existing_match = k
                        break

            if existing_match is not None:
                print(f"{Color.RED}[!] Player '{existing_match}' already exists!{Color.RESET}")
                continue

            password = input(">>> Enter your password: ").strip()
            if password == '':
                print(f"{Color.RED}[!] Password cannot be empty!{Color.RESET}")
                continue

            try:
                PlayerDatabase.create_player(player_name, password, 100)
            except Exception as e:
                print(f"{Color.RED}[ERROR] Failed to create player: {e}{Color.RESET}")
                continue
            print(f"{Color.GREEN}[OK] New player '{player_name}' registered with $100!{Color.RESET}")
            game = BlackjackGame(player_name)
            game.run()
        else:
            print(f"{Color.RED}[!] Invalid input. Please enter E, P, or Q.{Color.RESET}")

if __name__ == "__main__":
    main()
