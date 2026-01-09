import { MailService } from '@sendgrid/mail';

if (!process.env.SENDGRID_API_KEY) {
  console.warn("SENDGRID_API_KEY environment variable not set - email notifications disabled");
}

const mailService = new MailService();
if (process.env.SENDGRID_API_KEY) {
  mailService.setApiKey(process.env.SENDGRID_API_KEY);
}

interface EmailParams {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    type: string;
  }>;
}

export async function sendEmail(params: EmailParams): Promise<boolean> {
  if (!process.env.SENDGRID_API_KEY) {
    console.log("Email notification skipped - no API key configured");
    return false;
  }
  
  if (!params.to || !params.from) {
    console.error('Email send failed: missing required to or from fields');
    return false;
  }
  
  try {
    const emailData: any = {
      to: params.to,
      from: params.from,
      subject: params.subject,
    };
    
    if (params.text) emailData.text = params.text;
    if (params.html) emailData.html = params.html;
    if (params.attachments) emailData.attachments = params.attachments;
    
    await mailService.send(emailData);
    return true;
  } catch (error) {
    console.error('SendGrid email error:', error);
    return false;
  }
}

export async function sendBatchCompleteEmail(opts: {
  userEmail: string;
  results: Array<{ filename: string; ok: boolean; error?: string }>;
  zipBuffer?: Buffer;
}): Promise<boolean> {
  const { userEmail, results, zipBuffer } = opts;

  const successCount = results.filter(r => r.ok).length;
  const failCount = results.filter(r => !r.ok).length;

  let subject = `Batch Processing Complete - ${successCount}/${results.length} images processed`;

  let text = `Your batch image processing is complete!\n\n`;
  text += `✅ Successfully processed: ${successCount} images\n`;
  if (failCount > 0) {
    text += `❌ Failed: ${failCount} images\n\n`;
    text += `Failed images:\n`;
    results.filter(r => !r.ok).forEach(r => {
      text += `- ${r.filename}: ${r.error}\n`;
    });
  }

  if (zipBuffer && successCount > 0) {
    text += `\nYour processed images are attached as a ZIP file.\n`;
  }

  const attachments = zipBuffer ? [{
    filename: 'processed-images.zip',
    content: zipBuffer,
    type: 'application/zip'
  }] : undefined;

  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@polishmypic.com';

  return sendEmail({
    to: userEmail,
    from: fromEmail,
    subject,
    text,
    attachments
  });
}

/**
 * Send an invitation email to a new team member
 */
export async function sendInvitationEmail(params: {
  toEmail: string;
  inviterName: string;
  agencyName: string;
  role: string;
  inviteToken: string;
  acceptUrl: string;
}): Promise<{ ok: boolean; error?: string }> {
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@polishmypic.com';

  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[EMAIL] SENDGRID_API_KEY not set, invitation email not sent');
    return { ok: false, error: 'SendGrid not configured' };
  }

  const { toEmail, inviterName, agencyName, role, acceptUrl } = params;

  const subject = `You've been invited to join ${agencyName} on RealEnhance`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">You've Been Invited!</h2>

      <p>Hi there,</p>

      <p><strong>${inviterName}</strong> has invited you to join <strong>${agencyName}</strong> on RealEnhance as a <strong>${role}</strong>.</p>

      <p>RealEnhance helps real estate teams quickly turn everyday listing photos into polished, professional-quality images that attract buyers.</p>

      <div style="margin: 30px 0;">
        <a href="${acceptUrl}"
           style="background-color: #2563eb; color: white; padding: 12px 24px;
                  text-decoration: none; border-radius: 6px; display: inline-block;">
          Accept Invitation
        </a>
      </div>

      <p style="color: #6b7280; font-size: 14px;">
        This invitation will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.
      </p>

      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />

      <p style="color: #9ca3af; font-size: 12px;">
        RealEnhance — Elevate your property photos<br/>
        If the button above doesn't work, copy and paste this link:<br/>
        <a href="${acceptUrl}" style="color: #2563eb;">${acceptUrl}</a>
      </p>
    </div>
  `;

  const textContent = `
You've Been Invited!

${inviterName} has invited you to join ${agencyName} on RealEnhance as a ${role}.

RealEnhance helps real estate teams quickly turn everyday listing photos into polished, professional-quality images that attract buyers.

Accept your invitation by visiting:
${acceptUrl}

This invitation will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.

---
RealEnhance — Elevate your property photos
  `.trim();

  const success = await sendEmail({
    to: toEmail,
    from: fromEmail,
    subject,
    text: textContent,
    html: htmlContent,
  });

  return { ok: success, error: success ? undefined : 'Email sending failed' };
}