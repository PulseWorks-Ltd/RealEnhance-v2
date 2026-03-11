import { MailService } from '@sendgrid/mail';

if (!process.env.SENDGRID_API_KEY) {
  console.warn("SENDGRID_API_KEY environment variable not set - email notifications disabled");
}

const mailService = new MailService();
if (process.env.SENDGRID_API_KEY) {
  mailService.setApiKey(process.env.SENDGRID_API_KEY);
}

// Check if dynamic templates are enabled
const USE_DYNAMIC_TEMPLATES = process.env.SENDGRID_USE_TEMPLATES === '1' || process.env.SENDGRID_USE_TEMPLATES === 'true';
const DYNAMIC_TEMPLATE_ID = process.env.SENDGRID_TEMPLATE_ID || '';

if (USE_DYNAMIC_TEMPLATES && !DYNAMIC_TEMPLATE_ID) {
  console.warn('[EMAIL] SENDGRID_USE_TEMPLATES is enabled but SENDGRID_TEMPLATE_ID is not set');
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

interface TemplateEmailParams {
  to: string;
  from: string;
  notificationType: 'invitation' | 'password_reset' | 'subscription_update' | 'bundle_purchase' | 'batch_complete';
  heading: string;
  greeting: string;
  bodyText: string;
  ctaText?: string;
  ctaUrl?: string;
  footerText?: string;
  additionalInfo?: string;
}

/**
 * Send email using SendGrid dynamic template
 * Template must be created in SendGrid dashboard with these dynamic fields:
 * - notification_type, heading, greeting, body_text, cta_text, cta_url, footer_text, additional_info
 */
export async function sendTemplateEmail(params: TemplateEmailParams): Promise<boolean> {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[EMAIL] Email notification skipped - no API key configured');
    return false;
  }

  if (!USE_DYNAMIC_TEMPLATES || !DYNAMIC_TEMPLATE_ID) {
    console.log('[EMAIL] Dynamic templates not configured, falling back to plain email');
    // Fallback: construct simple HTML email
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">${params.heading}</h2>
        <p>${params.greeting}</p>
        <p>${params.bodyText}</p>
        ${params.ctaUrl && params.ctaText ? `
          <div style="margin: 30px 0;">
            <a href="${params.ctaUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              ${params.ctaText}
            </a>
          </div>
        ` : ''}
        ${params.additionalInfo ? `<p style="color: #6b7280; font-size: 14px;">${params.additionalInfo}</p>` : ''}
        ${params.footerText ? `
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">${params.footerText}</p>
        ` : ''}
      </div>
    `;
    return sendEmail({
      to: params.to,
      from: params.from,
      subject: params.heading,
      html: htmlContent,
    });
  }

  if (!params.to || !params.from) {
    console.error('[EMAIL] Send failed: missing required to or from fields');
    return false;
  }

  try {
    await mailService.send({
      to: params.to,
      from: params.from,
      templateId: DYNAMIC_TEMPLATE_ID,
      dynamicTemplateData: {
        notification_type: params.notificationType,
        heading: params.heading,
        greeting: params.greeting,
        body_text: params.bodyText,
        cta_text: params.ctaText || '',
        cta_url: params.ctaUrl || '',
        footer_text: params.footerText || '',
        additional_info: params.additionalInfo || '',
      },
    });
    console.log(`[EMAIL] Template email sent to ${params.to} (type: ${params.notificationType})`);
    return true;
  } catch (error) {
    console.error('[EMAIL] SendGrid template email error:', error);
    return false;
  }
}

export async function sendBatchCompleteEmail(opts: {
  userEmail: string;
  results: Array<{ filename: string; ok: boolean; error?: string }>;
  zipBuffer?: Buffer;
}): Promise<boolean> {
  const { userEmail, results, zipBuffer } = opts;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@polishmypic.com';

  const successCount = results.filter(r => r.ok).length;
  const failCount = results.filter(r => !r.ok).length;

  // If using templates and no attachments, use template email
  if (USE_DYNAMIC_TEMPLATES && DYNAMIC_TEMPLATE_ID && !zipBuffer) {
    let bodyText = `Your batch image processing is complete!\n\n✅ Successfully processed: ${successCount} images`;
    
    let additionalInfo = '';
    if (failCount > 0) {
      additionalInfo = `❌ Failed: ${failCount} images\n\n`;
      additionalInfo += results.filter(r => !r.ok).map(r => `• ${r.filename}: ${r.error || 'Unknown error'}`).join('\n');
    }

    return sendTemplateEmail({
      to: userEmail,
      from: fromEmail,
      notificationType: 'batch_complete',
      heading: `Batch Processing Complete - ${successCount}/${results.length} images`,
      greeting: 'Your batch processing has finished!',
      bodyText,
      footerText: 'RealEnhance — Elevate your property photos',
      additionalInfo: additionalInfo || undefined,
    });
  }

  // Fallback to traditional email (with attachments or when templates disabled)
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

  // Use template email if configured
  if (USE_DYNAMIC_TEMPLATES && DYNAMIC_TEMPLATE_ID) {
    const success = await sendTemplateEmail({
      to: toEmail,
      from: fromEmail,
      notificationType: 'invitation',
      heading: `You've been invited to join ${agencyName}`,
      greeting: 'Hi there,',
      bodyText: `${inviterName} has invited you to join ${agencyName} on RealEnhance as a ${role}.\n\nRealEnhance helps real estate teams quickly turn everyday listing photos into polished, professional-quality images that attract buyers.`,
      ctaText: 'Accept Invitation',
      ctaUrl: acceptUrl,
      additionalInfo: 'This invitation will expire in 7 days. If you didn\'t expect this invitation, you can safely ignore this email.',
      footerText: `RealEnhance — Elevate your property photos\nIf the button above doesn't work, copy and paste this link: ${acceptUrl}`,
    });
    return { ok: success, error: success ? undefined : 'Email sending failed' };
  }

  // Fallback to traditional HTML email
  const success = await sendEmail({
    to: toEmail,
    from: fromEmail,
    subject,
    text: textContent,
    html: htmlContent,
  });

  return { ok: success, error: success ? undefined : 'Email sending failed' };
}

/**
 * Send a password reset email
 */
export async function sendPasswordResetEmail(params: {
  toEmail: string;
  resetLink: string;
  displayName?: string;
  ttlMinutes?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@polishmypic.com';

  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[EMAIL] SENDGRID_API_KEY not set, password reset email not sent');
    return { ok: false, error: 'SendGrid not configured' };
  }

  const { toEmail, resetLink, displayName, ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 30) } = params;

  const subject = "Reset your RealEnhance password";
  const friendlyName = displayName || toEmail;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Reset your password</h2>

      <p>Hi ${friendlyName},</p>

      <p>We received a request to reset your RealEnhance password. Click the button below to set a new password.</p>

      <div style="margin: 30px 0;">
        <a href="${resetLink}"
           style="background-color: #2563eb; color: white; padding: 12px 24px;
                  text-decoration: none; border-radius: 6px; display: inline-block;">
          Reset Password
        </a>
      </div>

      <p style="color: #6b7280; font-size: 14px;">
        This link will expire in ${ttlMinutes} minutes. If you didn't request a reset, you can safely ignore this email.
      </p>

      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />

      <p style="color: #9ca3af; font-size: 12px;">
        RealEnhance — Elevate your property photos<br/>
        If the button above doesn't work, copy and paste this link:<br/>
        <a href="${resetLink}" style="color: #2563eb;">${resetLink}</a>
      </p>
    </div>
  `;

  const textContent = `
Reset your password

Hi ${friendlyName},

We received a request to reset your RealEnhance password. Use the link below to set a new password (expires in ${ttlMinutes} minutes):
${resetLink}

If you didn't request a reset, you can safely ignore this email.

---
RealEnhance — Elevate your property photos
  `.trim();

  // Use template email if configured
  if (USE_DYNAMIC_TEMPLATES && DYNAMIC_TEMPLATE_ID) {
    const success = await sendTemplateEmail({
      to: toEmail,
      from: fromEmail,
      notificationType: 'password_reset',
      heading: 'Reset your password',
      greeting: `Hi ${friendlyName},`,
      bodyText: 'We received a request to reset your RealEnhance password. Click the button below to set a new password.',
      ctaText: 'Reset Password',
      ctaUrl: resetLink,
      additionalInfo: `This link will expire in ${ttlMinutes} minutes. If you didn't request a reset, you can safely ignore this email.`,
      footerText: `RealEnhance — Elevate your property photos\nIf the button above doesn't work, copy and paste this link: ${resetLink}`,
    });
    return { ok: success, error: success ? undefined : 'Email sending failed' };
  }

  // Fallback to traditional HTML email
  const success = await sendEmail({
    to: toEmail,
    from: fromEmail,
    subject,
    text: textContent,
    html: htmlContent,
  });

  return { ok: success, error: success ? undefined : 'Email sending failed' };
}

/**
 * Send an email verification email
 */
export async function sendEmailVerificationEmail(params: {
  toEmail: string;
  verifyLink: string;
  displayName?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@polishmypic.com';

  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[EMAIL] SENDGRID_API_KEY not set, verification email not sent');
    return { ok: false, error: 'SendGrid not configured' };
  }

  const { toEmail, verifyLink, displayName } = params;
  const friendlyName = displayName || toEmail;
  const subject = 'Verify your email address';

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Verify your email address</h2>

      <p>Hi ${friendlyName},</p>

      <p>Thanks for signing up to RealEnhance. Please confirm your email address to enable downloads and billing.</p>

      <div style="margin: 30px 0;">
        <a href="${verifyLink}"
           style="background-color: #2563eb; color: white; padding: 12px 24px;
                  text-decoration: none; border-radius: 6px; display: inline-block;">
          Verify Email
        </a>
      </div>

      <p style="color: #6b7280; font-size: 14px;">
        This link expires in 24 hours. If you didn't create this account, you can ignore this email.
      </p>

      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />

      <p style="color: #9ca3af; font-size: 12px;">
        RealEnhance — Elevate your property photos<br/>
        If the button above doesn't work, copy and paste this link:<br/>
        <a href="${verifyLink}" style="color: #2563eb;">${verifyLink}</a>
      </p>
    </div>
  `;

  const textContent = `
Verify your email address

Hi ${friendlyName},

Thanks for signing up to RealEnhance. Please confirm your email address to enable downloads and billing.

Verify your email:
${verifyLink}

This link expires in 24 hours. If you didn't create this account, you can ignore this email.
  `.trim();

  const ok = await sendEmail({
    to: toEmail,
    from: fromEmail,
    subject,
    text: textContent,
    html: htmlContent,
  });

  return { ok, error: ok ? undefined : 'Email sending failed' };
}

/**
 * Send subscription update notification
 */
export async function sendSubscriptionUpdateEmail(params: {
  toEmail: string;
  planName: string;
  status: 'activated' | 'cancelled' | 'updated';
  effectiveDate?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@polishmypic.com';

  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[EMAIL] SENDGRID_API_KEY not set, subscription email not sent');
    return { ok: false, error: 'SendGrid not configured' };
  }

  const { toEmail, planName, status, effectiveDate } = params;

  let heading = 'Subscription Update';
  let bodyText = '';
  
  if (status === 'activated') {
    heading = 'Welcome to RealEnhance!';
    bodyText = `Your ${planName} subscription is now active. You can start enhancing your property photos right away.`;
  } else if (status === 'cancelled') {
    heading = 'Subscription Cancelled';
    bodyText = `Your ${planName} subscription has been cancelled${effectiveDate ? ` and will remain active until ${effectiveDate}` : ''}.`;
  } else {
    heading = 'Subscription Updated';
    bodyText = `Your subscription has been updated to ${planName}${effectiveDate ? ` effective ${effectiveDate}` : ''}.`;
  }

  if (USE_DYNAMIC_TEMPLATES && DYNAMIC_TEMPLATE_ID) {
    const success = await sendTemplateEmail({
      to: toEmail,
      from: fromEmail,
      notificationType: 'subscription_update',
      heading,
      greeting: 'Hi there,',
      bodyText,
      ctaText: status === 'activated' || status === 'updated' ? 'Go to Dashboard' : undefined,
      ctaUrl: status === 'activated' || status === 'updated' ? process.env.CLIENT_URL || 'https://realenhance.com' : undefined,
      footerText: 'RealEnhance — Elevate your property photos',
    });
    return { ok: success, error: success ? undefined : 'Email sending failed' };
  }

  // Fallback to simple email
  const success = await sendEmail({
    to: toEmail,
    from: fromEmail,
    subject: heading,
    text: bodyText,
  });

  return { ok: success, error: success ? undefined : 'Email sending failed' };
}

/**
 * Send bundle purchase confirmation
 */
export async function sendBundlePurchaseEmail(params: {
  toEmail: string;
  bundleName: string;
  imageCount: number;
  amount: string;
}): Promise<{ ok: boolean; error?: string }> {
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@polishmypic.com';

  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[EMAIL] SENDGRID_API_KEY not set, bundle purchase email not sent');
    return { ok: false, error: 'SendGrid not configured' };
  }

  const { toEmail, bundleName, imageCount, amount } = params;

  const heading = 'Bundle Purchase Confirmed';
  const bodyText = `Thank you for your purchase!\n\nYour ${bundleName} bundle (${imageCount} images) has been added to your account. You can start enhancing your property photos right away.`;

  if (USE_DYNAMIC_TEMPLATES && DYNAMIC_TEMPLATE_ID) {
    const success = await sendTemplateEmail({
      to: toEmail,
      from: fromEmail,
      notificationType: 'bundle_purchase',
      heading,
      greeting: 'Hi there,',
      bodyText,
      ctaText: 'Start Enhancing',
      ctaUrl: process.env.CLIENT_URL || 'https://realenhance.com',
      additionalInfo: `Amount charged: ${amount}`,
      footerText: 'RealEnhance — Elevate your property photos',
    });
    return { ok: success, error: success ? undefined : 'Email sending failed' };
  }

  // Fallback to simple email
  const success = await sendEmail({
    to: toEmail,
    from: fromEmail,
    subject: heading,
    text: bodyText + `\n\nAmount charged: ${amount}`,
  });

  return { ok: success, error: success ? undefined : 'Email sending failed' };
}