import test from "node:test";
import assert from "node:assert/strict";

function shouldIgnoreStaleState(currentState, nextState) {
  if (!nextState || !currentState) {
    return false;
  }

  if (!nextState.tableId || nextState.tableId !== currentState.tableId) {
    return false;
  }

  const incomingVersion = Number.parseInt(nextState.stateVersion, 10);
  const currentVersion = Number.parseInt(currentState.stateVersion, 10);
  if (!Number.isFinite(incomingVersion) || !Number.isFinite(currentVersion)) {
    return false;
  }

  return incomingVersion < currentVersion;
}

test("realtime UI should ignore stale same-table state versions", () => {
  const current = { tableId: "practice", stateVersion: 12 };
  const stale = { tableId: "practice", stateVersion: 11 };
  const fresh = { tableId: "practice", stateVersion: 13 };

  assert.equal(shouldIgnoreStaleState(current, stale), true);
  assert.equal(shouldIgnoreStaleState(current, fresh), false);
});

test("realtime UI should not reject updates for a different table", () => {
  const current = { tableId: "practice", stateVersion: 12 };
  const otherTable = { tableId: "vip", stateVersion: 1 };

  assert.equal(shouldIgnoreStaleState(current, otherTable), false);
});
