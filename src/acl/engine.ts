/**
 * ACL engine: effective-permission resolution (spec §2.6).
 *
 *   effective = union(perms of active roles) + ALLOW overrides - DENY overrides
 *
 * Scope semantics:
 *  - A scope is a map key -> value | value[]. Empty scope = unrestricted for that role.
 *  - Per permission we keep the list of granting scopes ("alternatives"); a resource is
 *    allowed if it fits ANY alternative (precise check, used by /authorize/check).
 *  - The token-level `scope` is the per-key union over all scoped roles (informational
 *    summary; apps needing precision should use `scopes_by_permission` / the check API).
 */
import { pool, type Queryable } from '../db/pool.js';

export type ScopeValue = string | number | Array<string | number>;
export type Scope = Record<string, ScopeValue>;

export interface RoleGrant {
  role: string;
  scope: Scope;
}

export interface ResolveInput {
  grants: RoleGrant[];
  rolePermissions: Record<string, string[]>;
  overrides: Array<{ permission: string; effect: 'ALLOW' | 'DENY' }>;
}

export interface EffectiveAccess {
  role: string | null;
  roles: string[];
  permissions: string[];
  scope: Scope;
  scopes_by_permission: Record<string, Scope[]>;
}

const asArray = (v: ScopeValue) => (Array.isArray(v) ? v : [v]);

export const FORBIDDEN_SCOPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const SAFE_DEFAULT_SCOPE_FIELDS = new Set([
  'dept',
  'branch',
  'degree',
  'roll_no',
  'year',
  'semester',
  'section',
  'group_no',
  'batch_no',
  'batch_year',
  'employee_id',
  'designation',
]);

export function mergeScopes(scopes: Scope[]): Scope {
  const out: Record<string, Array<string | number>> = Object.create(null);
  for (const s of scopes) {
    for (const [k, v] of Object.entries(s)) {
      if (FORBIDDEN_SCOPE_KEYS.has(k)) continue;
      const set = (out[k] ??= []);
      for (const x of asArray(v)) if (!set.includes(x)) set.push(x);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length === 1 ? v[0] : v]));
}

export function resolveEffective(input: ResolveInput): EffectiveAccess {
  const byPerm = new Map<string, Scope[]>();
  for (const g of input.grants) {
    for (const p of input.rolePermissions[g.role] ?? []) {
      const list = byPerm.get(p) ?? [];
      list.push(g.scope);
      byPerm.set(p, list);
    }
  }
  for (const o of input.overrides) {
    if (o.effect === 'ALLOW' && !byPerm.has(o.permission)) byPerm.set(o.permission, [{}]);
    if (o.effect === 'DENY') byPerm.delete(o.permission);
  }
  const permissions = [...byPerm.keys()].sort();
  const scopedOnly = input.grants.map((g) => g.scope).filter((s) => Object.keys(s).length > 0);
  // Primary role = the one granting the most permissions (stable tie-break by name).
  const roles = [...new Set(input.grants.map((g) => g.role))];
  const role =
    [...roles].sort(
      (a, b) =>
        (input.rolePermissions[b]?.length ?? 0) - (input.rolePermissions[a]?.length ?? 0) || a.localeCompare(b),
    )[0] ?? null;
  return {
    role,
    roles,
    permissions,
    scope: mergeScopes(scopedOnly),
    scopes_by_permission: Object.fromEntries(byPerm),
  };
}

/** Does `resource` (key -> single value) fit inside `scope`? Empty scope matches everything. */
export function scopeAllows(scope: Scope, resource: Record<string, string | number>): boolean {
  for (const [k, allowed] of Object.entries(scope)) {
    if (FORBIDDEN_SCOPE_KEYS.has(k)) return false;
    if (!Object.prototype.hasOwnProperty.call(resource, k)) return false;
    if (!asArray(allowed).map(String).includes(String(resource[k]))) return false;
  }
  return true;
}

export function checkPermission(
  access: EffectiveAccess,
  permission: string,
  resource: Record<string, string | number> = {},
): boolean {
  if (!access?.scopes_by_permission || !Object.prototype.hasOwnProperty.call(access.scopes_by_permission, permission)) {
    return false;
  }
  const alternatives = access.scopes_by_permission[permission];
  if (!Array.isArray(alternatives)) return false;
  return alternatives.some((s) => scopeAllows(s, resource));
}

// ---------- DB-backed resolution ----------

export interface ResolvedForApp extends EffectiveAccess {
  implicitDefault: boolean;
}

export async function resolveForApp(userId: string, appId: string, db: Queryable = pool): Promise<ResolvedForApp> {
  const grantRows = await db.query<{ role: string; scope: Scope; permissions: string[] }>(
    `SELECT uar.role, uar.scope, ar.permissions
     FROM user_app_roles uar
     JOIN app_roles ar ON ar.app_id = uar.app_id AND ar.role = uar.role
     WHERE uar.user_id = $1 AND uar.app_id = $2
       AND (uar.expires_at IS NULL OR uar.expires_at > now())`,
    [userId, appId],
  );

  const rolePermissions: Record<string, string[]> = {};
  for (const r of grantRows.rows) {
    rolePermissions[r.role] = r.permissions ?? [];
  }

  let grants: RoleGrant[] = grantRows.rows.map((r) => ({ role: r.role, scope: r.scope }));
  let implicitDefault = false;

  if (grants.length === 0) {
    const defaults = await db.query<{ role: string; permissions: string[]; default_scope: Record<string, string> }>(
      `SELECT role, permissions, default_scope FROM app_roles WHERE app_id = $1 AND is_default = true`,
      [appId],
    );
    if (defaults.rows.length) {
      const u = (await db.query(`SELECT * FROM users WHERE id = $1`, [userId])).rows[0];
      grants = defaults.rows.map((d) => {
        rolePermissions[d.role] = d.permissions ?? [];
        const scope: Scope = {};
        for (const [k, field] of Object.entries(d.default_scope ?? {})) {
          if (FORBIDDEN_SCOPE_KEYS.has(k) || !SAFE_DEFAULT_SCOPE_FIELDS.has(field)) continue;
          if (u?.[field] != null) scope[k] = u[field];
        }
        return { role: d.role, scope };
      });
      implicitDefault = true;
    }
  }

  return { ...resolveEffective({ grants, rolePermissions, overrides: [] }), implicitDefault };
}

export async function bumpAclVersion(userId: string, db: Queryable = pool): Promise<number> {
  const r = await db.query(
    `UPDATE users SET acl_version = COALESCE(acl_version, 1) + 1, updated_at = now() WHERE id = $1 RETURNING acl_version`,
    [userId],
  );
  return r.rows[0]?.acl_version ?? 1;
}
