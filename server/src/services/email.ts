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