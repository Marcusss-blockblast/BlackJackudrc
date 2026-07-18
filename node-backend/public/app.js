const AUTH_STORE_KEY = "blackjack-browser-client:auth:v1";
const ADMIN_TOKEN_KEY = "blackjack-browser-client:admin:v1";
const OPEN_TABLE_IDS = ["table-1", "table-2", "table-3", "table-4"];
const socket = io();

const state = {
  authenticated: false,
  joined: false,
  currentState: null,
  account: null,
  authMode: "login",
  lastIdentity: null,
  tableSessionStartBalance: null,
  tableSessionId: null,
  tables: [],
  lastTablesFetchId: 0,
  lastAppliedTablesFetchId: 0,
};

function isMobileLayout() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function syncResponsiveShell() {
  const mobile = isMobileLayout();
  document.body.classList.toggle("is-mobile-layout", mobile);
  document.body.classList.toggle("is-mobile-joined", mobile && state.joined);
  document.body.classList.toggle("is-mobile-lobby", mobile && !state.joined);
}

function isCurrentUserAdmin() {
  return state.account?.role === "admin";
}

const elements = {
  connectionBadge: document.querySelector("#connectionBadge"),
  mySeatHeroLabel: document.querySelector("#mySeatHeroLabel"),
  myTableHeroLabel: document.querySelector("#myTableHeroLabel"),
  myAvatarChip: document.querySelector("#myAvatarChip"),
  roundSummary: document.querySelector("#roundSummary"),
  menuToggleButton: document.querySelector("#menuToggleButton"),
  menuCloseButton: document.querySelector("#menuCloseButton"),
  menuBackdrop: document.querySelector("#menuBackdrop"),
  sideMenu: document.querySelector("#sideMenu"),
  authGate: document.querySelector("#authGate"),
  authForm: document.querySelector("#authForm"),
  authTabLogin: document.querySelector("#authTabLogin"),
  authTabRegister: document.querySelector("#authTabRegister"),
  authUsernameInput: document.querySelector("#authUsernameInput"),
  authPasswordInput: document.querySelector("#authPasswordInput"),
  authConfirmField: document.querySelector("#authConfirmField"),
  authConfirmInput: document.querySelector("#authConfirmInput"),
  authError: document.querySelector("#authError"),
  authSubmitButton: document.querySelector("#authSubmitButton"),
  accountUsernameLabel: document.querySelector("#accountUsernameLabel"),
  accountBalanceLabel: document.querySelector("#accountBalanceLabel"),
  logoutButton: document.querySelector("#logoutButton"),
  quickTablesGrid: document.querySelector("#quickTablesGrid"),
  betInput: document.querySelector("#betInput"),
  betBalanceLabel: document.querySelector("#betBalanceLabel"),
  placeBetButton: document.querySelector("#placeBetButton"),
  hitButton: document.querySelector("#hitButton"),
  standButton: document.querySelector("#standButton"),
  splitButton: document.querySelector("#splitButton"),
  doubleDownButton: document.querySelector("#doubleDownButton"),
  insuranceButton: document.querySelector("#insuranceButton"),
  declineInsuranceButton: document.querySelector("#declineInsuranceButton"),
  surrenderButton: document.querySelector("#surrenderButton"),
  leaveButton: document.querySelector("#leaveButton"),
  phaseLabel: document.querySelector("#phaseLabel"),
  currentPlayerLabel: document.querySelector("#currentPlayerLabel"),
  dealerCards: document.querySelector("#dealerCards"),
  dealerValue: document.querySelector("#dealerValue"),
  resultBanner: document.querySelector("#resultBanner"),
  playersList: document.querySelector("#playersList"),
  mySessionValue: document.querySelector("#mySessionValue"),
  myPlayersValue: document.querySelector("#myPlayersValue"),
  myPhaseValue: document.querySelector("#myPhaseValue"),
  actionHint: document.querySelector("#actionHint"),
  adminMenuButton: document.querySelector("#adminMenuButton"),
  adminGate: document.querySelector("#adminGate"),
  adminLoginForm: document.querySelector("#adminLoginForm"),
  adminPasswordInput: document.querySelector("#adminPasswordInput"),
  adminLoginError: document.querySelector("#adminLoginError"),
  adminGateCloseButton: document.querySelector("#adminGateCloseButton"),
  adminPanel: document.querySelector("#adminPanel"),
  adminRefreshButton: document.querySelector("#adminRefreshButton"),
  adminLogoutButton: document.querySelector("#adminLogoutButton"),
  adminCloseButton: document.querySelector("#adminCloseButton"),
  adminStatusLine: document.querySelector("#adminStatusLine"),
  adminAccountsBody: document.querySelector("#adminAccountsBody"),
  adminTablesList: document.querySelector("#adminTablesList"),
  adminBulkDeltaInput: document.querySelector("#adminBulkDeltaInput"),
  adminBulkApplyButton: document.querySelector("#adminBulkApplyButton"),
};

function defaultState() {
  return {
    tableId: null,
    phase: "not_joined",
    stateVersion: 0,
    currentPlayerId: null,
    dealer: {
      cards: [],
      value: null,
    },
    players: [],
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hashStringToHue(value) {
  let hash = 0;
  for (const char of String(value ?? "player")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash % 360;
}

function getAvatarColor(id) {
  const hue = hashStringToHue(id);
  return `hsl(${hue}, 62%, 46%)`;
}

function getInitials(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "?";
  }

  const parts = trimmed.split(/\s+/).slice(0, 2);
  const initials = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  return initials || trimmed[0]?.toUpperCase() || "?";
}

function setMenuOpen(isOpen) {
  elements.sideMenu.classList.toggle("is-open", isOpen);
  elements.menuBackdrop.classList.toggle("is-active", isOpen);
  elements.menuToggleButton.setAttribute("aria-expanded", String(isOpen));
}

function showAuthGate() {
  elements.authGate.classList.add("is-visible");
}

function hideAuthGate() {
  elements.authGate.classList.remove("is-visible");
}

function loadStoredAuth() {
  try {
    const raw = window.localStorage.getItem(AUTH_STORE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredAuth(auth) {
  try {
    window.localStorage.setItem(AUTH_STORE_KEY, JSON.stringify(auth));
  } catch {
    // Ignore storage errors in private/incognito contexts.
  }
}

function clearStoredAuth() {
  try {
    window.localStorage.removeItem(AUTH_STORE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function updateAccountLabel() {
  elements.accountUsernameLabel.textContent = state.account?.displayName ?? "-";
  elements.accountBalanceLabel.textContent = state.account?.balance ?? "-";
}

function updateBetBalanceLabel() {
  const me = getMe();
  const bankroll = Number.parseInt(me?.balance ?? state.account?.balance, 10);

  if (!Number.isFinite(bankroll)) {
    elements.betBalanceLabel.textContent = "-";
    return;
  }

  elements.betBalanceLabel.textContent = `${bankroll}`;
}

function formatSessionDelta(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return `${value > 0 ? "+" : ""}${value}`;
}

function syncTableSessionBaseline(me) {
  const currentTableId = state.currentState?.tableId ?? null;
  if (!currentTableId || !me) {
    return;
  }

  if (state.tableSessionId !== currentTableId || state.tableSessionStartBalance === null) {
    state.tableSessionId = currentTableId;
    state.tableSessionStartBalance = Number.parseInt(me.balance, 10) || 0;
  }
}

function clearTableSessionBaseline() {
  state.tableSessionId = null;
  state.tableSessionStartBalance = null;
}

function applyAccount(account, token, lastTableId = null) {
  state.account = {
    token,
    username: account.username,
    displayName: account.displayName,
    balance: account.balance,
    role: account.role ?? "user",
    lastTableId: lastTableId ?? state.account?.lastTableId ?? null,
  };
  state.authenticated = true;
  saveStoredAuth(state.account);
  updateAccountLabel();
  refreshAdminVisibility();
}

function refreshAdminVisibility() {
  const isAdmin = isCurrentUserAdmin();
  elements.adminMenuButton.hidden = !isAdmin;

  if (!isAdmin) {
    closeAdminPanel();
    closeAdminGate();
    adminToken = null;
    saveStoredAdminToken(null);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }

  return payload;
}

function formatResult(result) {
  return String(result ?? "-")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatHandValue(hand) {
  if (!hand || hand.value === null || hand.value === undefined) {
    return "-";
  }

  return hand.alternateValue !== null && hand.alternateValue !== undefined
    ? `${hand.value} / ${hand.alternateValue}`
    : `${hand.value}`;
}

function getHandEntries(player) {
  if (Array.isArray(player?.hands) && player.hands.length > 0) {
    return player.hands;
  }

  if (!player) {
    return [];
  }

  return [{
    index: 0,
    isActive: true,
    currentBet: player.currentBet,
    lastBet: player.lastBet,
    status: player.status,
    roundResult: player.roundResult,
    lastPayout: player.lastPayout,
    hand: player.hand,
  }];
}

function getActiveHandEntry(player) {
  const hands = getHandEntries(player);
  return hands.find((hand) => hand.isActive) ?? hands[0] ?? null;
}

function canSplitHand(player) {
  const activeHand = getActiveHandEntry(player);
  const cards = activeHand?.hand?.cards ?? [];
  if (!player || cards.length !== 2 || Number(activeHand.currentBet) <= 0) {
    return false;
  }

  return Number(player.balance) >= Number(activeHand.currentBet) && Number(cards[0]?.value) === Number(cards[1]?.value);
}

function canTakeInsuranceHand(player) {
  const activeHand = getActiveHandEntry(player);
  return Boolean(
    activeHand
      && activeHand.insuranceStatus === "available"
      && Number(activeHand.currentBet) >= 2
      && Number(player.balance) >= Math.floor(Number(activeHand.currentBet) / 2),
  );
}

function canDeclineInsuranceHand(player) {
  const activeHand = getActiveHandEntry(player);
  return Boolean(activeHand && activeHand.insuranceStatus === "available");
}

function logLine(message, detail = null) {
  const prefix = `[${new Date().toLocaleTimeString()}] ${message}`;
  if (detail) {
    console.log(prefix, detail);
    return;
  }

  console.log(prefix);
}

function setConnection(connected) {
  elements.connectionBadge.textContent = connected ? "Connected" : "Disconnected";
  elements.connectionBadge.className = connected ? "badge badge-online" : "badge badge-offline";
}

function getIdentityForTable(tableId) {
  return {
    tableId,
    token: state.account?.token ?? "",
  };
}

function getMe() {
  const playerId = state.account?.username;
  if (!playerId || !state.currentState) {
    return null;
  }

  return state.currentState.players.find((player) => player.id === playerId) ?? null;
}

function getPlayerById(playerId) {
  return state.currentState?.players?.find((player) => player.id === playerId) ?? null;
}

function getRoundSummary(nextState = state.currentState, me = getMe()) {
  if (!state.joined && state.authenticated && !nextState) {
    return "You were removed from the table. Pick a new seat from the lobby.";
  }

  if (!state.joined || !nextState) {
    if (!state.authenticated) {
      return "Sign in to start playing.";
    }

    return "Pick a table from the lobby to sit down.";
  }

  if (nextState.phase === "waiting_for_bets") {
    const readyPlayers = nextState.players.filter((player) => player.currentBet > 0).length;
    return readyPlayers > 0
      ? `${readyPlayers} player${readyPlayers === 1 ? "" : "s"} ready. Deal when everyone is set.`
      : "Place a bet to open the round.";
  }

  if (nextState.phase === "player_turns") {
    if (me?.canAct) {
      const activeHand = getActiveHandEntry(me);
      const handLabel = me.handCount > 1 ? ` on hand ${Number(activeHand?.index ?? 0) + 1} of ${me.handCount}` : "";
      return `Your move${handLabel}. Hit, stand, split, double down, or surrender.`;
    }

    const actingPlayer = getPlayerById(nextState.currentPlayerId);
    const handLabel = actingPlayer && nextState.currentHandIndex !== null && nextState.currentHandIndex !== undefined && actingPlayer.handCount > 1
      ? ` on hand ${nextState.currentHandIndex + 1} of ${actingPlayer.handCount}`
      : "";
    return actingPlayer
      ? `Waiting for ${actingPlayer.name} to act${handLabel}.`
      : "Player action in progress.";
  }

  if (nextState.phase === "insurance") {
    if (me?.canAct) {
      const activeHand = getActiveHandEntry(me);
      const insuranceAmount = activeHand ? Math.floor(Number(activeHand.currentBet) / 2) : 0;
      return `Dealer shows an ace. Take insurance for ${insuranceAmount} or pass.`;
    }

    const actingPlayer = getPlayerById(nextState.currentPlayerId);
    return actingPlayer
      ? `Waiting for ${actingPlayer.name} to respond to insurance.`
      : "Resolving insurance offers.";
  }

  if (nextState.phase === "dealer_turn") {
    return "Dealer is drawing out the hand.";
  }

  if (nextState.phase === "round_complete") {
    if (me?.lastPayout) {
      return `${formatResult(me.lastPayout.result)}. Net ${me.lastPayout.net >= 0 ? "+" : ""}${me.lastPayout.net}.`;
    }

    return "Round complete. Place bets for the next hand.";
  }

  return "Take a seat and get the table moving.";
}

function renderCards(container, cards = []) {
  container.innerHTML = "";

  if (cards.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No cards dealt yet";
    container.append(empty);
    return;
  }

  for (const card of cards) {
    const tile = document.createElement("div");
    tile.className = "card-tile";
    tile.dataset.suit = card.suit ?? "";
    tile.innerHTML = `
      <span class="card-rank">${escapeHtml(card.rank ?? card.label ?? "?")}</span>
      <span class="card-suit">${escapeHtml((card.label ?? "?").slice(-1))}</span>
    `;

    container.append(tile);
  }
}

function renderPlayers(players = []) {
  elements.playersList.innerHTML = "";

  if (players.length === 0) {
    elements.playersList.innerHTML = '<div class="empty-state">No players seated yet. Open this page in a second browser to play multiplayer locally.</div>';
    return;
  }

  for (const player of players) {
    const card = document.createElement("article");
    const isOffline = player.connectionState === "disconnected";
    card.className = `player-card${player.isViewer ? " is-you" : ""}${player.canAct ? " is-current" : ""}${isOffline ? " is-offline" : ""}`;
    const connectionClass = player.isConnected ? "online" : "offline";
    const connectionLabel = player.isConnected ? "Online" : "Offline";
    const turnLabel = player.canAct
      ? player.isViewer
        ? "Your turn"
        : "Current turn"
      : formatResult(player.status);
    const handEntries = getHandEntries(player);

    card.innerHTML = `
      <div class="player-head">
        <div class="avatar-chip" style="background:${getAvatarColor(player.id)}">${escapeHtml(getInitials(player.name))}</div>
        <strong class="player-name">${escapeHtml(player.name)}${player.isViewer ? " (You)" : ""}</strong>
        <div class="player-tags">
          <span class="mini-badge ${player.canAct ? "turn" : ""}">${escapeHtml(turnLabel)}</span>
          <span class="mini-badge ${connectionClass}">${escapeHtml(connectionLabel)}</span>
        </div>
      </div>
      <div class="player-summary">
        <span>Balance ${player.balance}</span>
        <span>${handEntries.length} hand${handEntries.length === 1 ? "" : "s"}</span>
        <span>Active ${Number(player.activeHandIndex ?? 0) + 1}</span>
      </div>
      <div class="hand-stack"></div>
    `;

    const handStack = card.querySelector(".hand-stack");
    for (const handEntry of handEntries) {
      const handBlock = document.createElement("section");
      handBlock.className = `hand-block${handEntry.isActive ? " is-active" : ""}`;
      const resultLabel = handEntry.lastPayout
        ? `Result ${formatResult(handEntry.lastPayout.result)} (${handEntry.lastPayout.net >= 0 ? "+" : ""}${handEntry.lastPayout.net})`
        : handEntry.roundResult
          ? formatResult(handEntry.roundResult)
          : "Waiting for outcome";
      const insuranceLabel = handEntry.insuranceStatus === "available"
        ? `Insurance ${handEntry.insuranceBet ? `(${handEntry.insuranceBet})` : "available"}`
        : "";
      handBlock.innerHTML = `
        <div class="hand-head">
          <strong>Hand ${handEntry.index + 1}</strong>
          <span class="mini-badge ${handEntry.isActive && player.canAct ? "turn" : ""}">${escapeHtml(formatResult(handEntry.status))}</span>
        </div>
        <div class="hand-meta">
          <span class="hand-metric"><span class="hand-metric-label">Bet</span><strong class="hand-metric-value">${escapeHtml(String(handEntry.currentBet ?? 0))}</strong></span>
          <span class="hand-metric"><span class="hand-metric-label">Value</span><strong class="hand-metric-value">${escapeHtml(formatHandValue(handEntry.hand))}</strong></span>
          ${insuranceLabel ? `<span class="hand-metric hand-metric-insurance"><span class="hand-metric-label">Insurance</span><strong class="hand-metric-value">${escapeHtml(insuranceLabel.replace(/^Insurance\s*/, ""))}</strong></span>` : ""}
        </div>
        <div class="card-row"></div>
        <p class="hand-line muted">${escapeHtml(resultLabel)}</p>
      `;
      renderCards(handBlock.querySelector(".card-row"), handEntry.hand?.cards ?? []);
      handStack.append(handBlock);
    }

    elements.playersList.append(card);
  }
}

function renderTables(tables = []) {
  elements.quickTablesGrid.innerHTML = "";
  const byId = new Map(tables.map((table) => [table.tableId, table]));

  for (const tableId of OPEN_TABLE_IDS) {
    const live = byId.get(tableId) ?? { tableId, seatsTaken: 0, phase: "waiting_for_players" };
    const seatsTaken = Number.parseInt(live.seatsTaken, 10) || 0;
    const isCurrent = tableId === state.currentState?.tableId;
    const card = document.createElement("article");
    card.className = `quick-table-card${isCurrent ? " current" : ""}`;
    card.innerHTML = `
      <div class="quick-table-head">
        <strong class="quick-table-name">${escapeHtml(tableId)}</strong>
        <span class="quick-table-count">${seatsTaken}/7</span>
      </div>
      <p class="quick-table-meta">${escapeHtml(formatResult(live.phase))} · ${seatsTaken} player${seatsTaken === 1 ? "" : "s"} seated</p>
      <button type="button" data-table-id="${escapeHtml(tableId)}" ${state.authenticated ? "" : "disabled"}>${isCurrent ? "Playing Here" : "Sit Here"}</button>
    `;
    elements.quickTablesGrid.append(card);
  }
}

function toNumericStateVersion(candidate) {
  const parsed = Number.parseInt(candidate, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStaleStateUpdate(nextState) {
  if (!nextState || !state.currentState) {
    return false;
  }

  if (!nextState.tableId || nextState.tableId !== state.currentState.tableId) {
    return false;
  }

  const incomingVersion = toNumericStateVersion(nextState.stateVersion);
  const currentVersion = toNumericStateVersion(state.currentState.stateVersion);

  return incomingVersion !== null && currentVersion !== null && incomingVersion < currentVersion;
}

function upsertTableSummaryFromState(nextState) {
  if (!nextState?.tableId) {
    return;
  }

  const nextSummary = {
    tableId: nextState.tableId,
    phase: nextState.phase,
    seatsTaken: Array.isArray(nextState.players) ? nextState.players.length : 0,
    currentPlayerId: nextState.currentPlayerId ?? null,
    stateVersion: nextState.stateVersion ?? null,
  };

  const tableIndex = state.tables.findIndex((table) => table.tableId === nextSummary.tableId);
  if (tableIndex === -1) {
    state.tables = [nextSummary, ...state.tables];
    renderTables(state.tables);
    return;
  }

  const currentSummary = state.tables[tableIndex];
  const incomingVersion = toNumericStateVersion(nextSummary.stateVersion);
  const currentVersion = toNumericStateVersion(currentSummary.stateVersion);
  if (incomingVersion !== null && currentVersion !== null && incomingVersion < currentVersion) {
    return;
  }

  state.tables[tableIndex] = { ...currentSummary, ...nextSummary };
  renderTables(state.tables);
}

function updateSeatSummary(me) {
  const activeHand = getActiveHandEntry(me);
  const fallbackName = state.account?.displayName ?? "Not seated";
  const displayName = me ? `${me.name} (You)` : fallbackName;
  const displayTable = state.currentState?.tableId ?? state.account?.lastTableId ?? "-";
  const avatarSourceId = me?.id ?? state.account?.username ?? "player";
  const avatarSourceName = me?.name ?? state.account?.displayName ?? "";
  elements.mySeatHeroLabel.textContent = displayName;
  elements.myTableHeroLabel.textContent = displayTable;
  elements.myAvatarChip.style.background = getAvatarColor(avatarSourceId);
  elements.myAvatarChip.textContent = getInitials(avatarSourceName);
  elements.roundSummary.textContent = state.joined ? "" : getRoundSummary(state.currentState, me);

  if (me) {
    syncTableSessionBaseline(me);
  } else if (!state.joined) {
    clearTableSessionBaseline();
  }

  const playerCount = Array.isArray(state.currentState?.players) ? state.currentState.players.length : null;
  const phaseLabel = state.currentState?.phase ? formatResult(state.currentState.phase) : "-";
  const currentBalance = Number.parseInt(me?.balance ?? state.account?.balance, 10);
  const sessionDelta = state.tableSessionStartBalance !== null && Number.isFinite(currentBalance)
    ? currentBalance - state.tableSessionStartBalance
    : null;
  elements.mySessionValue.textContent = formatSessionDelta(sessionDelta);
  elements.myPlayersValue.textContent = playerCount !== null ? `${playerCount}` : "-";
  elements.myPhaseValue.textContent = phaseLabel;

  if (me && state.account?.username === me.id) {
    state.account = {
      ...state.account,
      balance: Number.parseInt(me.balance, 10) || state.account.balance,
      role: me.role ?? state.account.role,
      lastTableId: state.currentState?.tableId ?? state.account.lastTableId,
    };
    saveStoredAuth(state.account);
    updateAccountLabel();
  }

  updateBetBalanceLabel();
}

function updateActionState() {
  const me = getMe();
  const phase = state.currentState?.phase;
  const joined = state.joined;
  const betAmount = Number.parseInt(elements.betInput.value, 10);
  const canInsuranceAct = Boolean(phase === "insurance" && me?.canAct);
  const canAct = Boolean(phase === "player_turns" && me?.canAct);
  const canSplit = Boolean(canAct && canSplitHand(me));
  const canDoubleDown = canAct
    && getActiveHandEntry(me)?.hand?.cards?.length === 2
    && Number(me.balance) >= Number(getActiveHandEntry(me)?.currentBet)
    && Number(getActiveHandEntry(me)?.currentBet) > 0;
  const canTakeInsurance = Boolean(canInsuranceAct && canTakeInsuranceHand(me));
  const canDeclineInsurance = Boolean(canInsuranceAct && canDeclineInsuranceHand(me));
  const canBet = Boolean(
    joined
      && me
      && ["waiting_for_players", "waiting_for_bets", "round_complete"].includes(phase)
      && Number.isFinite(betAmount)
      && betAmount > 0
      && betAmount <= Number(me.balance),
  );
  const canStartRound = Boolean(
    joined
      && ["waiting_for_players", "waiting_for_bets", "round_complete"].includes(phase)
      && state.currentState?.players?.some((player) => player.currentBet > 0),
  );

  elements.placeBetButton.disabled = !canBet;
  elements.hitButton.disabled = !canAct;
  elements.standButton.disabled = !canAct;
  elements.splitButton.disabled = !canSplit;
  elements.doubleDownButton.disabled = !canDoubleDown;
  elements.insuranceButton.disabled = !canTakeInsurance;
  elements.declineInsuranceButton.disabled = !canDeclineInsurance;
  elements.surrenderButton.disabled = !canAct;
  elements.leaveButton.disabled = !joined;

  if (!joined) {
    elements.actionHint.textContent = !state.authenticated
      ? "Sign in, then click Sit Here in the 4-table lobby."
      : "You are at the lobby. Click Sit Here to join a table again.";
    return;
  }

  if (canAct) {
    const actions = ["hit", "stand", "surrender"];
    if (canSplit) {
      actions.splice(2, 0, "split");
    }
    if (canDoubleDown) {
      actions.splice(actions.length - 1, 0, "double down");
    }
    elements.actionHint.textContent = `Your turn. You can ${actions.join(", ")}.`;
    return;
  }

  if (canInsuranceAct) {
    const activeHand = getActiveHandEntry(me);
    const insuranceAmount = activeHand ? Math.floor(Number(activeHand.currentBet) / 2) : 0;
    elements.actionHint.textContent = `Insurance window. Take insurance for ${insuranceAmount} or choose no insurance.`;
    return;
  }

  if (canStartRound) {
    elements.actionHint.textContent = "Round starts automatically once every seated player has placed a bet.";
    return;
  }

  elements.actionHint.textContent = "Waiting for another player, more bets, or the dealer to resolve the hand.";
}

function renderState(nextState) {
  const safeState = nextState ?? defaultState();
  if (isStaleStateUpdate(safeState)) {
    logLine("Ignored stale state update", {
      tableId: safeState.tableId,
      incomingStateVersion: safeState.stateVersion,
      currentStateVersion: state.currentState?.stateVersion,
    });
    return;
  }

  state.currentState = safeState;
  upsertTableSummaryFromState(safeState);

  const me = getMe();
  const currentPlayer = getPlayerById(safeState.currentPlayerId);
  elements.phaseLabel.textContent = `Phase: ${formatResult(safeState.phase)}`;
  elements.currentPlayerLabel.textContent = currentPlayer
    ? `Current player: ${currentPlayer.name}${currentPlayer.handCount > 1 && safeState.currentHandIndex !== null && safeState.currentHandIndex !== undefined ? ` · Hand ${safeState.currentHandIndex + 1}` : ""}`
    : `Current player: ${safeState.currentPlayerId ?? "-"}`;
  elements.resultBanner.textContent = getRoundSummary(safeState, me);
  elements.dealerValue.textContent = `Value: ${safeState?.dealer?.value ?? "-"}`;

  renderCards(elements.dealerCards, safeState?.dealer?.cards ?? []);
  renderPlayers(safeState?.players ?? []);
  updateSeatSummary(me);
  updateActionState();
}

function emitWithAck(eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(eventName, payload, (response = {}) => {
      if (response.ok) {
        resolve(response);
        return;
      }

      reject(new Error(response.error ?? `Failed: ${eventName}`));
    });
  });
}

async function refreshTables() {
  const fetchId = state.lastTablesFetchId + 1;
  state.lastTablesFetchId = fetchId;

  try {
    const response = await fetch("/tables", {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (fetchId < state.lastAppliedTablesFetchId) {
      return;
    }

    state.lastAppliedTablesFetchId = fetchId;
    state.tables = Array.isArray(payload.tables) ? payload.tables : [];

    if (state.currentState?.tableId) {
      upsertTableSummaryFromState(state.currentState);
      return;
    }

    renderTables(state.tables);
  } catch (error) {
    if (fetchId >= state.lastAppliedTablesFetchId) {
      renderTables(state.tables);
    }
    logLine(`Unable to load tables: ${error.message}`);
  }
}

async function joinWithIdentity(identity) {
  const response = await emitWithAck("blackjack:join_table", identity);
  state.joined = true;
  state.lastIdentity = identity;
  if (state.account) {
    state.account = { ...state.account, lastTableId: identity.tableId };
    saveStoredAuth(state.account);
  }
  if (state.tableSessionId !== identity.tableId) {
    state.tableSessionId = identity.tableId;
    state.tableSessionStartBalance = null;
  }
  renderState(response.state);
  setMenuOpen(false);
  syncResponsiveShell();
  logLine("Joined table", { tableId: response.tableId, playerId: response.playerId });
}

function setAuthMode(mode) {
  state.authMode = mode;
  elements.authTabLogin.classList.toggle("is-active", mode === "login");
  elements.authTabRegister.classList.toggle("is-active", mode === "register");
  elements.authConfirmField.hidden = mode !== "register";
  elements.authConfirmInput.required = mode === "register";
  if (mode === "login") {
    elements.authConfirmInput.value = "";
  }
  elements.authPasswordInput.setAttribute("autocomplete", mode === "register" ? "new-password" : "current-password");
  elements.authSubmitButton.textContent = mode === "register" ? "Create Account" : "Sign In";
  elements.authError.textContent = "";
  elements.authError.hidden = true;
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const username = elements.authUsernameInput.value.trim();
  const password = elements.authPasswordInput.value;
  elements.authError.hidden = true;

  if (!username || !password) {
    elements.authError.textContent = "Username and password are required.";
    elements.authError.hidden = false;
    return;
  }

  if (state.authMode === "register" && password !== elements.authConfirmInput.value) {
    elements.authError.textContent = "Passwords do not match.";
    elements.authError.hidden = false;
    return;
  }

  elements.authSubmitButton.disabled = true;
  try {
    const endpoint = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const payload = await fetchJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    applyAccount(payload.account, payload.token, null);
    elements.authForm.reset();
    hideAuthGate();
    setMenuOpen(true);
    renderTables(state.tables);
    updateSeatSummary(getMe());
    updateActionState();
    await refreshTables();
    logLine(`Signed in as ${payload.account.username}`);
  } catch (error) {
    elements.authError.textContent = error.message;
    elements.authError.hidden = false;
  } finally {
    elements.authSubmitButton.disabled = false;
  }
}

async function handleLogout() {
  if (state.joined) {
    try {
      await handleLeave();
    } catch {
      // Best-effort: still log out locally even if the leave call fails.
    }
  }

  const token = state.account?.token;
  if (token) {
    fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }

  clearStoredAuth();
  state.authenticated = false;
  state.account = null;
  state.joined = false;
  state.lastIdentity = null;
  state.currentState = null;
  clearTableSessionBaseline();
  updateAccountLabel();
  refreshAdminVisibility();
  renderState(defaultState());
  syncResponsiveShell();
  showAuthGate();
  logLine("Signed out");
}

async function handleJoinTable(tableId) {
  if (!state.authenticated || !state.account) {
    return;
  }

  const identity = getIdentityForTable(tableId);

  try {
    await joinWithIdentity(identity);
  } catch (error) {
    logLine(`Join failed: ${error.message}`);
    elements.actionHint.textContent = error.message;
  }
}

async function handleLeave() {
  try {
    await emitWithAck("blackjack:leave_table");
    state.joined = false;
    state.currentState = null;
    clearTableSessionBaseline();
    renderState(defaultState());
    syncResponsiveShell();
    logLine("Left table");
  } catch (error) {
    logLine(`Leave failed: ${error.message}`);
  }
}

async function handleAction(eventName, payload = {}) {
  if (!state.joined) {
    return;
  }

  try {
    const response = await emitWithAck(eventName, payload);
    if (response.state) {
      renderState(response.state);
    }
    logLine(`Sent ${eventName}`, payload);
  } catch (error) {
    logLine(`${eventName} failed: ${error.message}`);
  }
}

let adminToken = loadStoredAdminToken();

function loadStoredAdminToken() {
  try {
    return window.localStorage.getItem(ADMIN_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

function saveStoredAdminToken(token) {
  try {
    if (token) {
      window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
}

function openAdminGate() {
  elements.adminLoginError.hidden = true;
  elements.adminPasswordInput.value = "";
  elements.adminGate.classList.add("is-visible");
}

function closeAdminGate() {
  elements.adminGate.classList.remove("is-visible");
}

function openAdminPanel() {
  elements.adminPanel.classList.add("is-visible");
  refreshAdminData();
}

function closeAdminPanel() {
  elements.adminPanel.classList.remove("is-visible");
}

async function adminFetchJson(url, options = {}) {
  const headers = { ...(options.headers ?? {}), "x-admin-token": adminToken ?? "" };
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => ({}));

  if (response.status === 401) {
    adminToken = null;
    saveStoredAdminToken(null);
    closeAdminPanel();
    throw new Error(payload.error ?? "Admin session expired.");
  }

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }

  return payload;
}

async function ensureAdminSession() {
  if (adminToken) {
    return;
  }

  if (!state.account?.token) {
    throw new Error("Sign in again before opening admin tools.");
  }

  const payload = await fetchJson("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: state.account.token }),
  });

  adminToken = payload.token;
  saveStoredAdminToken(adminToken);
}

async function handleAdminMenuButtonClick() {
  if (!isCurrentUserAdmin()) {
    window.alert("Admin role is required for this panel.");
    return;
  }

  try {
    await ensureAdminSession();
    openAdminPanel();
  } catch (error) {
    window.alert(`Unable to open admin panel: ${error.message}`);
  }
}

async function handleAdminLoginSubmit(event) {
  event.preventDefault();
  elements.adminLoginError.hidden = true;

  try {
    await ensureAdminSession();
    closeAdminGate();
    openAdminPanel();
  } catch (error) {
    elements.adminLoginError.textContent = error.message;
    elements.adminLoginError.hidden = false;
  }
}

async function handleAdminLogout() {
  try {
    await adminFetchJson("/api/admin/logout", { method: "POST" });
  } catch {
    // Best-effort: still clear the local token even if the request fails.
  }

  adminToken = null;
  saveStoredAdminToken(null);
  closeAdminPanel();
}

async function refreshAdminData() {
  elements.adminStatusLine.textContent = "Loading...";
  try {
    const payload = await adminFetchJson("/api/admin/overview");
    renderAdminAccounts(payload.accounts ?? []);
    renderAdminTables(payload.tables ?? []);
    elements.adminStatusLine.textContent = `Loaded ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    elements.adminStatusLine.textContent = `Failed to load: ${error.message}`;
  }
}

function renderAdminAccounts(accountsList) {
  elements.adminAccountsBody.innerHTML = "";

  if (accountsList.length === 0) {
    elements.adminAccountsBody.innerHTML = '<tr><td colspan="6" class="empty-state">No accounts yet.</td></tr>';
    return;
  }

  for (const account of accountsList) {
    const row = document.createElement("tr");
    const createdLabel = account.createdAt ? new Date(account.createdAt).toLocaleDateString() : "-";
    row.innerHTML = `
      <td>${escapeHtml(account.username)}</td>
      <td>${escapeHtml(account.displayName)}</td>
      <td>
        <select class="admin-role-select">
          <option value="user" ${account.role === "user" ? "selected" : ""}>User</option>
          <option value="admin" ${account.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
      </td>
      <td><input type="number" min="0" class="admin-balance-input" value="${escapeHtml(String(account.balance))}" /></td>
      <td>${escapeHtml(createdLabel)}</td>
      <td class="admin-row-actions">
        <button type="button" class="admin-save-balance">Save</button>
        <button type="button" class="admin-set-role">Set Role</button>
        <button type="button" class="admin-set-password">Set Password</button>
        <button type="button" class="admin-delete-account danger">Delete</button>
      </td>
    `;

    row.querySelector(".admin-save-balance").addEventListener("click", () => {
      handleAdminSaveBalance(account.username, row.querySelector(".admin-balance-input"));
    });
    row.querySelector(".admin-set-role").addEventListener("click", () => {
      handleAdminSetRole(account.username, row.querySelector(".admin-role-select").value);
    });
    row.querySelector(".admin-set-password").addEventListener("click", () => handleAdminSetPassword(account.username));
    row.querySelector(".admin-delete-account").addEventListener("click", () => handleAdminDeleteAccount(account.username));
    elements.adminAccountsBody.append(row);
  }
}

async function handleAdminSetRole(username, role) {
  try {
    await adminFetchJson(`/api/admin/accounts/${encodeURIComponent(username)}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    await refreshAdminData();
  } catch (error) {
    window.alert(`Failed to set role: ${error.message}`);
  }
}

async function handleAdminSaveBalance(username, input) {
  const value = Number.parseInt(input.value, 10);
  if (!Number.isFinite(value) || value < 0) {
    window.alert("Enter a valid non-negative balance.");
    return;
  }

  try {
    await adminFetchJson(`/api/admin/accounts/${encodeURIComponent(username)}/balance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ balance: value }),
    });
    await refreshAdminData();
  } catch (error) {
    window.alert(`Failed to update balance: ${error.message}`);
  }
}

async function handleAdminSetPassword(username) {
  const password = window.prompt(`New password for ${username} (min 6 characters):`);
  if (!password) {
    return;
  }

  try {
    await adminFetchJson(`/api/admin/accounts/${encodeURIComponent(username)}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    window.alert("Password updated.");
  } catch (error) {
    window.alert(`Failed to set password: ${error.message}`);
  }
}

async function handleAdminDeleteAccount(username) {
  if (!window.confirm(`Delete account "${username}"? This cannot be undone.`)) {
    return;
  }

  try {
    await adminFetchJson(`/api/admin/accounts/${encodeURIComponent(username)}`, { method: "DELETE" });
    await refreshAdminData();
  } catch (error) {
    window.alert(`Failed to delete account: ${error.message}`);
  }
}

async function handleAdminBulkAdjust() {
  const delta = Number.parseInt(elements.adminBulkDeltaInput.value, 10);
  if (!Number.isFinite(delta) || delta === 0) {
    window.alert("Enter a non-zero whole number amount to apply to every account.");
    return;
  }

  const verb = delta > 0 ? "add" : "remove";
  if (!window.confirm(`This will ${verb} ${Math.abs(delta)} ${delta > 0 ? "to" : "from"} every player's account balance. Continue?`)) {
    return;
  }

  try {
    const payload = await adminFetchJson("/api/admin/accounts/adjust-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta }),
    });
    elements.adminBulkDeltaInput.value = "";
    await refreshAdminData();
    window.alert(`Updated ${payload.count} account${payload.count === 1 ? "" : "s"}.`);
  } catch (error) {
    window.alert(`Failed to adjust balances: ${error.message}`);
  }
}

function renderAdminTables(tablesList) {
  elements.adminTablesList.innerHTML = "";

  if (tablesList.length === 0) {
    elements.adminTablesList.innerHTML = '<p class="empty-state">No active tables.</p>';
    return;
  }

  for (const table of tablesList) {
    const card = document.createElement("article");
    card.className = "admin-table-card";
    const players = Array.isArray(table.players) ? table.players : [];
    const playersHtml = players.length === 0
      ? '<p class="empty-state">No players seated.</p>'
      : `<table class="admin-table">
          <thead>
            <tr><th>Player</th><th>Balance</th><th>Bet</th><th>Status</th><th>Connection</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${players.map((player) => `
              <tr>
                <td>${escapeHtml(player.name)}</td>
                <td>${escapeHtml(String(player.balance))}</td>
                <td>${escapeHtml(String(player.currentBet ?? 0))}</td>
                <td>${escapeHtml(formatResult(player.status))}</td>
                <td>${player.isConnected ? "Online" : "Offline"}</td>
                <td><button type="button" class="admin-kick-player danger" data-table-id="${escapeHtml(table.tableId)}" data-player-id="${escapeHtml(player.id)}">Kick</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>`;

    card.innerHTML = `
      <div class="admin-table-card-head">
        <strong>${escapeHtml(table.tableId)}</strong>
        <span class="mini-badge">${escapeHtml(formatResult(table.phase))}</span>
        <button type="button" class="admin-reset-table danger" data-table-id="${escapeHtml(table.tableId)}">Reset Table</button>
      </div>
      ${playersHtml}
    `;

    elements.adminTablesList.append(card);
  }

  elements.adminTablesList.querySelectorAll(".admin-kick-player").forEach((button) => {
    button.addEventListener("click", () => handleAdminKickPlayer(button.dataset.tableId, button.dataset.playerId));
  });
  elements.adminTablesList.querySelectorAll(".admin-reset-table").forEach((button) => {
    button.addEventListener("click", () => handleAdminResetTable(button.dataset.tableId));
  });
}

async function handleAdminKickPlayer(tableId, playerId) {
  if (!window.confirm(`Kick ${playerId} from ${tableId}?`)) {
    return;
  }

  try {
    await adminFetchJson(`/api/admin/tables/${encodeURIComponent(tableId)}/kick/${encodeURIComponent(playerId)}`, { method: "POST" });
    await refreshAdminData();
  } catch (error) {
    window.alert(`Failed to kick player: ${error.message}`);
  }
}

async function handleAdminResetTable(tableId) {
  if (!window.confirm(`Reset table ${tableId}? This removes every seated player.`)) {
    return;
  }

  try {
    await adminFetchJson(`/api/admin/tables/${encodeURIComponent(tableId)}/reset`, { method: "POST" });
    await refreshAdminData();
  } catch (error) {
    window.alert(`Failed to reset table: ${error.message}`);
  }
}

elements.authForm.addEventListener("submit", handleAuthSubmit);
elements.authTabLogin.addEventListener("click", () => setAuthMode("login"));
elements.authTabRegister.addEventListener("click", () => setAuthMode("register"));
elements.logoutButton.addEventListener("click", handleLogout);
elements.leaveButton.addEventListener("click", handleLeave);
elements.placeBetButton.addEventListener("click", () => handleAction("blackjack:place_bet", { amount: Number.parseInt(elements.betInput.value, 10) }));
elements.hitButton.addEventListener("click", () => handleAction("blackjack:hit"));
elements.standButton.addEventListener("click", () => handleAction("blackjack:stand"));
elements.splitButton.addEventListener("click", () => handleAction("blackjack:split"));
elements.doubleDownButton.addEventListener("click", () => handleAction("blackjack:double_down"));
elements.insuranceButton.addEventListener("click", () => handleAction("blackjack:take_insurance"));
elements.declineInsuranceButton.addEventListener("click", () => handleAction("blackjack:decline_insurance"));
elements.surrenderButton.addEventListener("click", () => handleAction("blackjack:surrender"));
elements.quickTablesGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-table-id]");
  if (!button) {
    return;
  }

  const tableId = button.dataset.tableId;
  if (!tableId) {
    return;
  }

  try {
    await handleJoinTable(tableId);
  } catch (error) {
    logLine(`Quick join failed: ${error.message}`);
  }
});

elements.betInput.addEventListener("input", updateActionState);
elements.betInput.addEventListener("input", updateBetBalanceLabel);

elements.menuToggleButton.addEventListener("click", () => {
  setMenuOpen(!elements.sideMenu.classList.contains("is-open"));
});
elements.menuCloseButton.addEventListener("click", () => setMenuOpen(false));
elements.menuBackdrop.addEventListener("click", () => setMenuOpen(false));

elements.adminMenuButton.addEventListener("click", handleAdminMenuButtonClick);
elements.adminLoginForm.addEventListener("submit", handleAdminLoginSubmit);
elements.adminGateCloseButton.addEventListener("click", closeAdminGate);
elements.adminCloseButton.addEventListener("click", closeAdminPanel);
elements.adminRefreshButton.addEventListener("click", refreshAdminData);
elements.adminLogoutButton.addEventListener("click", handleAdminLogout);
elements.adminBulkApplyButton.addEventListener("click", handleAdminBulkAdjust);

socket.on("connect", async () => {
  setConnection(true);
  logLine("Socket connected", { socketId: socket.id });
  await refreshTables();
});

socket.on("disconnect", (reason) => {
  setConnection(false);
  state.joined = false;
  state.currentState = null;
  clearTableSessionBaseline();
  renderState(defaultState());
  syncResponsiveShell();
  if (state.authenticated) {
    setMenuOpen(true);
  }
  updateActionState();
  updateSeatSummary(getMe());
  logLine(`Socket disconnected: ${reason}`);
});

socket.on("blackjack:state", (nextState) => {
  renderState(nextState);
});

socket.on("blackjack:tables_summary", (payload) => {
  state.tables = Array.isArray(payload?.tables) ? payload.tables : state.tables;
  if (!state.currentState?.tableId) {
    renderTables(state.tables);
  }
});

socket.on("blackjack:error", (payload) => {
  logLine(`Server error: ${payload.message}`);
});

socket.on("blackjack:kicked", (payload) => {
  state.joined = false;
  state.currentState = null;
  clearTableSessionBaseline();
  renderState(defaultState());
  syncResponsiveShell();
  elements.actionHint.textContent = "You were removed from the table by an administrator.";
  logLine("Removed by administrator", payload);
});

socket.on("blackjack:table_closed", (payload) => {
  state.joined = false;
  state.currentState = null;
  if (payload?.tableId) {
    state.tables = state.tables.filter((table) => table.tableId !== payload.tableId);
    renderTables(state.tables);
  }
  renderState(defaultState());
  syncResponsiveShell();
  logLine("Table closed", payload);
});

socket.on("blackjack:session_replaced", (payload) => {
  state.joined = false;
  renderState(defaultState());
  syncResponsiveShell();
  logLine("Session replaced", payload);
});

async function bootstrap() {
  setAuthMode("login");
  renderTables([]);
  renderState(defaultState());
  setConnection(false);
  syncResponsiveShell();
  updateBetBalanceLabel();
  refreshAdminVisibility();

  const stored = loadStoredAuth();
  if (!stored?.token) {
    showAuthGate();
    await refreshTables();
    return;
  }

  try {
    const payload = await fetchJson(`/api/auth/session?token=${encodeURIComponent(stored.token)}`, {
      headers: { Accept: "application/json" },
    });
    applyAccount(payload.account, stored.token, stored.lastTableId ?? null);
    hideAuthGate();
    setMenuOpen(!isMobileLayout());
    syncResponsiveShell();
    await refreshTables();
    updateSeatSummary(getMe());
    updateActionState();

  } catch {
    clearStoredAuth();
    state.account = null;
    refreshAdminVisibility();
    showAuthGate();
    await refreshTables();
  }
}

window.addEventListener("resize", () => {
  syncResponsiveShell();
});

bootstrap();