const nodemailer = require('nodemailer');

let transporter = null;
let usingRealSmtp = false;

function getTransporter() {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    usingRealSmtp = true;
  } else {
    // No SMTP configured — fall back to a transport that just logs the
    // email instead of sending it. This means invites, password resets,
    // etc. all still work end-to-end in dev/testing without any mail
    // provider; the "email" just shows up in the server console.
    transporter = {
      sendMail: async (opts) => {
        console.log('\n--- EMAIL (SMTP not configured — logged instead of sent) ---');
        console.log(`To: ${opts.to}`);
        console.log(`Subject: ${opts.subject}`);
        console.log(opts.text || opts.html);
        console.log('--- end email ---\n');
        return { messageId: 'console-log' };
      },
    };
    usingRealSmtp = false;
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  try {
    const t = getTransporter();
    await t.sendMail({ from: process.env.SMTP_FROM || 'Wardline <no-reply@wardline.local>', to, subject, text, html });
    return true;
  } catch (err) {
    // Email failures should never break the calling request (e.g. don't
    // fail a patient invite just because the mail server hiccuped) — log
    // and move on. The caller can still show the info on-screen as a fallback.
    console.error('Failed to send email:', err.message);
    return false;
  }
}

// SMS is stubbed out on purpose — sending real SMS needs a paid third-party
// provider (Twilio, Vonage, Africa's Talking, etc.) with its own account and
// API keys, which isn't something that can be wired up without you signing
// up for one. This function exists so the calling code (e.g. appointment
// reminders) already has the right shape; swap the body for a real provider
// call whenever you're ready, and every call site using it will just start
// working. Nothing today depends on this actually sending anything.
async function sendSms({ to, message }) {
  console.log(`\n--- SMS (not configured — no provider wired up) ---`);
  console.log(`To: ${to}`);
  console.log(message);
  console.log('--- end SMS (not actually sent) ---\n');
  return false;
}

module.exports = { sendMail, sendSms, isEmailConfigured: () => usingRealSmtp };
