# NSUT Central Identity & Access Control (ACL) Service

> One login for every NSUT portal. One directory of who is who. One permissions engine deciding what each person can do in each app.

**Status:** Draft v0.1
**Apps in scope (initial):** CRAS, Hajiri, Events

---

# Part 1 — Product Spec

## 1.1 Problem

Every campus app today (or in the future) has to solve the same problems on its own:

- A separate `users` table and login flow per app.
- Student/faculty data (branch, semester, section) duplicated and drifting out of sync.
- Roles hard-coded per app, with no single place to see "what can this person do across campus?"
- Onboarding a new app means rebuilding auth from scratch.

## 1.2 Vision

A single **Identity & ACL Service** that acts as the campus source of truth. Any campus app delegates to it to answer:

1. **Identity:** "Who is this person at NSUT?"
2. **Access control:** "What role and permissions do they have in *this* application?"

## 1.3 Goals

- Single sign-on via Google using `@nsut.ac.in` accounts only.
- One master profile per person, with campus classification and academic/department details.
- Per-application roles, permissions, and resource scopes.
- Fast onboarding of new apps (register, define roles, integrate).
- Central admin console and a full audit trail.

## 1.4 Non-Goals (v1)

- Not a replacement for the official university ERP/records system. It consumes and mirrors data, it does not own academic records.
- No password-based login; Google SSO only.
- No in-app business logic (bookings, attendance, etc.). Apps own that.
- No support for non-NSUT Google accounts (guests, alumni) in v1.

## 1.5 Users & Personas

| Persona | Needs |
|---|---|
| **Student** | Log in once, access all apps with correct view-level access. |
| **Student Rep / Class Rep** | Elevated, *scoped* permissions (e.g. book rooms only for own branch/section). |
| **Faculty** | Faculty-level permissions in apps (reserve halls, mark attendance). |
| **Staff** | Limited operational access. |
| **Super Admin** | Manage the directory, register apps, assign roles, view audit logs. |
| **App Admin** | Manage roles/assignments for *one* app only (e.g. CRAS admin). |
| **App Developer** | Integrate an app quickly with clear docs and a stable contract. |

## 1.6 Core Concepts

### A. Master User Profile (who they are)

| Group | Fields |
|---|---|
| **Identity** | Name, `@nsut.ac.in` email, Google profile ID, avatar |
| **Campus type** | `STUDENT`, `FACULTY`, `STAFF`, `ADMIN` |
| **Student details** | Roll number, degree, branch, batch year, semester, section, group |
| **Faculty details** | Department, designation, employee ID |

### B. Registered Applications (where they can go)

| App key | Description |
|---|---|
| `CRAS` | Campus Room Allocation System |
| `HAJIRI` | Attendance Tracking System |
| `EVENTS` | College events & society bookings |
| *future* | Any new campus software |

### C. Roles & Permissions per Application (what they can do)

**CRAS**

| Role | Capabilities |
|---|---|
| `ADMIN` | Manage rooms, import timetables, view audit logs |
| `FACULTY` | Reserve faculty-only halls, cancel class slots |
| `STUDENT_REP` | Book classrooms for assigned branch/section, transfer slots |
| `VIEWER` | View schedules, check room availability |

**Hajiri**

| Role | Capabilities |
|---|---|
| `TEACHER` | Mark attendance, download reports |
| `CLASS_REP` | Log proxy/duty leaves |
| `STUDENT` | View personal attendance percentages |

### D. User-to-App Permission Mapping (the ACL matrix)

Each assignment binds **user + app + role + resource scope**.

```text
User: Vasu Goel (2021uca1808@nsut.ac.in)
├── App: CRAS (Room Allocation)
│   ├── Role: STUDENT_REP
│   ├── Permissions: [rooms:book, bookings:transfer]
│   └── Resource Scope: Branch CSAI, Section 1, Semester 6
│
└── App: Hajiri (Attendance)
    ├── Role: STUDENT
    ├── Permissions: [attendance:view]
    └── Resource Scope: Roll No 2021UCA1808
```

> **Naming convention:** permissions are `resource:action` (e.g. `bookings:transfer`). The original draft mixed `slots:transfer` and `bookings:transfer`; this spec standardises on `bookings:transfer`. Confirm with CRAS.

## 1.7 Key User Flows

### Flow 1: Login to any app
1. User opens an app (e.g. CRAS) and clicks **Login with Google**.
2. App redirects to the Identity service; user authenticates with their `@nsut.ac.in` Google account.
3. Identity service checks the master directory and the user's role for that app.
4. User lands back in the app, logged in with the correct role and scope. No separate signup.

### Flow 2: First-time user (not yet in directory)
- Email domain valid but no profile exists: auto-provision a profile (default type inferred from email pattern or bulk import) with **no app roles** beyond default `VIEWER`/`STUDENT` where the app defines one.
- Admin can later enrich or correct the profile.

### Flow 3: Admin assigns a role
1. App Admin opens the admin console, selects the user and app.
2. Picks a role and, if required, a resource scope.
3. Change takes effect on the user's next token refresh (or immediately on revocation, see §2.9).
4. Change is written to the audit log.

### Flow 4: Register a new app
1. Super Admin registers the app (key, name, redirect URIs, owners).
2. Defines the app's permissions and roles.
3. Receives client credentials; app developer integrates using the standard SDK/contract.

### Flow 5: Semester rollover
- Bulk job updates semester/batch for students; scope-bound assignments (e.g. "Semester 6 rep") are flagged for review or auto-expired.

## 1.8 Product Requirements

**Must have (v1)**
- Google SSO restricted to `@nsut.ac.in` (via hosted-domain check *and* server-side verification).
- Master profile CRUD, bulk CSV import.
- App registry, role and permission definitions.
- User-to-app role assignment with resource scopes.
- Standard login response (user, role, permissions, scope).
- Admin console with audit log.
- Integrations for CRAS first, Hajiri second.

**Should have**
- Role assignment expiry dates (e.g. rep for a semester).
- Delegated app admins.
- Self-service profile view ("my apps and my access").

**Could have**
- Approval workflows for elevated roles.
- Alumni/guest accounts.
- Notifications on role changes.

## 1.9 Success Metrics

- Number of apps onboarded; time to onboard a new app (target: under 1 day).
- % of campus apps using central login.
- p95 login latency, auth service uptime.
- Reduction in per-app user-management code and support requests.
- Profile data accuracy (% matching official records after import).

## 1.10 Risks

| Risk | Mitigation |
|---|---|
| Single point of failure for all apps | HA deployment, token-based offline validation by apps, caching |
| Stale academic data | Scheduled sync/import, semester rollover job, admin overrides |
| Over-privileged roles | Least-privilege defaults, expiry, audit, periodic access review |
| Privacy of student data | Minimal-claim tokens, per-app data scoping, access logging |

---

# Part 2 — Technical Spec

## 2.1 Architecture Overview

```text
┌────────────┐     ┌────────────┐     ┌────────────┐
│   CRAS     │     │   Hajiri   │     │   Events   │   ... campus apps
└─────┬──────┘     └─────┬──────┘     └─────┬──────┘
      │  OIDC / token verify via JWKS         │
      ▼                  ▼                    ▼
┌──────────────────────────────────────────────────┐
│          Identity & ACL Service (API)            │
│  Auth (Google OIDC) │ Directory │ App Registry   │
│  Roles/Permissions  │ ACL Engine │ Audit         │
└───────┬───────────────────┬──────────────┬───────┘
        │                   │              │
   ┌────▼─────┐       ┌─────▼────┐   ┌─────▼─────┐
   │ Postgres │       │  Redis   │   │ Queue     │
   │ (source  │       │ (cache,  │   │ (imports, │
   │ of truth)│       │ sessions,│   │ sync,     │
   └──────────┘       │ revoke)  │   │ audit)    │
                      └──────────┘   └───────────┘
                           ▲
                  ┌────────┴────────┐
                  │  Admin Console  │
                  └─────────────────┘
```

**Suggested stack:** Node.js (TypeScript) + Fastify/Express, PostgreSQL, Redis, BullMQ for async jobs, React admin console. Any equivalent stack works; the contracts below are what matter.

## 2.2 Authentication Design

### Approach
The service acts as an **OpenID Connect provider for campus apps**, and as an **OIDC client of Google**.

- **Upstream:** Google OAuth 2.0 / OIDC, Authorization Code flow with PKCE.
- **Downstream:** Each campus app is a registered OIDC client using Authorization Code + PKCE against this service.

### Domain restriction
- Request with `hd=nsut.ac.in` as a UX hint only.
- **Always verify server-side:** validate the ID token signature, `iss`, `aud`, `exp`, `email_verified`, and that `hd == "nsut.ac.in"` and the email ends with `@nsut.ac.in`. Never trust the client-side hint.

### Login sequence

```text
User → App: click "Login with Google"
App  → ACL: /authorize?client_id=CRAS&redirect_uri=...&code_challenge=...
ACL  → Google: redirect for authentication
Google → ACL: auth code
ACL  → Google: exchange code, verify ID token, enforce domain
ACL: upsert/lookup master profile, resolve CRAS role + scope
ACL  → App: redirect with authorization code
App  → ACL: /token (code + verifier)
ACL  → App: access token (JWT), refresh token, id token
```

## 2.3 Token Design

### Access token (JWT, short-lived: 10–15 min, signed RS256/ES256)

```json
{
  "iss": "https://id.nsut.example",
  "sub": "usr_01HZX...",
  "aud": "CRAS",
  "exp": 1760000000,
  "iat": 1759999100,
  "jti": "tok_...",
  "email": "2021uca1808@nsut.ac.in",
  "type": "STUDENT",
  "role": "STUDENT_REP",
  "permissions": ["rooms:book", "bookings:transfer"],
  "scope": { "branch": "CSAI", "section": 1, "semester": 6 },
  "ver": 14
}
```

- Tokens are **audience-bound** to a single app; a CRAS token must be rejected by Hajiri.
- `ver` = the user's ACL version; incremented on any role/profile change (used for revocation, §2.9).
- Keep PII in tokens minimal. Apps needing more call `/userinfo`.

### Refresh tokens
- Opaque, stored hashed in DB, rotated on use, with reuse detection.
- Bound to user + app + device/session.

### Verification by apps
- Apps validate JWTs **locally** using the public keys from `/.well-known/jwks.json` (cached, with key rotation via `kid`).
- Optional: call `/introspect` for high-risk operations.

## 2.4 Standard Response Contract

The login/userinfo response given to an app (as in the original design):

```json
{
  "user": {
    "id": "usr_01HZX...",
    "name": "Vasu Goel",
    "email": "2021uca1808@nsut.ac.in",
    "type": "STUDENT",
    "academic": {
      "roll_no": "2021UCA1808",
      "branch": "CSAI",
      "semester": 6,
      "section": 1
    }
  },
  "app": "CRAS",
  "role": "STUDENT_REP",
  "permissions": ["rooms:book", "bookings:transfer"],
  "allowed_scope": { "branch": "CSAI", "section": 1 }
}
```

## 2.5 Data Model (PostgreSQL)

```sql
-- Master identity
CREATE TABLE users (
  id               TEXT PRIMARY KEY,               -- usr_<ulid>
  email            CITEXT UNIQUE NOT NULL,         -- must end with @nsut.ac.in
  google_sub       TEXT UNIQUE,                    -- Google profile ID
  name             TEXT NOT NULL,
  avatar_url       TEXT,
  user_type        TEXT NOT NULL CHECK (user_type IN ('STUDENT','FACULTY','STAFF','ADMIN')),
  status           TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | SUSPENDED | ARCHIVED
  acl_version      INT  NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE student_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  roll_no      TEXT UNIQUE NOT NULL,
  degree       TEXT NOT NULL,
  branch       TEXT NOT NULL,
  batch_year   INT  NOT NULL,
  semester     INT  NOT NULL,
  section      INT,
  group_no     INT
);

CREATE TABLE faculty_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_id  TEXT UNIQUE NOT NULL,
  department   TEXT NOT NULL,
  designation  TEXT NOT NULL
);

-- App registry
CREATE TABLE applications (
  id             TEXT PRIMARY KEY,                 -- e.g. CRAS, HAJIRI, EVENTS
  name           TEXT NOT NULL,
  client_secret_hash TEXT,
  redirect_uris  TEXT[] NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_permissions (
  app_id       TEXT REFERENCES applications(id) ON DELETE CASCADE,
  permission   TEXT NOT NULL,                      -- e.g. rooms:book
  description  TEXT,
  PRIMARY KEY (app_id, permission)
);

CREATE TABLE app_roles (
  app_id       TEXT REFERENCES applications(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,                      -- e.g. STUDENT_REP
  description  TEXT,
  PRIMARY KEY (app_id, role)
);

CREATE TABLE role_permissions (
  app_id       TEXT,
  role         TEXT,
  permission   TEXT,
  PRIMARY KEY (app_id, role, permission),
  FOREIGN KEY (app_id, role)       REFERENCES app_roles(app_id, role) ON DELETE CASCADE,
  FOREIGN KEY (app_id, permission) REFERENCES app_permissions(app_id, permission) ON DELETE CASCADE
);

-- The ACL matrix
CREATE TABLE user_app_roles (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id       TEXT NOT NULL,
  role         TEXT NOT NULL,
  scope        JSONB NOT NULL DEFAULT '{}',        -- {branch, section, semester, roll_no, ...}
  granted_by   TEXT REFERENCES users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  FOREIGN KEY (app_id, role) REFERENCES app_roles(app_id, role),
  UNIQUE (user_id, app_id, role, scope)
);

-- Optional per-user permission overrides
CREATE TABLE user_permission_overrides (
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  app_id      TEXT,
  permission  TEXT,
  effect      TEXT CHECK (effect IN ('ALLOW','DENY')),
  PRIMARY KEY (user_id, app_id, permission)
);

-- Sessions / refresh tokens
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  app_id          TEXT,
  refresh_hash    TEXT NOT NULL,
  family_id       TEXT NOT NULL,                   -- for reuse detection
  user_agent      TEXT,
  ip              INET,
  created_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);

-- Audit log (append-only)
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,                       -- ROLE_GRANTED, LOGIN, PROFILE_UPDATED...
  target_type TEXT,
  target_id   TEXT,
  app_id      TEXT,
  metadata    JSONB,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON user_app_roles (user_id, app_id);
CREATE INDEX ON audit_logs (target_id, created_at DESC);
```

## 2.6 Authorization Model

**Model:** RBAC with scoped resources (a light ABAC layer).

- **Role → permissions** is defined per app (`role_permissions`).
- **Scope** limits *which resources* the permissions apply to (branch/section/semester/roll no).
- **Overrides** allow rare per-user ALLOW/DENY exceptions.

**Effective permissions resolution:**

```text
effective = union(permissions of all active roles for (user, app))
            + ALLOW overrides − DENY overrides
scope     = merged scopes of the roles that granted each permission
```

**Enforcement split:**
- **ACL service** decides *what the user can do* and issues it in the token.
- **Each app** enforces it, and checks that the *requested resource* falls inside `allowed_scope` (e.g. CRAS verifies the room booking is for section 1 of CSAI). The service does not know app resources, so the app does the final scope check.
- Provide a shared **middleware/SDK** (`requirePermission('rooms:book')`, `inScope(resource)`) so apps do not reimplement this.

## 2.7 API Surface

### Auth / OIDC
| Method | Path | Purpose |
|---|---|---|
| GET | `/authorize` | Start login (OIDC auth code + PKCE) |
| POST | `/token` | Exchange code / refresh token |
| GET | `/userinfo` | Standard response contract (§2.4) |
| POST | `/introspect` | Validate a token (confidential clients) |
| POST | `/revoke` | Revoke a refresh token/session |
| POST | `/logout` | End session (+ optional global logout) |
| GET | `/.well-known/openid-configuration` | Discovery |
| GET | `/.well-known/jwks.json` | Public signing keys |

### Directory (admin)
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/v1/users` | List/create users |
| GET/PATCH | `/v1/users/:id` | Read/update profile |
| POST | `/v1/users/import` | Bulk CSV import (async job) |
| POST | `/v1/users/rollover` | Semester rollover job |

### Apps & roles (admin)
| Method | Path | Purpose |
|---|---|---|
| POST/GET | `/v1/apps` | Register/list apps |
| PUT | `/v1/apps/:app/permissions` | Define permissions |
| PUT | `/v1/apps/:app/roles` | Define roles and their permissions |

### ACL assignment
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/users/:id/apps/:app/roles` | Grant a role (with scope, optional expiry) |
| DELETE | `/v1/users/:id/apps/:app/roles/:assignmentId` | Revoke |
| GET | `/v1/users/:id/access` | Full access summary across apps |
| POST | `/v1/authorize/check` | Server-side check: `{user, app, permission, scope}` to allow/deny |

### Audit
| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/audit` | Query audit log (filters: actor, target, app, time) |

## 2.8 Integration Guide (for app developers)

1. Get registered: provide app key, redirect URIs, owner team; receive `client_id` (+ secret for server-side apps).
2. Define the app's permissions and roles (via admin console or API).
3. Implement login using any OIDC client library against the discovery URL.
4. Verify JWTs locally using JWKS; check `aud` equals your app key.
5. Use the SDK middleware for permission and scope checks.
6. Do **not** keep a separate users table for auth. Keep only a local reference by `sub` (user id) for your own data (bookings, attendance), and fetch profile details via `/userinfo` or cache with a short TTL.

## 2.9 Revocation & Freshness

Short-lived JWTs mean role changes can lag up to the token lifetime. Options, in order of increasing strictness:

1. **Wait for expiry** (10–15 min). Fine for low-risk apps.
2. **`ver` check:** the service publishes the latest `acl_version` per user (Redis + a lightweight `/acl-version/:sub` endpoint or pub/sub). Apps compare the token's `ver`.
3. **Introspection** on sensitive endpoints.
4. **Deny-list by `jti`** in Redis for emergency revocation (suspended user).

Every role/profile change bumps `users.acl_version`.

## 2.10 Security Requirements

- Enforce `@nsut.ac.in` domain server-side; verify Google ID token fully.
- Authorization Code + PKCE only; no implicit flow; exact-match redirect URI validation.
- Asymmetric JWT signing with key rotation (`kid`); private keys in a KMS/secret manager.
- Hash client secrets and refresh tokens at rest; rotate refresh tokens with reuse detection.
- Rate limiting and brute-force protection on `/token` and `/authorize`.
- Admin actions require elevated role, optionally MFA/step-up; all changes audited (append-only).
- Principle of least privilege: new users get minimal/default roles only.
- CSRF `state` and OIDC `nonce` validated on every login.
- Encrypt in transit (TLS) and at rest; restrict DB access; backups with tested restore.
- Privacy: tokens carry minimum claims; apps only receive profile fields they are entitled to (per-app claim mapping); access to profile data is logged.
- Compliance with applicable Indian data-protection requirements for student data (confirm with the college).

## 2.11 Async Jobs

| Job | Trigger | Notes |
|---|---|---|
| Bulk user import | Admin upload | Validate, dedupe by email/roll no, report row-level errors |
| Semester rollover | Admin / scheduled | Increment semester, handle graduating batch, flag expiring scoped roles |
| Role expiry sweep | Scheduled | Remove expired `user_app_roles`, bump `acl_version` |
| Audit export/archival | Scheduled | Move old logs to cold storage |

## 2.12 Non-Functional Requirements

- **Availability:** target 99.9%; run at least 2 instances behind a load balancer; apps keep working on valid tokens if the service is briefly down.
- **Performance:** p95 `/token` under 300 ms; `/userinfo` under 100 ms (cache role resolution in Redis, invalidate on `acl_version` bump).
- **Scalability:** stateless API; Postgres primary + read replica as needed. Campus scale (tens of thousands of users) is modest.
- **Observability:** structured logs, metrics (login success/fail, latency, token errors), alerting on auth failure spikes.
- **Testing:** unit tests for permission resolution, integration tests for OIDC flow, contract tests for the response schema, security tests on redirect/PKCE handling.

## 2.13 Admin Console (minimum)

- Directory: search/filter users, edit profile, import CSV.
- Apps: register app, define permissions/roles, view assigned users.
- Assignments: grant/revoke roles with scope and expiry; bulk assign (e.g. "all section reps").
- Audit log viewer with filters.
- Access report per user: "what can this person do, and where?"

## 2.14 Rollout Plan

| Phase | Scope |
|---|---|
| **0: Foundations** | Schema, Google OIDC login with domain enforcement, JWKS/token issuance, user import |
| **1: CRAS integration** | Register CRAS, define roles/permissions, migrate CRAS users, SDK middleware, admin console MVP |
| **2: Hajiri integration** | Register Hajiri, class rep/teacher roles, scope by roll no/section |
| **3: Hardening** | Revocation (`ver`/introspection), audit viewer, rate limits, monitoring, HA |
| **4: Events + self-service** | Events app, role expiry, "my access" page, approval workflows |

**Migration note:** for existing apps, map current users to master profiles by email, run both auth paths briefly behind a flag, then cut over and remove the app-local users/login tables.

## 2.15 Open Questions

1. **Source of truth for student data:** where does the initial roster come from (ERP export, CSV from admin office)? How often does it refresh?
2. **Who may grant elevated roles** (e.g. `STUDENT_REP`)? Faculty advisor, app admin, or super admin only?
3. **Scope semantics:** do scopes support multiple values (a rep for two sections)? Proposal: scope values may be arrays.
4. **Multiple roles per app:** can one user hold both `FACULTY` and `ADMIN` in CRAS? Proposal: yes, permissions are the union.
5. **Email pattern vs directory:** can `type` (student/faculty) be reliably inferred from the email or roll number, or must it come from import only?
6. **Alumni/guests:** needed later? Impacts the domain restriction.
7. **Hosting and ownership:** who operates and is on call for this service long-term?
8. **Permission naming:** confirm the `resource:action` convention and the `bookings:transfer` vs `slots:transfer` decision for CRAS.

---

## Appendix A: Permission Catalog (starter)

| App | Role | Permissions |
|---|---|---|
| CRAS | `ADMIN` | `rooms:manage`, `timetable:import`, `audit:view`, `rooms:view` |
| CRAS | `FACULTY` | `halls:reserve`, `slots:cancel`, `rooms:view` |
| CRAS | `STUDENT_REP` | `rooms:book`, `bookings:transfer`, `rooms:view` |
| CRAS | `VIEWER` | `rooms:view`, `schedule:view` |
| HAJIRI | `TEACHER` | `attendance:mark`, `reports:download`, `attendance:view` |
| HAJIRI | `CLASS_REP` | `leaves:log`, `attendance:view` |
| HAJIRI | `STUDENT` | `attendance:view` (own only) |

## Appendix B: Summary

- One login for all NSUT portals via Google SSO.
- One central database storing who is a student, faculty member, or admin.
- One permissions engine deciding what each person can access in CRAS, Hajiri, or any other college app.
