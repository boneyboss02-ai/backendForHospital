// Generates a simple human-readable patient code, e.g. PT-2026-0001
// `client` must be a client from an open transaction (BEGIN already called)
// — this takes a transaction-scoped advisory lock so two concurrent callers
// (e.g. two patients self-registering at the same moment) can't both read
// the same COUNT and generate the same code. The lock auto-releases at
// COMMIT/ROLLBACK.
async function generatePatientCode(client) {
  const year = new Date().getFullYear();
  // Lock key is scoped to the year so it doesn't serialize registrations
  // across different years unnecessarily.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`patient_code_${year}`]);

  const result = await client.query(
    `SELECT COUNT(*) FROM patients WHERE patient_code LIKE $1`,
    [`PT-${year}-%`]
  );
  const count = parseInt(result.rows[0].count, 10) + 1;
  return `PT-${year}-${String(count).padStart(4, '0')}`;
}

module.exports = { generatePatientCode };
