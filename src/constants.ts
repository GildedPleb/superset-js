/**
 * Centralized application constants for superset-js.
 *
 * Policy values (retention windows, etc.) live here so purge logic,
 * promotion logic, and acquisition filtering stay in sync.
 *
 * Import from here instead of duplicating magic numbers.
 */

// ============================================================================
// RETENTION & PROMOTION POLICY
// ============================================================================

/**
 * Pending repos are promoted to 'eligible' only if they received a push
 * within this many days. They are also purged during retention if they
 * remain pending beyond this window.
 */
export const PENDING_RETENTION_DAYS = 30;

/**
 * How long eligible/good/no-config/gone repositories (and all their
 * associated config/normalized data) are retained before being purged.
 */
export const ELIGIBLE_RETENTION_DAYS = 365;

// ============================================================================
// TIME CONVERSION HELPERS
// ============================================================================

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const THIRTY_MIN_MS = 30 * 60 * 1000;
export const FIVE_MINUTES_MS = 5 * 60 * 1000;

// ============================================================================
// DISCOVERY STAGE
// ============================================================================

export const INIT_LOOKBACK_HOURS = 72;
export const GRACE_PERIOD_HOURS = 3;
export const MAX_MISSING_HOURS = 24;

/**
 * Acquisition only considers repos whose last_pushed timestamp falls
 * within this window. Aligned with ELIGIBLE_RETENTION_DAYS so we don't
 * waste work on repos that retention will soon delete anyway.
 */
export const PUSH_WINDOW_MS = ELIGIBLE_RETENTION_DAYS * ONE_DAY_MS;
