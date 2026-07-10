import { pool } from '/workspaces/RealEnhance-v2/server/src/db/index.ts';

async function main() {
  const ids = [
    'job_42658384-e988-4aa6-b421-2faf2132343f',
    'job_6f2a89e3-d439-49b0-8762-0855e1a7e76d',
  ];

  const q = `
    select
      job_id,
      public_url,
      remote_original_url,
      original_s3_key,
      enhanced_s3_key,
      thumb_s3_key,
      trace_id,
      completion_type,
      created_at
    from enhanced_images
    where job_id = any($1::text[])
    order by created_at desc
  `;

  const r = await pool.query(q, [ids]);
  console.log(JSON.stringify(r.rows, null, 2));
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
