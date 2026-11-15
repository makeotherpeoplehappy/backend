import type { Deps, Env } from './env';
import { sendEmail } from './email';
import { sha256Hex } from './http';

export interface ErrorReport {
  where: string;
  error: unknown;
  /** Anything that helps act on it. Never tokens or keys. */
  details?: Record<string, unknown>;
}

// The same error is emailed at most once an hour so an outage does not
// flood the inbox.
const THROTTLE_SECONDS = 3600;

/** Emails Mickey about an error. Never throws. */
export async function reportError(env: Env, deps: Deps, report: ErrorReport): Promise<void> {
  try {
    const err = report.error instanceof Error ? report.error : new Error(String(report.error));
    // Always in the Webflow Cloud runtime log, even when the email is throttled or fails.
    console.error(`[error] ${report.where}: ${err.name}: ${err.message}`, JSON.stringify(report.details || {}).slice(0, 1000));
    const signature = await sha256Hex(`${report.where}|${err.name}|${err.message.replace(/\d+/g, '#').slice(0, 200)}`);
    const throttleKey = `errmail:${signature.slice(0, 32)}`;
    if (env.CACHE && (await env.CACHE.get(throttleKey))) return;
    if (env.CACHE) await env.CACHE.put(throttleKey, '1', { expirationTtl: THROTTLE_SECONDS });
    if (!env.RESEND_API_KEY || !env.ERROR_EMAIL_TO || !env.EMAIL_FROM) {
      console.error('[error report, email not configured]', report.where, err);
      return;
    }
    const lines = [
      `Where: ${report.where}`,
      `Environment: ${env.ENVIRONMENT || 'unknown'}`,
      `When (UTC): ${deps.now().toISOString()}`,
      `Error: ${err.name}: ${err.message}`,
      '',
      'Details:',
      JSON.stringify(report.details || {}, null, 2),
      '',
      'Stack:',
      (err.stack || '(none)').split('\n').slice(0, 15).join('\n'),
      '',
      'The same error will not be emailed again for an hour.',
    ];
    await sendEmail(env, deps, {
      to: env.ERROR_EMAIL_TO,
      subject: `[Backend ${env.ENVIRONMENT || ''}] ${report.where}: ${err.message.slice(0, 80)}`,
      text: lines.join('\n'),
    });
  } catch (e) {
    console.error('[error report failed]', e);
  }
}
