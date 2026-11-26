# VPNShop V2 · Administration and identity

The Admin API retains its separate origin, CIDR and Origin checks, rate limits, server-side HttpOnly strict cookie, staff-specific credentials and existing audited command protocol. Customer email credentials and sessions remain in the Public API. A staff contact address can coincide with a customer address without linking the accounts.

## Username and migration

Staff usernames have 3–48 ASCII characters. The first must be alphanumeric. The rest may contain letters, digits, dot, underscore and hyphen. The API lowercases ASCII letters and rejects whitespace, controls and non-ASCII characters. PostgreSQL enforces canonical values and uniqueness. User IDs, roles, status, credential hashes, TOTP, recovery codes and audit references remain intact. Backfill assigns `staff-000000000001` and subsequent identifiers in stable user-ID order. Existing staff contact details are copied without making email a login identifier. Historical sessions and challenges are revoked because they lack policy provenance. Open legacy invitations and factor-reset requests expire at migration. New invitation acceptance rechecks the issuing OWNER.

The Admin UI, API and schema require a coordinated version update. Wait for the migrator and verify the updated application before opening admin access. PASS 02 refuses standard rollback across changed migration checksums. Recovery uses a compatible forward fix or an explicitly approved backup restore. Existing ADMIN accounts keep their operational permissions. They acquire staff management permissions only after the designated account is explicitly promoted to OWNER.

## Local owner operations

After `vpnshop up` initializes and migrates PostgreSQL, use root/sudo on Single or Core.

```bash
sudo vpnshop admin bootstrap
sudo vpnshop admin list
sudo vpnshop admin recover --username staff-000000000001 --adopt-legacy-owner --incident CHANGE-1042
sudo vpnshop admin recover --username established-owner --reset-totp --incident INCIDENT-2042
```

Bootstrap is for an installation with no staff record or staff credential. It creates one permanent OWNER with Argon2id and writes audit atomically. The CLI prompts for username and password confirmation. Optional `--display-name` and `--contact-email` metadata can be supplied at invocation. Automation supplies `--username` and either `--password-stdin` or an operator-owned protected `--password-file`. Never pass passwords as command-line arguments. The existing CLI takes the deployment lock and calls the application command in the installed admin runtime with stdin and without published ports. Application mutations additionally serialize on the PostgreSQL staff advisory lock.

On an existing installation, identify the intended account with `admin list`. The adoption command requires a specific active ADMIN with permanent credentials and no existing OWNER. It preserves the password, TOTP and recovery codes, changes the role and revokes sessions. Ordinary recovery targets an existing OWNER, resets the password, invalidates sessions and stages, and optionally clears TOTP/recovery codes. Deliberate activation of a blocked OWNER requires `--restore-status`. Deactivated records are kept for audit. Recovery requires a nonsecret incident ID and exact username confirmation, either typed or supplied with `--confirm-username`. Root is trusted for these operations.

## Permissions and access

| Role | Staff | Customer accounts |
| --- | --- | --- |
| OWNER | Create, edit identity fields, change roles, block/unblock, deactivate, reset credentials or TOTP, manage sessions and invite | Create, manually activate and perform existing operational actions |
| ADMIN | Own security and sessions | Manually activate eligible accounts or pending email registrations and perform existing operational actions |
| SUPPORT | Own security and sessions | Existing limited and masked views |

Sensitive changes use the existing version, command-bound step-up and idempotency protocol. Staff mutations serialize with local recovery and revalidate the actor and session before effects. The last eligible OWNER is protected against role loss, blocking and deactivation. An expired or outstanding temporary password, a deactivated account, or a currently locked confirmed factor under an active factor policy does not count as a second available OWNER. Required policy also requires a confirmed factor for the remaining OWNER. Staff removal uses deactivation to preserve history.

Staff creation and password reset use administrator-provided temporary passwords valid for 24 hours. The first login has a short, one-time password change stage before TOTP and before session issuance. Invitations for ADMIN and SUPPORT remain available with a one-time code. Operators deliver credentials by a protected channel. Staff passwords and one-time codes are absent from stored command results and audit payloads.

OWNER creates ordinary accounts with an initial temporary password, optionally active immediately. A pending account cannot change the temporary password or establish a session until active. A confirmed email registration still activates through the existing verification flow. ADMIN and OWNER can activate a flagged customer or finish a pending registration after independently identifying the claimant. For pending registration, the operator supplies a new temporary password for that claimant. The credential from the unverified request is no longer accepted. Manual activation records the method and time, leaves email verification unset, and leaves blocking in force. The customer login provides a temporary password change form, then normal login. No email is required to provision accounts. No orders or service entitlements are created by these commands.

## 2FA and sessions

Set `ADMIN_2FA_POLICY=required|optional|disabled` in Single/Core configuration and apply with `vpnshop up`. The default is required. All options work with private, public and local admin placement. Public plus disabled produces a nonblocking preflight and doctor warning.

- **Required** uses TOTP or a single-use recovery code at login. Staff without an enrolled factor must complete setup before receiving a session.
- **Optional** checks enrolled factors and permits password-only login without one. Enabling or disabling the factor in Security requires step-up and invalidates older sessions.
- **Disabled** uses password-only login and preserves stored TOTP material. A later policy transition can reuse enrollment.

A policy transition records audit and revokes sessions and outstanding challenges. Step-up always checks the staff password. Required and enrolled optional accounts additionally submit a fresh TOTP code. Proofs are session-bound, command-bound, version-bound, short lived and consumed once. Self session list and revocation remain available to all staff. OWNER sees permitted session metadata and can revoke individual or all staff sessions. Idle and absolute expiry continue to apply.

PASS 04 owns further email/OAuth/Telegram and support changes. PASS 06 owns the existing-server migration rehearsal and external acceptance.
