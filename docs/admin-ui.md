# Admin UI

The admin UI lives in `frontend/src/pages`. Every admin route is listed once in
`frontend/src/config/routes.js` (`ADMIN_ROUTES`) and is wrapped centrally in
`RequireAdmin` by `_app.jsx` (#1579); navigation for both the top bar and the
sidebar comes from `frontend/src/config/navigation.js` (#1580).

## Role-based permissions

Screens read the user's roles from `/api/auth/me` and hide or disable actions
the user cannot perform (`frontend/src/utils/permissions.js`, `usePermissions`).
The map mirrors the backend guards — the backend remains authoritative.

| Permission | Roles | Backend guard |
|------------|-------|---------------|
| `students.read`, `payments.read`, `users.read` | owner, staff, read_only | `requireSchoolAuth([...])` |
| `students.write`, `payments.write`, `reminders.manage` | owner, staff | `requireSchoolAuth(['owner','staff'])` |
| `refunds.write`, `users.manage` | owner | `requireSchoolAuth(['owner'])` |
| `settings.write`, `sessions.manage`, `paymentPlans.write` | super-admin only | `requireAdminAuth` |

Super-admins (`roles: ['super_admin']` or the legacy `role: 'admin'`) pass every
check.

## Screens (#1581)

| Route | What operators can do | API |
|-------|-----------------------|-----|
| `/students` | List/search/filter, register, bulk CSV import, CSV export, soft-delete and restore, archived fee history, reconcile balance, reset payment status, reminder opt-out, edit + payment plan (via the student form) | `/api/students*`, `/api/payment-plans/:studentId`, `/api/reminders/opt-out` |
| `/payments` | All payments with filters, suspicious review (clear / confirm fraud), pending-confirmation, stuck and overpaid views, manual status override with reason, initiate refund, trigger sync | `/api/payments*` |
| `/refunds` | List refunds, approve (owner, four-eyes) | `/api/payments/refunds*` |
| `/reminders` | Preview due reminders, send now, opt students out | `/api/reminders/*` |
| `/webhooks` | Manage webhook endpoints and deliveries | `/api/webhook-endpoints`, `/api/webhook-deliveries` |
| `/settings` | School profile (wallet change needs step-up password), runtime settings, payment limits and accepted assets, school users (invite, roles, activate/deactivate) | `/api/schools/:id*`, `/api/schools/:id/users*`, `/api/payments/limits`, `/api/payments/accepted-assets` |
| `/security` | MFA enrolment (links to `/mfa-setup`), active sessions and revocation | `/api/auth/mfa/*`, `/api/auth/sessions*` |

Also available: `/dashboard`, `/reports`, `/fees`, `/fee-adjustments`,
`/analytics`, `/disputes`, `/source-validation-rules`, `/audit-logs`.

## Adding a screen

1. Create the page in `frontend/src/pages`.
2. Add its path to `ADMIN_ROUTES` (guard, noindex, layout) and an entry to
   `NAV_ITEMS` with `audience: 'admin'`; add it to `public/robots.txt`.
3. Gate write actions with `usePermissions()` and add the permission to
   `utils/permissions.js` if it is new.
4. Add en + fr strings (fr must mirror en key-for-key) and a component test
   under `frontend/src/__tests__/pages/`.
