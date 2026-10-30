/**
 * One-off: report row counts of every API-HEALER table (read-only).
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const [contracts, events, fps, prs, jobs] = await Promise.all([
    db.contract.findMany({ select: { name: true, endpoint: true } }),
    db.driftEvent.count(),
    db.fingerprint.count(),
    db.pullRequest.count(),
    db.jobRun.count(),
  ]);
  console.log(JSON.stringify({ contracts, eventCount: events, fingerprints: fps, prs, jobs }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
