import { db } from './src/db';
import { runAutoMatching } from './src/matching/matching.service';
import { parseSiren } from './src/matching/siren';

async function main() {
  const siren = parseSiren(process.argv[2] ?? '900997767');
  const { considered, matched, unmatched, suggested, toReview } = await runAutoMatching(siren);

  const total = matched.reference + matched.supplier;
  console.log(`Company ${siren}: matched ${total} of ${considered} eligible transactions`);
  console.log('Matched on:', matched);
  console.log('Left unmatched because:', unmatched);
  console.log(`Suggested for a one-click confirmation: ${suggested}`);
  console.log(`Flagged for review, the reference names a settled invoice: ${toReview.length}`);
  console.table(toReview);
  await db.end();
}

main().catch(async (e) => {
  console.error(e);
  await db.end();
  process.exit(1);
});
