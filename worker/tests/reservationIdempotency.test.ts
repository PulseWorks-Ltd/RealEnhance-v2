/**
 * Billing idempotency simulation test
 *
 * Validates that finalizeReservationFromWorker:
 *   1. Exits immediately (no DB mutations) when reservation_status = 'consumed'
 *      — simulates crash-recovery path calling after normal completion
 *   2. Exits immediately when reservation_status = 'released'
 *      — simulates double-failure path
 *   3. Proceeds normally when reservation_status = 'partially_released'
 *      — stage2-only retry must be able to re-consume the refunded stage2 portion
 */

// ── Mock @realenhance/shared/usage/imageBundles ────────────────────────────
jest.mock("@realenhance/shared/usage/imageBundles", () => ({
  consumeBundleImages: jest.fn().mockResolvedValue(undefined),
  getTotalBundleRemaining: jest.fn().mockResolvedValue(0),
}));

// ── Mock ../src/db/index — we control withTransaction ─────────────────────
// This mock makes withTransaction call the callback synchronously with a
// mock DB client, letting us inspect every query the function issues.
let __mockClient: { query: jest.Mock };

jest.mock("../src/db/index", () => ({
  withTransaction: jest.fn(async (fn: (c: any) => Promise<any>) => {
    return fn(__mockClient);
  }),
}));

import { finalizeReservationFromWorker } from "../src/utils/reservations";
import { withTransaction } from "../src/db/index";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a mock Postgres client whose query() returns controlled row sets. */
function buildMockClient(overrides: {
  reservationRow?: Record<string, unknown>;
}): jest.Mock {
  const row = overrides.reservationRow ?? { reservation_status: "pending" };

  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM job_reservations")) {
      return { rowCount: 1, rows: [row] };
    }
    if (sql.includes("FROM agency_month_usage")) {
      return {
        rowCount: 1,
        rows: [{ included_limit: 10, included_used: 0, addon_used: 0 }],
      };
    }
    if (sql.includes("FROM agency_accounts")) {
      return {
        rowCount: 1,
        rows: [{ addon_images_balance: 0 }],
      };
    }
    // All UPDATE / INSERT statements — default to success
    return { rowCount: 1, rows: [] };
  });

  return query;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("finalizeReservationFromWorker — idempotency guard", () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // ── Test 1 ────────────────────────────────────────────────────────────────
  it("skips all mutations when reservation_status = 'consumed' (crash-recovery path)", async () => {
    __mockClient = {
      query: buildMockClient({ reservationRow: { reservation_status: "consumed" } }),
    };

    await finalizeReservationFromWorker({
      jobId: "job_test_consumed",
      stage12Success: false, // crash-recovery would send false/false
      stage2Success: false,
    });

    // ① Guard log must be emitted
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[RESERVATION\] Already finalized \(consumed\) for job job_test_consumed — skipping duplicate call/
      )
    );

    // ② Only the initial SELECT should have been called — zero UPDATEs
    const queries: string[] = __mockClient.query.mock.calls.map((c) => c[0] as string);
    const updates = queries.filter((q) => q.toLowerCase().startsWith("update"));
    expect(updates).toHaveLength(0);

    // ③ withTransaction was entered (guard fires from inside the transaction)
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  it("skips all mutations when reservation_status = 'released' (double-failure path)", async () => {
    __mockClient = {
      query: buildMockClient({ reservationRow: { reservation_status: "released" } }),
    };

    await finalizeReservationFromWorker({
      jobId: "job_test_released",
      stage12Success: false,
      stage2Success: false,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[RESERVATION\] Already finalized \(released\) for job job_test_released — skipping duplicate call/
      )
    );

    const queries: string[] = __mockClient.query.mock.calls.map((c) => c[0] as string);
    const updates = queries.filter((q) => q.toLowerCase().startsWith("update"));
    expect(updates).toHaveLength(0);
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  it("proceeds (does NOT short-circuit) when reservation_status = 'partially_released'", async () => {
    __mockClient = {
      query: buildMockClient({
        reservationRow: {
          reservation_status: "partially_released",
          agency_id: "agency_1",
          yyyymm: "202602",
          reserved_images: 1,
          reserved_from_included: 1,
          reserved_from_addon: 0,
          requested_stage12: true,
          requested_stage2: true,
          stage12_from_included: 1,
          stage12_from_addon: 0,
          stage2_from_included: 0,
          stage2_from_addon: 0,
        },
      }),
    };

    await finalizeReservationFromWorker({
      jobId: "job_test_partial",
      stage12Success: true, // stage2-only retry: stage1 already done
      stage2Success: true,  // stage2 succeeded this time
    });

    // Guard did NOT fire
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/Already finalized/)
    );

    // At least one UPDATE must have been issued (stage consumption)
    const queries: string[] = __mockClient.query.mock.calls.map((c) => c[0] as string);
    const updates = queries.filter((q) => q.toLowerCase().startsWith("update"));
    expect(updates.length).toBeGreaterThan(0);
  });

  // ── Test 4 ─  Explicit crash-recovery simulation ─────────────────────────
  it("simulates: normal completion then crash-recovery — second call sees 'consumed' and no pool mutation", async () => {
    // Simulate first pass: reservation is in initial state → will be marked 'consumed'
    // We'll use a stateful mock that changes status after first SELECT
    let callCount = 0;
    const statefulQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM job_reservations")) {
        callCount++;
        // First pass (normal completion): reservation is pending
        // After the function finishes it would be 'consumed' — we simulate this
        // by tracking calls. But since our mock is synchronous and transactional,
        // just model both states separately in two independent calls.
        return { rowCount: 1, rows: [{ reservation_status: "pending", agency_id: "agency_1", yyyymm: "202602", reserved_images: 1, reserved_from_included: 1, reserved_from_addon: 0, requested_stage12: true, requested_stage2: false, stage12_from_included: 1, stage12_from_addon: 0, stage2_from_included: 0, stage2_from_addon: 0 }] };
      }
      if (sql.includes("FROM agency_month_usage")) {
        return { rowCount: 1, rows: [{ included_limit: 10, included_used: 2, addon_used: 0 }] };
      }
      if (sql.includes("FROM agency_accounts")) {
        return { rowCount: 1, rows: [{ addon_images_balance: 0 }] };
      }
      return { rowCount: 1, rows: [] };
    });
    __mockClient = { query: statefulQuery };

    // ── PASS 1: normal completion path ───────────────────────────────────────
    await finalizeReservationFromWorker({
      jobId: "job_crash_sim",
      stage12Success: true,
      stage2Success: false,
    });

    const pass1Updates = statefulQuery.mock.calls
      .filter((c) => (c[0] as string).toLowerCase().startsWith("update"))
      .map((c) => c[0] as string);

    expect(pass1Updates.length).toBeGreaterThan(0); // consumed stage12

    // ── Now upgrade status to 'consumed' for the recovery path ───────────────
    jest.clearAllMocks();
    consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    const recoveryQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM job_reservations")) {
        // Recovery path sees 'consumed' — the guard should fire
        return { rowCount: 1, rows: [{ reservation_status: "consumed" }] };
      }
      return { rowCount: 1, rows: [] };
    });
    __mockClient = { query: recoveryQuery };

    // ── PASS 2: crash-recovery path ──────────────────────────────────────────
    await finalizeReservationFromWorker({
      jobId: "job_crash_sim",
      stage12Success: false,
      stage2Success: false,
    });

    // Guard fires
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[RESERVATION\] Already finalized \(consumed\) for job job_crash_sim/
      )
    );

    // No pool mutations in recovery pass
    const pass2Updates = recoveryQuery.mock.calls
      .filter((c) => (c[0] as string).toLowerCase().startsWith("update"))
      .map((c) => c[0] as string);

    expect(pass2Updates).toHaveLength(0);
  });
});
