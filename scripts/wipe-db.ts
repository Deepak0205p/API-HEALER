/**
 * One-off: wipe ALL demo/dummy data from the API-HEALER database.
 * Leaves a pristine, user-owned tool: zero contracts, zero events.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const events = await db.driftEvent.deleteMany({});
  const fps = await db.fingerprint.deleteMany({});
  const prs = await db.pullRequest.deleteMany({});
  const jobs = await db.jobRun.deleteMany({});
  const contracts = await db.contract.deleteMany({});
  console.log(
    `wiped: ${events.count} events, ${fps.count} fingerprints, ${prs.count} PRs, ${jobs.count} jobs, ${contracts.count} contracts`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
