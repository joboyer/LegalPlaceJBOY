import { db } from './src/db';
import { parseSiren, runAutoMatching } from './src/matcher';

async function main() {
  const siren = parseSiren(process.argv[2] ?? '900997767');
  const { considered, matched, unmatched } = await runAutoMatching(siren);

  const total = matched.reference + matched.supplier;
  console.log(`Company ${siren}: matched ${total} of ${considered} eligible transactions`);
  console.log('Matched on:', matched);
  console.log('Left unmatched because:', unmatched);
  await db.end();
}

main().catch(async (e) => {
  console.error(e);
  await db.end();
  process.exit(1);
});
