# SendGrid Dynamic Template Setup Guide

## Overview

All RealEnhance email notifications now support **SendGrid Dynamic Templates** for consistent, branded emails. This includes:

- 📧 **Team Invitations** - Invite new members to your agency
- 🔐 **Password Reset** - Secure password reset links
- 💳 **Subscription Updates** - Plan activation, cancellation, and changes
- 🎁 **Bundle Purchases** - Confirmation emails for image bundle purchases
- ✅ **Batch Processing** - Completion notifications with results summary

When dynamic templates are **disabled** (default), emails fall back to plain HTML with inline styling.

---

## Quick Start

### Step 1: Enable Template Mode

Add these environment variables to your `.env` file:

```bash
# Enable dynamic templates
SENDGRID_USE_TEMPLATES=1

# Your SendGrid template ID (get from step 2)
SENDGRID_TEMPLATE_ID=d-your_template_id_here
```

### Step 2: Create SendGrid Dynamic Template

1. **Log in to SendGrid**
   - Go to [https://mc.sendgrid.com/dynamic-templates](https://mc.sendgrid.com/dynamic-templates)

2. **Create New Template**
   - Click **"Create a Dynamic Template"**
   - Name it: `RealEnhance Notifications`
   - Click **"Create"**

3. **Add Version**
   - Click **"Add Version"**
   - Choose **"Blank Template"** or **"Code Editor"**

4. **Paste Template Code**
   - Copy the template HTML from the section below
   - Paste into the code editor
   - Click **"Save Template"**

5. **Copy Template ID**
   - Find the template ID at the top (starts with `d-`)
   - Add it to your `.env` file as `SENDGRID_TEMPLATE_ID`

---

## SendGrid Template HTML

Copy and paste this **complete template** into your SendGrid dynamic template editor:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{heading}}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 30px 40px;">
              <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: #1f2937; line-height: 1.3;">
                {{heading}}
              </h1>
            </td>
          </tr>
          
          <!-- Body -->
          <tr>
            <td style="padding: 0 40px 30px 40px;">
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #374151;">
                {{greeting}}
              </p>
              <p style="margin: 0; font-size: 16px; line-height: 1.6; color: #374151; white-space: pre-wrap;">
                {{body_text}}
              </p>
            </td>
          </tr>
          
          <!-- CTA Button (conditional) -->
          {{#if cta_url}}
          <tr>
            <td style="padding: 0 40px 30px 40px;" align="center">
              <a href="{{cta_url}}" 
                 style="display: inline-block; padding: 14px 28px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 500;">
                {{cta_text}}
              </a>
            </td>
          </tr>
          {{/if}}
          
          <!-- Additional Info (conditional) -->
          {{#if additional_info}}
          <tr>
            <td style="padding: 0 40px 30px 40px;">
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #6b7280; white-space: pre-wrap;">
                {{additional_info}}
              </p>
            </td>
          </tr>
          {{/if}}
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px 40px 40px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; font-size: 12px; line-height: 1.6; color: #9ca3af; white-space: pre-wrap;">
                {{footer_text}}
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## Template Fields Reference

Your template uses these **Handlebars variables** (automatically populated by the app):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `notification_type` | string | Yes | Type of notification: `invitation`, `password_reset`, `subscription_update`, `bundle_purchase`, `batch_complete` |
| `heading` | string | Yes | Email subject/heading (e.g., "You've been invited to join Agency Name") |
| `greeting` | string | Yes | Personalized greeting (e.g., "Hi John,") |
| `body_text` | string | Yes | Main email content. Supports `\n` for line breaks |
| `cta_text` | string | No | Button text (e.g., "Accept Invitation", "Reset Password") |
| `cta_url` | string | No | Button link URL. Button only shows if this is provided |
| `additional_info` | string | No | Secondary information, disclaimers, or expiration notices |
| `footer_text` | string | No | Footer content (company info, unsubscribe links, etc.) |

---

## Testing Your Template

### SendGrid Template Preview

1. Go to your template in SendGrid
2. Click **"Preview and Test"**
3. Paste this **test data**:

```json
{
  "notification_type": "invitation",
  "heading": "You've been invited to join Agency Name",
  "greeting": "Hi there,",
  "body_text": "John Smith has invited you to join Agency Name on RealEnhance as an admin.\n\nRealEnhance helps real estate teams quickly turn everyday listing photos into polished, professional-quality images that attract buyers.",
  "cta_text": "Accept Invitation",
  "cta_url": "https://realenhance.com/invite/abc123",
  "additional_info": "This invitation will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.",
  "footer_text": "RealEnhance — Elevate your property photos\nIf the button above doesn't work, copy and paste this link: https://realenhance.com/invite/abc123"
}
```

4. Click **"Show Preview"** to see rendered email

### Test Different Notification Types

Replace the test data with these examples:

#### Password Reset
```json
{
  "notification_type": "password_reset",
  "heading": "Reset your password",
  "greeting": "Hi John,",
  "body_text": "We received a request to reset your RealEnhance password. Click the button below to set a new password.",
  "cta_text": "Reset Password",
  "cta_url": "https://realenhance.com/reset/xyz789",
  "additional_info": "This link will expire in 30 minutes. If you didn't request a reset, you can safely ignore this email.",
  "footer_text": "RealEnhance — Elevate your property photos\nIf the button above doesn't work, copy and paste this link: https://realenhance.com/reset/xyz789"
}
```

#### Subscription Update
```json
{
  "notification_type": "subscription_update",
  "heading": "Welcome to RealEnhance!",
  "greeting": "Hi there,",
  "body_text": "Your Pro Plan subscription is now active. You can start enhancing your property photos right away.",
  "cta_text": "Go to Dashboard",
  "cta_url": "https://realenhance.com/dashboard",
  "footer_text": "RealEnhance — Elevate your property photos"
}
```

#### Bundle Purchase
```json
{
  "notification_type": "bundle_purchase",
  "heading": "Bundle Purchase Confirmed",
  "greeting": "Hi there,",
  "body_text": "Thank you for your purchase!\n\nYour Starter Bundle (50 images) has been added to your account. You can start enhancing your property photos right away.",
  "cta_text": "Start Enhancing",
  "cta_url": "https://realenhance.com/dashboard",
  "additional_info": "Amount charged: $29.00",
  "footer_text": "RealEnhance — Elevate your property photos"
}
```

#### Batch Complete
```json
{
  "notification_type": "batch_complete",
  "heading": "Batch Processing Complete - 8/10 images",
  "greeting": "Your batch processing has finished!",
  "body_text": "Your batch image processing is complete!\n\n✅ Successfully processed: 8 images",
  "additional_info": "❌ Failed: 2 images\n\n• image-003.jpg: File too large\n• image-007.png: Invalid format",
  "footer_text": "RealEnhance — Elevate your property photos"
}
```

---

## Environment Variables Summary

Add these to your `server/.env` file:

```bash
# =============================================
# SendGrid Email Configuration
# =============================================

# Required: SendGrid API Key
# Get from: https://app.sendgrid.com/settings/api_keys
SENDGRID_API_KEY=SG.your_actual_api_key_here

# Required: Verified sender email address
# Must be verified in SendGrid: Settings → Sender Authentication
SENDGRID_FROM_EMAIL=noreply@yourdomain.com

# Optional: Enable dynamic templates (default: disabled)
# Set to '1' or 'true' to use templates
# When disabled, falls back to plain HTML emails
SENDGRID_USE_TEMPLATES=1

# Optional: Dynamic template ID (required if SENDGRID_USE_TEMPLATES=1)
# Get from: https://mc.sendgrid.com/dynamic-templates
# Example: d-abc123def456789
SENDGRID_TEMPLATE_ID=d-your_template_id_here

# Optional: Client URL for CTA buttons
# Used in subscription and bundle purchase emails
CLIENT_URL=https://realenhance.com
```

---

## Fallback Behavior

**If templates are disabled** (`SENDGRID_USE_TEMPLATES` not set or `0`):
- ✅ Emails still send successfully
- 📧 Uses plain HTML with inline CSS styling
- 🎨 Basic RealEnhance branding maintained
- 🔗 All functionality preserved (links, buttons work)

**If template ID is missing** but `SENDGRID_USE_TEMPLATES=1`:
- ⚠️ Warning logged to console
- ✅ Automatically falls back to plain HTML
- 📧 Emails continue to send normally

---

## Customization Tips

### Brand Colors
Edit these hex codes in the template:

- **Primary Blue**: `#2563eb` (buttons, headings)
- **Background**: `#f3f4f6` (page background)
- **Text Dark**: `#1f2937` (headings)
- **Text Medium**: `#374151` (body text)
- **Text Light**: `#6b7280` (secondary text)
- **Text Muted**: `#9ca3af` (footer)

### Add Logo
Insert before the heading:

```html
<tr>
  <td style="padding: 30px 40px 0 40px;" align="center">
    <img src="https://yourdomain.com/logo.png" 
         alt="RealEnhance" 
         style="height: 40px; width: auto;" />
  </td>
</tr>
```

### Custom Footer Links
Replace footer content with:

```handlebars
<p style="margin: 0; font-size: 12px; line-height: 1.6; color: #9ca3af;">
  RealEnhance — Elevate your property photos<br/>
  <a href="https://realenhance.com/help" style="color: #2563eb;">Help Center</a> | 
  <a href="https://realenhance.com/privacy" style="color: #2563eb;">Privacy Policy</a>
</p>
```

---

## Troubleshooting

### Emails not sending
1. Check `SENDGRID_API_KEY` is set correctly
2. Verify sender email in SendGrid dashboard
3. Check server logs for errors

### Template not applying
1. Verify `SENDGRID_USE_TEMPLATES=1` is set
2. Confirm `SENDGRID_TEMPLATE_ID` starts with `d-`
3. Check template is **active** in SendGrid dashboard

### Preview not working
1. Ensure all **required fields** have values in test data
2. Check JSON syntax (no trailing commas)
3. Use `\n` for line breaks, not actual line breaks in JSON

### Button not showing
1. Verify both `cta_text` and `cta_url` are provided
2. Check `{{#if cta_url}}` conditional is in template
3. Ensure URL is properly formatted (starts with `http://` or `https://`)

---

## Need Help?

- **SendGrid Docs**: [Dynamic Templates Guide](https://docs.sendgrid.com/ui/sending-email/how-to-send-an-email-with-dynamic-templates)
- **Handlebars Syntax**: [Handlebars Documentation](https://handlebarsjs.com/guide/)
- **Test Emails**: Use SendGrid's built-in preview/test feature before going live

---

## What's Next?

Once your template is set up and tested:

1. ✅ Deploy with `SENDGRID_USE_TEMPLATES=1`
2. 📧 All emails automatically use your branded template
3. 🎨 Customize colors/logo to match your brand
4. 📊 Monitor email delivery in SendGrid dashboard

Your email notifications are now fully branded and professional! 🎉
