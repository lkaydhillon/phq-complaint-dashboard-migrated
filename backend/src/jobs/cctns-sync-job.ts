import { prisma } from '../config/database.js';
import { fetchCctnsComplaints } from '../services/cctns.js';
import { clearCache } from '../utils/cache.js';
import {
  CctnsComplaintRow,
  normalizeComplaintRow,
  NormalizedCctnsComplaint,
} from '../services/cctns-normalize.js';
import { enrichWithMasterIds } from '../services/master-mapping.js';

const formatDateStr = (date: Date): string => {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

const processInBatches = async <T>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<void>
) => {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map((item) => processor(item)));
  }
};

const toNormalizedUnique = (rows: CctnsComplaintRow[]): NormalizedCctnsComplaint[] => {
  const byRegNum = new Map<string, NormalizedCctnsComplaint>();
  for (const row of rows) {
    const normalized = normalizeComplaintRow(row);
    if (!normalized) continue;
    byRegNum.set(normalized.complRegNum, normalized);
  }
  return Array.from(byRegNum.values());
};

interface CctnsSyncResult {
  timeFrom: string;
  timeTo: string;
  complaints: {
    fetched: number;
    upserted: number;
    errors: number;
  };
}

let isSyncing = false;

// Retry a DB operation up to `attempts` times with `delayMs` gap
const withRetry = async <T>(fn: () => Promise<T>, attempts = 3, delayMs = 5000): Promise<T> => {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        console.log(`[SYNC] DB not ready, retrying in ${delayMs / 1000}s... (attempt ${i + 1}/${attempts})`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
};

export const runCctnsSync = async (
  options: { fromDate?: string; toDate?: string; label?: string } = {}
): Promise<CctnsSyncResult | null> => {
  if (isSyncing) {
    console.log('[SYNC] Already syncing, skipping...');
    return null;
  }

  isSyncing = true;

  // Use provided dates or default to last 2 days (recent registrations)
  const endDate = new Date();
  const defaultStart = new Date();
  defaultStart.setDate(endDate.getDate() - 2);

  const timeFrom = options.fromDate ?? formatDateStr(defaultStart);
  const timeTo   = options.toDate   ?? formatDateStr(endDate);
  const label    = options.label    ?? 'background';

  console.log(`[SYNC] Starting ${label} CCTNS sync: ${timeFrom} → ${timeTo}`);

  const result: CctnsSyncResult = {
    timeFrom,
    timeTo,
    complaints: { fetched: 0, upserted: 0, errors: 0 },
  };

  let syncRun: { id: number };
  try {
    syncRun = await withRetry(() => prisma.syncRun.create({
      data: {
        kind: `cctns-${label}`,
        status: 'running',
        startedAt: new Date(),
      },
    }));
  } catch (err) {
    console.error('[SYNC] Could not connect to database after retries. Skipping sync.', err);
    isSyncing = false;
    return null;
  }

  try {
    const complaints = (await fetchCctnsComplaints(timeFrom, timeTo)) as CctnsComplaintRow[];
    result.complaints.fetched = complaints.length;
    const normalized = toNormalizedUnique(complaints);

    await processInBatches(normalized, 100, async (data) => {
      try {
        const mapped = await enrichWithMasterIds(data);
        await prisma.complaint.upsert({
          where: { complRegNum: data.complRegNum },
          update: mapped,
          create: mapped,
        });
        result.complaints.upserted++;
      } catch (error) {
        result.complaints.errors++;
        console.error('[SYNC] Error saving complaint:', error);
      }
    });

  } catch (error) {
    result.complaints.errors++;
    console.error(`[SYNC] Failed to sync complaints: ${error}`);
  } finally {
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: result.complaints.errors > 0 ? 'partial' : 'success',
        endedAt: new Date(),
        fetchedCount: result.complaints.fetched,
        upsertedCount: result.complaints.upserted,
        errorCount: result.complaints.errors,
      },
    }).catch(() => undefined);
    isSyncing = false;
  }

  return result;
};

/**
 * Run a full rolling sync in monthly chunks.
 * Instead of fetching a hardcoded 365 days, this queries the DB for the
 * oldest pending complaint and syncs from that date up to today.
 * This catches status changes on old complaints efficiently.
 */
export const runCctnsFullRollingSync = async (): Promise<void> => {
  const CHUNK_DAYS = 30;

  // Find the oldest pending complaint
  const oldestPending = await prisma.complaint.findFirst({
    where: { statusGroup: 'pending', complRegDt: { not: null } },
    orderBy: { complRegDt: 'asc' },
    select: { complRegDt: true },
  });

  const end = new Date();
  const start = new Date();

  if (oldestPending?.complRegDt) {
    start.setTime(oldestPending.complRegDt.getTime());
    // Add a 1-day buffer just to be safe
    start.setDate(start.getDate() - 1);
  } else {
    // Fallback to 30 days if no pending complaints exist
    start.setDate(end.getDate() - 30);
  }

  // Sanity check
  if (start > end) {
    start.setTime(end.getTime());
    start.setDate(start.getDate() - 1);
  }

  console.log(`[SYNC] Starting full rolling sync from oldest pending date: ${formatDateStr(start)} → ${formatDateStr(end)} in ${CHUNK_DAYS}-day chunks`);

  let chunkStart = new Date(start);
  let chunkIndex = 0;

  while (chunkStart < end) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkStart.getDate() + CHUNK_DAYS);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunkIndex++;
    // Wait for any in-progress sync to finish before each chunk
    while (isSyncing) {
      await new Promise(r => setTimeout(r, 5000));
    }

    await runCctnsSync({
      fromDate: formatDateStr(chunkStart),
      toDate:   formatDateStr(chunkEnd),
      label:    `rolling-chunk-${chunkIndex}`,
    });

    chunkStart.setDate(chunkStart.getDate() + CHUNK_DAYS + 1);

    // Small pause between chunks to avoid hammering the CCTNS API
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`[SYNC] Full rolling sync complete — ${chunkIndex} chunks processed`);
  clearCache(); // Bust dashboard cache so next load reflects newly synced data
};





let intervalHandle: NodeJS.Timeout | null = null;
let rollingIntervalHandle: NodeJS.Timeout | null = null;

export const startCctnsBackgroundSync = () => {
  if (intervalHandle) return;

  // Wait 15s before first recent sync — gives Neon DB time to wake from idle on cold start
  console.log('[SYNC] Server ready. First recent sync will begin in 15 seconds...');
  setTimeout(() => {
    runCctnsSync().catch((error) => console.error('[SYNC] Initial sync failed:', error));
  }, 15_000);

  // Wait 60s then fire the full rolling sync automatically on every startup.
  // This fixes the "permanent pending" backlog immediately after each deploy
  // without any manual curl/admin action required.
  console.log('[SYNC] Full rolling sync (oldest pending → today) will begin in 60 seconds...');
  setTimeout(() => {
    console.log('[SYNC] Starting startup full rolling sync...');
    runCctnsFullRollingSync().catch((error) => console.error('[SYNC] Startup rolling sync failed:', error));
  }, 60_000);

  // Every 4 hours: sync last 2 days (new registrations + recent status changes)
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  intervalHandle = setInterval(() => {
    runCctnsSync().catch((error) => console.error('[SYNC] Scheduled sync failed:', error));
  }, FOUR_HOURS_MS);

  // Every 24 hours: full rolling sync from oldest pending complaint to today.
  // This is the fix for "permanent pending" — a complaint registered months ago
  // that gets disposed today will be caught and updated by this daily job.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  rollingIntervalHandle = setInterval(() => {
    console.log('[SYNC] Starting daily full rolling sync...');
    runCctnsFullRollingSync().catch((error) => console.error('[SYNC] Rolling sync failed:', error));
  }, ONE_DAY_MS);
};
