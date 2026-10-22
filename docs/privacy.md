# Data Privacy and Retention Policy

This document outlines how the platform handles personal data, retention periods, and data subject rights to comply with applicable data protection regulations (GDPR, NDPA, DPA, POPIA).

## 1. Personal Data We Process

The platform processes personal data about:

### Students (Minors)
- Student ID (platform-generated or school-provided)
- Full name
- Class/grade level
- Fee amount and payment status
- Payment history (amounts, dates, transaction hashes)

### Parents/Guardians
- Email address (encrypted at rest)
- Phone number (encrypted at rest)
- Payment records linked to their children

### School Administrators
- Email address (used as login identifier)
- Password (hashed with bcrypt)
- Authentication logs (timestamps, hashed IPs)
- MFA secrets (encrypted)

## 2. Lawful Basis for Processing

- **Contract performance**: Processing payment data and student enrollment records is necessary to provide the school payment management service
- **Legitimate interests**: Fraud prevention, system security, and operational logging
- **Consent**: Email/SMS reminders (parents can opt out via `reminderOptOut` field)

## 3. Data Retention Periods

### Active Student Records
- **Retention**: While the student is enrolled and for the current academic year
- **Deletion trigger**: Manual deletion by school admin, or automatic cleanup after anonymisation request

### Soft-Deleted Students
- **Retention**: Contact data (parentEmail, parentPhone) retained for **30 days** after soft-delete to allow restore
- **After 30 days**: Automatic anonymisation (contact data removed, name replaced with "Former student [ID]")

### Financial Records (Payments, Disputes, Fee Adjustments)
- **Retention**: **7 years** from transaction date (standard financial record retention)
- **After 7 years**: Records are **pseudonymised** (PII removed but transaction amounts, hashes, and dates retained for audit compliance)

### Reminder Logs and Email Delivery Logs
- **Retention**: **12 months** from creation
- **Automatic cleanup**: Records older than 12 months are purged by scheduled job

### Audit Logs
- **Retention**: Configurable via `AUDIT_LOG_RETENTION_DAYS` (default: 365 days)
- **Automatic cleanup**: Records older than retention period are purged by scheduled job

### Application Logs (File and Aggregated)
- **File logs**: Retained for `LOG_MAX_FILES` (default: 14 days) via winston-daily-rotate-file
- **Aggregated logs**: Follow your log aggregator's retention policy
- **Content**: All PII fields are redacted or masked in logs (see section 5)

## 4. Data Subject Rights

### Right of Access (GDPR Art. 15)
**Endpoint**: not yet exposed over HTTP — handled by an operator on request
- Returns a JSON export of all personal data held about a student and their parent
- Includes: student record, payment history, reminder logs, email delivery records, audit entries
- **Audit logged**: Every data export is recorded in the audit log

### Right to Erasure (GDPR Art. 17)
**Endpoint**: not yet exposed over HTTP — soft-delete the student (`DELETE /api/students/:studentId`); `piiAnonymizationScheduler` clears PII once `STUDENT_PII_RETENTION_DAYS` has passed
- Anonymises a student without breaking financial reports or audit chains
- Replaces name with `Former student [studentId]`
- Nulls parentEmail and parentPhone fields
- Keeps payment amounts, transaction hashes, and fee history intact for compliance
- **Not reversible**: Once anonymised, the student record cannot be restored
- **Audit logged**: Every anonymisation is recorded

### Right to Rectification (GDPR Art. 16)
**Endpoint**: `PATCH /api/students/:id` (admin-only)
- Allows correction of inaccurate personal data (name, class, contact details)
- **Audit logged**: All updates are recorded with before/after values

### Right to Data Portability (GDPR Art. 20)
- Same as Right of Access (operator-handled export; no HTTP endpoint yet)
- Data is returned in machine-readable JSON format

### Right to Restrict Processing
- **Soft delete**: `DELETE /api/students/:id` — sets `deletedAt`, excludes from queries
- Student can be restored within 30 days via `POST /api/students/:id/restore`

### Right to Object (GDPR Art. 21)
- Parents can opt out of reminders via the `reminderOptOut` field
- **Endpoint**: `PATCH /api/students/:id` with `reminderOptOut: true`

## 5. PII Minimization in Logs

The platform applies automatic PII redaction to all application logs:

### Redacted Fields
- Email addresses → Masked (e.g., `u***@example.com`)
- Phone numbers → Masked (e.g., `****7890`)
- Names → Masked (e.g., `J*** S.`)
- Student IDs, memos, wallet addresses → `[REDACTED]`

### IP Address Hashing
- IP addresses are hashed using HMAC-SHA256 with a per-boot secret
- Same IP produces same hash within a server session (for correlation)
- Hashes are not reversible and do not persist across server restarts

### Query String Stripping
- Query strings are stripped from logged URLs to prevent token/secret leakage
- Example: `/api/payments?token=abc123` → `/api/payments`

### Secrets Redaction
- All environment variables matching `/(SECRET|PASSWORD|TOKEN|KEY|URI|HASH)$/i` are redacted in config dumps
- Credentials embedded in URIs (e.g., `mongodb://user:pass@host`) are redacted

## 6. Encryption at Rest

### Student PII
- `parentEmail` and `parentPhone` are encrypted at rest using AES-256-GCM
- Encryption key: `STUDENT_PII_ENCRYPTION_KEY` (must be 32 bytes, base64-encoded)
- Key rotation: Supported via key versioning (see `studentPiiEncryption.js`)

### Webhook Secrets
- School webhook secrets are encrypted using `WEBHOOK_SECRET_ENCRYPTION_KEY`
- Supports key rotation with overlap period

### Passwords
- Admin and school operator passwords are hashed using bcrypt (work factor: 10)
- MFA secrets are encrypted at rest

## 7. Cross-Border Data Transfers

If the platform operates in a jurisdiction that requires cross-border transfer safeguards (e.g., EU to third countries):
- Ensure Standard Contractual Clauses (SCCs) are in place with cloud providers
- Document the transfer in your data processing records
- Include transfer details in your privacy policy shown to parents

## 8. Scheduled Cleanup Jobs

The platform runs background jobs (leader-only) to enforce retention policies:

### Student Anonymisation Job
- **Frequency**: Daily
- **Action**: Anonymises soft-deleted students older than 30 days
- **Audit**: Logs each anonymisation

### Reminder Log Cleanup Job
- **Frequency**: Daily
- **Action**: Deletes reminder logs older than 12 months
- **Audit**: Logs count of deleted records

### Email Delivery Log Cleanup Job
- **Frequency**: Daily
- **Action**: Deletes email delivery logs older than 12 months
- **Audit**: Logs count of deleted records

### Payment Record Pseudonymisation Job
- **Frequency**: Monthly
- **Action**: Pseudonymises payment records older than 7 years
- **Audit**: Logs count of pseudonymised records

### Audit Log Cleanup Job
- **Frequency**: Daily
- **Action**: Deletes audit logs older than `AUDIT_LOG_RETENTION_DAYS`
- **Audit**: Logs count of deleted records (in application log, not audit log)

## 9. Data Breach Procedures

In the event of a data breach:

1. **Detection**: Security monitoring and alerting must be configured (see `docs/security.md`)
2. **Containment**: Follow incident response runbook to isolate affected systems
3. **Assessment**: Determine which personal data was accessed/disclosed
4. **Notification**: 
   - Notify data protection authority within 72 hours (GDPR requirement)
   - Notify affected individuals if high risk to rights and freedoms
5. **Documentation**: Record the breach, its effects, and remediation in the audit log

## 10. Operator Responsibilities

School operators using this platform must:

1. **Obtain consent** from parents for collecting and processing their children's data
2. **Provide a privacy notice** to parents explaining how their data is used
3. **Handle data subject requests** within statutory timeframes (30 days for GDPR)
4. **Configure retention periods** appropriate for their jurisdiction
5. **Secure the `STUDENT_PII_ENCRYPTION_KEY`** and other encryption keys (use secrets manager, not env files)
6. **Monitor logs and alerts** for security incidents
7. **Back up data** regularly, ensuring backups also respect retention periods
8. **Delete or anonymise data** when the lawful basis expires (e.g., student leaves school)

## 11. Updates to This Policy

This document will be updated when:
- New data processing activities are introduced
- Retention periods are changed
- Regulatory requirements change
- Data subject rights procedures are modified

**Last updated**: 2026-09-27
**Version**: 1.0
