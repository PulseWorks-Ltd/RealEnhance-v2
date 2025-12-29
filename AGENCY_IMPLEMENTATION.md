# Agency Accounts Implementation Summary

## Overview

Implemented a comprehensive agency account system with role-based access control (RBAC) and seat limit enforcement for RealEnhance. This system allows multiple users to collaborate under a single agency account with plan-based seat limits.

## Key Features

1. **Individual User Authentication** - Each user authenticates with their own credentials (email/password or Google OAuth)
2. **Agency Grouping** - Users belong to an agency via `agencyId` field
3. **Role-Based Access Control** - Three roles: `owner`, `admin`, `member`
4. **Plan-Based Seat Limits** - Starter (2 seats), Pro (5 seats), Agency (10 seats)
5. **Seat Limit Enforcement** - Enforced at three critical points:
   - Invite creation
   - Invite acceptance
   - User login/session refresh
6. **Soft Enforcement** - Seat limits are NOT enforced at image processing time

## Files Created

### Shared Package (`shared/src/`)

1. **`auth/types.ts`** - Core authentication and agency type definitions
   - `UserRole` type: "owner" | "admin" | "member"
   - `PlanTier` type: "starter" | "pro" | "agency"
   - `Agency` interface
   - `SeatLimitCheck` interface

2. **`plans.ts`** - Plan tier configurations
   - `PLAN_LIMITS` constant mapping plan tiers to maxSeats

3. **`agencies.ts`** - Agency management with seat tracking (182 lines)
   - `createAgency()` - Creates new agency
   - `getAgency()` - Retrieves agency by ID
   - `updateAgency()` - Updates agency settings
   - `listAgencyUsers()` - Gets all users in agency
   - `countActiveAgencyUsers()` - Counts active users (isActive !== false)
   - `isAgencyOverSeatLimit()` - Returns seat limit check result

4. **`invites.ts`** - Invite system with seat enforcement (182 lines)
   - `createInvite()` - Creates invite with seat limit check
   - `getInviteByToken()` - Retrieves and validates invite
   - `acceptInvite()` - Accepts invite with re-check of seat limit
   - `listAgencyInvites()` - Lists pending invites for agency
   - `deleteInvite()` - Deletes/cancels invite

### Server Package (`server/src/`)

1. **`middleware/seatLimitCheck.ts`** - Login enforcement middleware
   - `checkSeatLimitAtLogin()` - Blocks members when over limit, allows owner/admin

2. **`routes/agency.ts`** - Complete agency management API (448 lines)
   - `POST /api/agency/create` - Create agency and assign owner
   - `GET /api/agency/info` - Get user's agency info + seat usage
   - `GET /api/agency/members` - List members (admin only)
   - `POST /api/agency/invite` - Invite member (admin only, seat check)
   - `GET /api/agency/invites` - List pending invites
   - `POST /api/agency/invite/accept` - Accept invite (seat re-check)
   - `POST /api/agency/users/:userId/disable` - Disable user (admin only)
   - `POST /api/agency/users/:userId/enable` - Enable user (admin only, seat check)

### Client Package (`client/src/`)

1. **`pages/agency.tsx`** - Agency settings UI (317 lines)
   - Agency info card with seat usage display
   - Invite form (admin/owner only)
   - Pending invites list
   - Team members list with enable/disable controls
   - Role-based UI visibility

## Files Modified

### Shared Package

1. **`shared/src/types.ts`**
   - Added `agencyId?: string | null` to UserRecord
   - Added `role?: "owner" | "admin" | "member"` to UserRecord
   - Added `isActive?: boolean` to UserRecord
   - Made `createdAt` and `updatedAt` required (not optional)

2. **`shared/src/index.ts`**
   - Added exports for new modules: auth/types, plans, agencies, invites
   - Updated agencyStore export to avoid conflicts

3. **`shared/package.json`**
   - Added subpath exports for new modules:
     - `./agencies.js`
     - `./invites.js`
     - `./auth/types.js`
     - `./plans.js`

### Server Package

1. **`server/src/shared/types.ts`**
   - Mirrored changes from shared/src/types.ts
   - Added agency fields to UserRecord
   - Made createdAt/updatedAt required

2. **`server/src/services/users.ts`**
   - Added `updateUser()` function for user management
   - Extended `createUserWithPassword()` to accept agencyId, role
   - Updated `createUser()` to set default createdAt/updatedAt

3. **`server/src/routes/emailAuth.ts`**
   - Added seat limit check at login (lines 99-107)
   - Blocks members when agency is over seat limit

4. **`server/src/auth/google.ts`**
   - Added seat limit check at OAuth callback (lines 104-115)
   - Redirects to login with error if seat limit exceeded

5. **`server/src/index.ts`**
   - Registered agency router: `app.use("/api/agency", agencyRouter)`

### Client Package

1. **`client/src/App.tsx`**
   - Added Agency page import
   - Added route: `/agency`

2. **`client/src/components/profile-dropdown.tsx`**
   - Added "Agency Settings" menu item
   - Links to `/agency` route

## Data Model

### UserRecord Extensions

```typescript
interface UserRecord {
  // ... existing fields
  agencyId?: string | null;        // Links user to agency
  role?: "owner" | "admin" | "member";  // Agency role
  isActive?: boolean;              // Can user log in? (defaults to true)
}
```

### Agency

```typescript
interface Agency {
  agencyId: string;
  name: string;
  planTier: "starter" | "pro" | "agency";
  maxSeats: number;  // 2, 5, or 10 based on plan
  createdAt: string;
  updatedAt?: string;
}
```

### Invite

```typescript
interface Invite {
  token: string;           // UUID used in invite URL
  agencyId: string;
  email: string;
  role: "admin" | "member";
  invitedByUserId: string;
  createdAt: string;       // ISO timestamp
  expiresAt: string;       // 7 days from creation
  acceptedAt?: string;
  acceptedByUserId?: string;
}
```

## Seat Limit Enforcement Logic

### Active User Counting

```typescript
activeUsers = users.filter(u => u.isActive !== false && u.agencyId === agency.agencyId)
isOverLimit = activeUsers.length > agency.maxSeats
```

### Enforcement Points

1. **Invite Creation** (`POST /api/agency/invite`)
   - Rejects if `activeSeats >= maxSeats`
   - Returns error: "Seat limit reached (X/Y). Upgrade your plan..."

2. **Invite Acceptance** (`POST /api/agency/invite/accept`)
   - Re-checks seat limit before adding user
   - Handles race condition where limit was reached between invite creation and acceptance

3. **User Login** (Email auth & Google OAuth)
   - Members: Blocked when `activeSeats > maxSeats`
   - Owner/Admin: Always allowed to log in (even when over limit)
   - Returns 403 with code `SEAT_LIMIT_EXCEEDED`

4. **User Re-enable** (`POST /api/agency/users/:userId/enable`)
   - Checks seat limit before re-enabling disabled user
   - Prevents enabling if it would exceed limit

## Example API Flows

### 1. Create Agency

```bash
# User signs up normally
curl -X POST http://localhost:3001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.com",
    "password": "SecurePass123!",
    "name": "Agency Owner"
  }'

# Create agency (requires authenticated session)
curl -X POST http://localhost:3001/api/agency/create \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=..." \
  -d '{
    "name": "Acme Real Estate",
    "planTier": "pro"
  }'

# Response:
{
  "agency": {
    "agencyId": "agency_uuid",
    "name": "Acme Real Estate",
    "planTier": "pro",
    "maxSeats": 5,
    "createdAt": "2025-12-26T10:00:00.000Z"
  },
  "user": {
    "id": "user_uuid",
    "email": "owner@example.com",
    "name": "Agency Owner",
    "agencyId": "agency_uuid",
    "role": "owner",
    "isActive": true
  }
}
```

### 2. Invite Team Member

```bash
# Owner/admin invites a team member
curl -X POST http://localhost:3001/api/agency/invite \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=..." \
  -d '{
    "email": "member@example.com",
    "role": "member"
  }'

# Success Response:
{
  "success": true,
  "invite": {
    "token": "invite_token_uuid",
    "email": "member@example.com",
    "role": "member",
    "expiresAt": "2026-01-02T10:00:00.000Z"
  }
}

# Seat limit exceeded response:
{
  "error": "Seat limit reached (5/5). Upgrade your plan to add more users."
}
```

### 3. Accept Invite

```bash
# New user accepts invite and creates account
curl -X POST http://localhost:3001/api/agency/invite/accept \
  -H "Content-Type: application/json" \
  -d '{
    "token": "invite_token_uuid",
    "email": "member@example.com",
    "password": "SecurePass123!",
    "name": "Team Member"
  }'

# Success Response:
{
  "success": true,
  "user": {
    "id": "new_user_uuid",
    "email": "member@example.com",
    "name": "Team Member",
    "agencyId": "agency_uuid",
    "role": "member",
    "isActive": true
  },
  "agency": {
    "agencyId": "agency_uuid",
    "name": "Acme Real Estate",
    "planTier": "pro"
  }
}
```

### 4. Login - Member Blocked When Over Limit

```bash
# Agency is over seat limit (6 active users, maxSeats = 5)
# Member tries to log in
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "member@example.com",
    "password": "SecurePass123!"
  }'

# Response: 403 Forbidden
{
  "error": "Agency seat limit exceeded",
  "message": "Your agency is over its seat limit (6/5). Please contact your administrator to upgrade or remove users.",
  "code": "SEAT_LIMIT_EXCEEDED"
}
```

### 5. Login - Owner/Admin Allowed When Over Limit

```bash
# Agency is over seat limit (6 active users, maxSeats = 5)
# Owner tries to log in
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.com",
    "password": "SecurePass123!"
  }'

# Response: 200 OK (owner can always log in)
{
  "id": "owner_uuid",
  "name": "Agency Owner",
  "email": "owner@example.com",
  "credits": 100
}
```

### 6. Disable User (Admin/Owner Only)

```bash
curl -X POST http://localhost:3001/api/agency/users/user_uuid/disable \
  -H "Cookie: connect.sid=..." \

# Response:
{
  "success": true,
  "user": {
    "id": "user_uuid",
    "isActive": false
  }
}
```

### 7. Enable User (Seat Limit Check)

```bash
# Try to re-enable user when at seat limit
curl -X POST http://localhost:3001/api/agency/users/user_uuid/enable \
  -H "Cookie: connect.sid=..." \

# If at limit:
{
  "error": "Cannot enable user: seat limit reached (5/5)"
}

# If under limit:
{
  "success": true,
  "user": {
    "id": "user_uuid",
    "isActive": true
  }
}
```

### 8. Get Agency Info

```bash
curl -X GET http://localhost:3001/api/agency/info \
  -H "Cookie: connect.sid=..." \

# Response:
{
  "agencyId": "agency_uuid",
  "name": "Acme Real Estate",
  "planTier": "pro",
  "maxSeats": 5,
  "activeSeats": 4,
  "userRole": "owner"
}
```

### 9. List Agency Members (Admin/Owner Only)

```bash
curl -X GET http://localhost:3001/api/agency/members \
  -H "Cookie: connect.sid=..." \

# Response:
[
  {
    "id": "user1_uuid",
    "email": "owner@example.com",
    "name": "Agency Owner",
    "role": "owner",
    "isActive": true
  },
  {
    "id": "user2_uuid",
    "email": "member@example.com",
    "name": "Team Member",
    "role": "member",
    "isActive": true
  }
]
```

## Architectural Decisions

### 1. Fail-Open Redis Operations

All Redis operations are wrapped in try/catch with default/safe fallbacks:
- Agency not found → treated as if agency doesn't exist (no blocking)
- Redis connection error → allows operation to proceed
- This prevents Redis outages from completely breaking authentication

### 2. Seat Counting Logic

Active users = users where `isActive !== false` AND has matching `agencyId`
- Defaults to true (undefined treated as active)
- Explicit false = disabled user
- This allows new fields to default to enabled state

### 3. Role-Based Login Enforcement

- **Owner/Admin**: Always allowed to log in (even when over limit)
  - Rationale: They need access to manage the agency and resolve seat issues
- **Member**: Blocked when `activeSeats > maxSeats`
  - Prevents unauthorized access when agency exceeds limit

### 4. Dual Seat Checks on Invite Flow

- Check #1: At invite creation time
- Check #2: At invite acceptance time
- Rationale: Handles race conditions where multiple invites are accepted simultaneously

### 5. No Enforcement at Processing Time

As per requirements, seat limits are NOT checked when:
- Uploading images
- Running enhancement jobs
- Accessing previously created content
- Using worker pipeline

Enforcement is ONLY at account management boundaries:
- Creating invites
- Accepting invites
- Logging in

### 6. Backward Compatibility

- All new fields are optional (`agencyId?`, `role?`, `isActive?`)
- Users without agency can still use the system normally
- Existing users aren't affected by the changes
- Agency features are additive, not breaking

## Testing Checklist

### Seat Limit Enforcement

- [ ] Create agency with starter plan (2 seats)
- [ ] Invite 2 users successfully
- [ ] Attempt to invite 3rd user → should fail with seat limit error
- [ ] Upgrade plan to pro (5 seats)
- [ ] Invite 3rd user → should succeed
- [ ] Fill all 5 seats
- [ ] Disable 1 user → active seats = 4
- [ ] Invite another user → should succeed (under limit)
- [ ] Try to enable disabled user → should fail (at limit)

### Login Enforcement

- [ ] Agency at 6/5 seats (over limit)
- [ ] Member login → should fail with 403 + SEAT_LIMIT_EXCEEDED
- [ ] Admin login → should succeed
- [ ] Owner login → should succeed
- [ ] Disable 2 users → now at 4/5 seats
- [ ] Member login → should succeed

### Invite Flow

- [ ] Send invite to new email
- [ ] Accept invite with new account creation
- [ ] Verify user has correct agencyId, role, isActive
- [ ] Try to accept expired invite → should fail
- [ ] Try to accept already-accepted invite → should fail
- [ ] Send invite when at limit → should fail
- [ ] Accept invite when limit reached after invite sent → should fail

### UI Testing

- [ ] Agency page shows correct seat usage (X/Y)
- [ ] Agency page shows user's role badge
- [ ] Members can't see invite form (admin/owner only)
- [ ] Invite form works and shows pending invites
- [ ] Team members list shows all users with roles
- [ ] Disable/enable buttons work correctly
- [ ] Owner can't disable themselves
- [ ] Profile dropdown shows "Agency Settings" link

### Edge Cases

- [ ] User with no agency can still use system
- [ ] Redis connection failure doesn't block login
- [ ] Multiple simultaneous invite accepts handled correctly
- [ ] Invite to existing user email → appropriate error
- [ ] Accept invite with mismatched email → appropriate error

## Non-Breaking Changes Confirmed

The following aspects of the system were NOT changed:
- ✅ Prompts and prompt selection logic
- ✅ Validators and validation retry logic
- ✅ Stage selection (1A, 1B, 2, edit)
- ✅ S3 publishing pipeline
- ✅ Worker processing logic
- ✅ Image enhancement/editing flows
- ✅ Credit system (still present, not enforced)
- ✅ Usage tracking (separate from enforcement)

## Next Steps

1. **Testing**: Run through the testing checklist above
2. **Documentation**: Add user-facing docs about agency accounts
3. **Monitoring**: Add logging for seat limit rejections (for analytics)
4. **Future Enhancements**:
   - Email notifications for invites
   - Billing integration with plan upgrades
   - Agency-level billing (shared credits)
   - Bulk invite import (CSV upload)
   - Agency-level image library sharing

## Summary

This implementation provides a complete agency account system with:
- ✅ Individual user authentication preserved
- ✅ Agency grouping with role-based access control
- ✅ Plan-based seat limits (2, 5, 10)
- ✅ Seat limit enforcement at invite + login only
- ✅ Soft enforcement (no processing-time checks)
- ✅ Minimal UI for agency management
- ✅ Backward compatible with existing users
- ✅ Zero changes to image processing pipeline

All requirements have been met, and the system is ready for testing.
