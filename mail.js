// Pengirim email. Dengan SMTP_HOST terisi memakai SMTP (nodemailer, dimuat saat dibutuhkan);
// tanpa itu email hanya dicetak ke konsol (cocok untuk pengembangan, JANGAN untuk produksi).
export async function createMailer(env = process.env, log = console) {
  if (!env.SMTP_HOST) {
    return { kind: 'console', async send({ to, subject, text }) { log.log(`\n[EMAIL → ${to}] ${subject}\n${text}\n`); } };
  }
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(env.SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port, secure: port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  const from = env.MAIL_FROM || env.SMTP_USER || 'stok-gudang@localhost';
  return { kind: 'smtp', send: ({ to, subject, text }) => transport.sendMail({ from, to, subject, text }) };
}
