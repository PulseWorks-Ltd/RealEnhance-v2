# SendGrid Email Setup Guide

## Overview

Your RealEnhance application now has email invitation functionality integrated! When you send team invitations from the Agency Settings page, invitation emails will be sent automatically via SendGrid.

## Current Status

✅ **Completed:**
- SendGrid package (`@sendgrid/mail`) installed
- Email service created with invitation template
- Invitation emails integrated into the invite flow
- Frontend updated to show email delivery status
- Environment variables added to `.env`

❌ **Pending (You need to do):**
- Get a SendGrid API key
- Add your API key to `.env`
- Verify your sender email address
- Test email sending

---

## Step-by-Step Setup Instructions

### Step 1: Create SendGrid Account (Free)

1. Go to [https://sendgrid.com](https://sendgrid.com)
2. Click **"Start for Free"** or **"Sign Up"**
3. Fill in your details:
   - Email address (use your business email)
   - Password
   - Accept terms
4. **Verify your email address** - check your inbox for SendGrid's verification email
5. Complete the onboarding questionnaire (just click through it)

**Note:** The free tier includes 100 emails/day forever - perfect for getting started!

---

### Step 2: Verify Your Sender Identity

**Important:** SendGrid requires you to verify the email address you'll send FROM before you can send any emails.

#### Option A: Single Sender Verification (Easiest - Recommended)

1. Log in to SendGrid dashboard
2. Go to **Settings → Sender Authentication** (left sidebar)
3. Click **"Verify a Single Sender"**
4. Fill in the form:
   - **From Name:** RealEnhance or PulseWorks
   - **From Email Address:** `noreply@pulseworks.co.nz` (or your preferred email)
   - **Reply To:** Your business email (e.g., `hello@pulseworks.co.nz`)
   - **Company Address:** Your business address
   - **Nickname:** "RealEnhance Notifications"
5. Click **"Create"**
6. **Check your email inbox** for the verification email from SendGrid
7. Click the **"Verify Single Sender"** button in the email
8. You should see "Sender verified successfully!"

#### Option B: Domain Authentication (More Professional - Optional)

This allows you to send from any email address @your domain.com. It's more complex but looks more professional.

1. Go to **Settings → Sender Authentication**
2. Click **"Authenticate Your Domain"**
3. Follow the wizard to add DNS records to your domain
4. Wait for DNS propagation (can take up to 48 hours)

**For now, use Option A** to get started quickly. You can upgrade to domain authentication later.

---

### Step 3: Create API Key

1. In SendGrid dashboard, go to **Settings → API Keys** (left sidebar)
   - Direct link: [https://app.sendgrid.com/settings/api_keys](https://app.sendgrid.com/settings/api_keys)

2. Click **"Create API Key"** (blue button, top right)

3. Configure the API key:
   - **API Key Name:** `RealEnhance Production`
   - **API Key Permissions:** Choose **"Restricted Access"**

4. Scroll down to **Mail Send** section:
   - Expand **"Mail Send"**
   - Toggle **"Mail Send"** to **"Full Access"**
   - Leave all other permissions OFF (for security)

5. Click **"Create & View"** (bottom right)

6. **IMPORTANT:** Copy the API key NOW!
   - It starts with `SG.`
   - It will look like: `SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   - **This is your ONLY chance to see it** - SendGrid won't show it again
   - Keep it secret, like a password

---

### Step 4: Add API Key to Your Environment

1. Open your `server/.env` file

2. Find these lines (they're already there):
   ```env
   SENDGRID_API_KEY=YOUR_SENDGRID_API_KEY_HERE
   SENDGRID_FROM_EMAIL=noreply@pulseworks.co.nz
   ```

3. Replace `YOUR_SENDGRID_API_KEY_HERE` with your actual API key:
   ```env
   SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   SENDGRID_FROM_EMAIL=noreply@pulseworks.co.nz
   ```

4. **Important:** Make sure `SENDGRID_FROM_EMAIL` matches the email address you verified in Step 2!
   - If you verified `hello@pulseworks.co.nz`, use that
   - If you verified `noreply@pulseworks.co.nz`, use that

5. Save the file

6. **Restart your server** for the changes to take effect:
   ```bash
   # If running locally:
   cd server && npm run dev

   # If on Railway:
   # Just push your changes - Railway will automatically restart
   ```

---

## Testing Email Sending

### Test 1: Check Server Logs

1. Start your server (if not already running)
2. Look for this log message:
   ```
   SENDGRID_API_KEY environment variable not set - email notifications disabled
   ```
   - If you see this, double-check your `.env` file
   - Make sure the file is saved
   - Make sure you restarted the server

3. If configured correctly, you won't see any SendGrid warnings on startup

### Test 2: Send a Test Invitation

1. Go to your Agency Settings page:
   - Local: http://localhost:3000/agency
   - Production: https://your-domain.com/agency

2. In the **"Invite Team Member"** section:
   - Enter **your own email address** (so you can verify it arrives)
   - Select a role (Admin or Member)
   - Click **"Send Invite"**

3. Check the server logs for:
   ```
   [INVITE] Email sent successfully to your@email.com
   ```

4. **Check your email inbox!**
   - Look in both inbox and spam/junk folder
   - You should receive an email titled: **"You've been invited to join [Agency Name] on RealEnhance"**
   - The email should have a blue "Accept Invitation" button

5. Click the **"Accept Invitation"** button in the email
   - It should take you to the accept invite page
   - The invite should work correctly

---

## What the Email Looks Like

Your team members will receive a professional HTML email that includes:

- **Subject:** "You've been invited to join [Your Agency] on RealEnhance"
- **Greeting:** Personalized with inviter's name
- **Call to action:** Big blue "Accept Invitation" button
- **Expiry notice:** "This invitation will expire in 7 days"
- **Plain text version:** For email clients that don't support HTML
- **Fallback link:** In case the button doesn't work

---

## Troubleshooting

### Problem: No email arrives

**Check 1: Is SendGrid configured?**
```bash
# Check your .env file
cat server/.env | grep SENDGRID

# You should see:
# SENDGRID_API_KEY=SG.xxx...
# SENDGRID_FROM_EMAIL=your@email.com
```

**Check 2: Did you restart the server?**
```bash
# Restart your server after adding the API key
cd server && npm run dev
```

**Check 3: Check server logs**
Look for errors like:
- `[EMAIL] SENDGRID_API_KEY not set` → Your API key isn't configured
- `SendGrid email error: ...` → There's a problem with SendGrid

**Check 4: Is your sender verified?**
- Go to SendGrid → Settings → Sender Authentication
- Your email should show as "Verified"
- If not, check your email for the verification link

**Check 5: Check spam folder**
- SendGrid emails often land in spam initially
- Mark as "Not Spam" to train your email filter

### Problem: "Authentication failed" error

This means your API key is invalid or doesn't have permission:
- Did you copy the entire API key? (starts with `SG.`)
- Did you enable "Mail Send" → "Full Access" when creating the key?
- Try creating a new API key

### Problem: Email says "from" address not verified

Your `SENDGRID_FROM_EMAIL` doesn't match a verified sender:
- Check what email you verified in SendGrid
- Update `SENDGRID_FROM_EMAIL` in `.env` to match exactly
- Restart server

### Problem: Email content looks broken

This shouldn't happen, but if it does:
- Check the email in a different email client
- View the plain text version
- The accept link should still work even if formatting is broken

---

## FAQ

### Q: What format is the API key?

**A:** Just a string! It's not specific to Node.js or any language. When you create the API key in SendGrid, you'll get a string like `SG.xxxxxxx...` - just copy and paste that into your `.env` file.

### Q: How many emails can I send?

**A:**
- **Free tier:** 100 emails/day forever (perfect for most agencies)
- **Essentials plan:** $15/month for 40,000 emails/month
- **Pro plan:** $60/month for 100,000 emails/month

### Q: What happens if I run out of free emails?

**A:** SendGrid will queue emails until the next day, or you can upgrade to a paid plan.

### Q: Can I change the sender email later?

**A:** Yes! Just:
1. Verify a new sender in SendGrid
2. Update `SENDGRID_FROM_EMAIL` in `.env`
3. Restart server

### Q: Can I customize the email template?

**A:** Yes! The template is in `server/src/services/email.ts` in the `sendInvitationEmail` function. You can edit the HTML and text content.

### Q: What if someone doesn't receive the email?

**A:** The frontend will show a warning if email delivery fails. The invite is still created and stored, so you can:
1. Copy the invite link from the "Pending Invites" section
2. Send it to them manually via another channel (Slack, SMS, etc.)

### Q: Does this work for password reset emails too?

**A:** Not yet - this implementation is just for agency invitations. Password reset emails could be added later using the same SendGrid setup.

---

## Production Checklist

Before going live, make sure:

- [ ] SendGrid API key is added to production `.env`
- [ ] Sender email is verified in SendGrid
- [ ] `SENDGRID_FROM_EMAIL` is set to a verified email
- [ ] Test invitation sent successfully
- [ ] Email arrives and looks good (not in spam)
- [ ] Accept invitation link works
- [ ] Server logs show successful email sending

---

## Support

If you have issues:

1. **Check SendGrid dashboard:** https://app.sendgrid.com
   - Go to Activity → All to see sent emails and any errors

2. **Check server logs** for error messages starting with `[EMAIL]` or `[INVITE]`

3. **SendGrid Docs:** https://docs.sendgrid.com

4. **Common issues:**
   - API key not set → Add to `.env` and restart
   - Sender not verified → Complete sender verification
   - Email in spam → Mark as "Not Spam"

---

## Summary

You've successfully integrated SendGrid email invitations! Once you:
1. ✅ Create a SendGrid account
2. ✅ Verify your sender email
3. ✅ Create an API key with "Mail Send" permission
4. ✅ Add the API key to `server/.env`
5. ✅ Restart your server

Your team invitations will be automatically sent via email! 🎉

**Next Steps:**
1. Set up your SendGrid account now (takes 10 minutes)
2. Test sending an invitation to yourself
3. Once confirmed working, invite your real team members!
