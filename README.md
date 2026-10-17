# NSUT Identity & ACL Service

Central login (Google SSO, `@nsut.ac.in` and `@nsit.ac.in`), master directory and per-app permissions for NSUT campus apps. Implements [nsut-identity-acl-service.md](nsut-identity-acl-service.md).

## Run locally

```bash
docker compose up -d                 # Postgres (:5433) + Redis (:6379)
cp .env.example .env                 # set BOOTSTRAP_ADMIN_EMAIL=you@nsut.ac.in
npm install
npm run migrate && npm run seed      # schema + CRAS/ACL catalog + super admin
npm run dev                          # API on :4000 (queue worker runs inline)

cd admin-console && npm install && npm run dev   # console on :5173
```

Without `GOOGLE_CLIENT_ID` (and outside production) sign-in uses a **mock Google** page at `/dev/mock-google`
so you can log in as any `@nsut.ac.in` address. The mock still goes through the real domain/claim checks.
For real Google, set `GOOGLE_CLIENT_ID/SECRET` and register `${ISSUER}/auth/google/callback` as a redirect URI.

```bash
npm test          # unit + integration (uses database acl_test; create with: docker exec acl-postgres-1 psql -U acl -c "CREATE DATABASE acl_test")
npm run typecheck
```

## Layout

| Path | Purpose |
|---|---|
| `src/routes/oidc.ts` | `/authorize`, `/token`, `/userinfo`, `/introspect`, `/revoke`, `/logout`, discovery, JWKS, `/acl-version/:sub` |
| `src/routes/admin.ts` | Directory, apps/roles, assignments, `/v1/authorize/check`, audit |
| `src/acl/engine.ts` | Effective-permission + scope resolution |
| `src/tokens/` | ES256 keys/JWKS, access tokens, rotating refresh tokens |
| `src/jobs/` | BullMQ: CSV import, semester rollover, daily role-expiry sweep |
| `sdk/index.ts` | `createAclClient()` for app developers (JWKS verify, `requirePermission`, `inScope`) |
| `admin-console/` | React admin UI |

## Integrating an app

1. Super admin registers it (console → Applications) with exact redirect URIs. Public clients use PKCE; confidential ones also get a secret.
2. Define its roles/permissions (`PUT /v1/apps/:app/permissions`, `PUT /v1/apps/:app/roles`).
3. Log in with any OIDC library against `/.well-known/openid-configuration` (Authorization Code + PKCE `S256`).
4. Verify tokens locally with the SDK; the `aud` must equal your app key.

```ts
import { createAclClient } from './sdk/index.js';
const acl = createAclClient({ issuer: 'https://id.nsut.example', appId: 'CRAS' });
app.post('/book', acl.authenticate(), acl.requirePermission('rooms:book'), handler);
```

## Behaviour worth knowing

- **Scopes:** values may be arrays. The token's `scope` is a per-key union across scoped roles (a summary). For exact per-permission answers use `scopes_by_permission` from `/userinfo` or `POST /v1/authorize/check` (confidential apps only).
- **Default roles:** roles flagged `is_default` apply implicitly to users with no assignment in that app (e.g. CRAS `VIEWER`).
- **Revocation:** every role/profile change bumps `acl_version`; `/introspect` treats stale tokens as inactive; logout/revoke deny-lists the `jti`; suspending a user revokes all refresh tokens.
- **Admin API** accepts only tokens issued for the internal `ACL` app; `APP_ADMIN` is scoped to specific apps and cannot grant `ACL` roles.
- **Keys:** stored in `KEYS_FILE` (default `keys/signing.json`, git-ignored). Use a secret-manager mount in production.
