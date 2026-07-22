const crypto = require('crypto');
const { sendMail } = require('./mailer');

const CODE_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;

// Generates a 6-digit code, stores its hash (never the raw code), emails
// the raw code to the user, and invalidates any previous unused codes for
// that user so only the most recent one can ever succeed.
// `dbOrClient` can be the plain pool or a transaction client.
async function issueVerificationCode(dbOrClient, user) {
  await dbOrClient.query(
    `UPDATE email_verification_codes SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );

  const code = crypto.randomInt(100000, 1000000).toString(); // always 6 digits
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  await dbOrClient.query(
    `INSERT INTO email_verification_codes (user_id, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, codeHash, expiresAt]
  );

  await sendMail({
    to: user.email,
    subject: 'Your Wardline verification code',
    text: `Hi ${user.full_name},\n\nYour verification code is: ${code}\n\nThis code expires in ${CODE_EXPIRY_MINUTES} minutes. Enter it on the sign-up page to activate your account.\n\nIf you didn't request this, you can ignore this email.`,
  });
}

// Checks a submitted code against the most recent unused, non-expired code
// for that user. Returns { ok: true } or { ok: false, error: '...' }.
// Mutates attempts/used_at as a side effect (this is deliberately not a
// pure function — it needs to record attempts even on failure).
async function checkVerificationCode(dbOrClient, userId, submittedCode) {
  const result = await dbOrClient.query(
    `SELECT * FROM email_verification_codes
     WHERE user_id = $1 AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId]
  );
  const record = result.rows[0];

  if (!record) {
    return { ok: false, error: 'No verification code found. Please request a new one.' };
  }
  if (new Date(record.expires_at) < new Date()) {
    return { ok: false, error: 'This code has expired. Please request a new one.' };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: 'Too many incorrect attempts. Please request a new code.' };
  }

  const submittedHash = crypto.createHash('sha256').update(String(submittedCode)).digest('hex');
  if (submittedHash !== record.code_hash) {
    await dbOrClient.query(
      `UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = $1`,
      [record.id]
    );
    const remaining = MAX_ATTEMPTS - (record.attempts + 1);
    return {
      ok: false,
      error: remaining > 0
        ? `Incorrect code. ${remaining} attempt(s) remaining before you'll need a new one.`
        : 'Incorrect code. Please request a new one.',
    };
  }

  await dbOrClient.query(`UPDATE email_verification_codes SET used_at = NOW() WHERE id = $1`, [record.id]);
  return { ok: true };
}

module.exports = { issueVerificationCode, checkVerificationCode };
