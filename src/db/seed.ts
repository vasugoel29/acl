import { fileURLToPath } from 'node:url';
import { pool, tx } from './pool.js';
import { config } from '../config.js';
import { newId } from '../util.js';
import { isDomainAllowed } from '../auth/google.js';
import { seedMasterData, backfillUserReferences } from './masterData.js';

interface RoleDef {
  perms: string[];
  isDefault?: boolean;
  defaultScope?: Record<string, string>;
  description?: string;
}
interface AppDef {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  roles: Record<string, RoleDef>;
  resources?: Record<string, string>;
}

/** Starter catalog (spec Appendix A) plus the internal ACL app used by the admin console. */
export const CATALOG: AppDef[] = [
  {
    id: config.internalAppId,
    clientId: config.internalClientSlug,
    name: 'Identity & ACL Admin Console',
    redirectUris: Array.from(new Set(['http://localhost:5173/callback', `${config.consoleUrl}/callback`])),
    roles: {
      SUPER_ADMIN: {
        perms: ['users:read', 'users:write', 'users:import', 'users:export', 'apps:manage', 'roles:assign', 'audit:view', 'admin:all'],
        description: 'Full control of the directory, apps and assignments',
      },
      // Scoped to specific apps via scope {app: [...]}
      APP_ADMIN: { perms: ['users:read', 'roles:assign', 'audit:view'], description: 'Manage roles for specific apps only' },
    },
  },
  {
    id: 'app_01JCRAS0000000000000000000',
    clientId: 'CRAS',
    name: 'Campus Room Allocation System',
    redirectUris: ['http://localhost:3001/callback'],
    resources: {
      'cras.calendar': 'See the rooms calendar: availability and who holds a slot (never the purpose). Read-only on its own.',
      'cras.timetable': 'See your own timetable: your section\'s classes, or the classes you teach.',
      'cras.bookings': 'The Bookings tab and everything a booker does: request a room, manage transfers, reschedules, and cancellations.',
      'cras.bookings.direct': 'Bookings take effect immediately with no faculty approval, including restricted rooms (committee rooms, auditorium).',
      'cras.faculty_portal': 'Approve or reject booking requests, review class-cancellation requests, and manage personal classes.',
      'cras.admin': 'Full Admin Console: Quick Book, timetable search/import/export, user/room management, analytics, and audit log.',
    },
    roles: {
      ADMIN: {
        perms: ['cras.calendar', 'cras.timetable', 'cras.bookings', 'cras.bookings.direct', 'cras.admin'],
        description: 'Full CRAS Admin Console access',
      },
      FACULTY: {
        perms: ['cras.calendar', 'cras.timetable', 'cras.bookings.direct', 'cras.faculty_portal'],
        description: 'Faculty Portal and direct room bookings without approval',
      },
      STUDENT_REP: {
        perms: ['cras.calendar', 'cras.timetable', 'cras.bookings'],
        description: 'Class representative room bookings and timetable',
      },
      VIEWER: {
        perms: ['cras.calendar', 'cras.timetable'],
        isDefault: true,
        description: 'Default student and viewer calendar and timetable access',
      },
    },
  },
];

export async function seed() {
  await tx(async (c) => {
    for (const app of CATALOG) {
      const res = await c.query(
        `INSERT INTO applications (id,client_id,name,redirect_uris) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET
           client_id = EXCLUDED.client_id,
           name = EXCLUDED.name,
           redirect_uris = CASE
             WHEN applications.id = $5 THEN ARRAY(SELECT DISTINCT unnest(applications.redirect_uris || EXCLUDED.redirect_uris))
             ELSE applications.redirect_uris
           END
         RETURNING (xmax = 0) AS is_new`,
        [app.id, app.clientId, app.name, app.redirectUris, config.internalAppId],
      );
      const isNew = res.rows[0]?.is_new ?? false;
      // Seed or update roles with permissions directly in app_roles
      const catalog: Record<string, string> = { ...(app.resources || {}) };
      for (const [role, def] of Object.entries(app.roles)) {
        await c.query(
          `INSERT INTO app_roles (app_id, role, permissions, description, is_default, default_scope)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (app_id, role) DO UPDATE SET
             permissions = EXCLUDED.permissions,
             description = EXCLUDED.description,
             is_default = EXCLUDED.is_default,
             default_scope = EXCLUDED.default_scope`,
          [app.id, role, def.perms, def.description ?? null, def.isDefault ?? false, def.defaultScope ?? {}],
        );
        for (const p of def.perms) {
          if (!catalog[p]) catalog[p] = `${p} permission`;
        }
      }
      if (app.clientId === 'CRAS') {
        await c.query(
          `UPDATE applications
           SET permissions_catalog = $1::jsonb
           WHERE id = $2`,
          [JSON.stringify(catalog), app.id],
        );
        await c.query(`DELETE FROM app_resources WHERE app_id = $1 AND permission NOT LIKE 'cras.%'`, [app.id]);
      } else {
        await c.query(
          `UPDATE applications
           SET permissions_catalog = COALESCE(permissions_catalog, '{}'::jsonb) || $1::jsonb
           WHERE id = $2`,
          [JSON.stringify(catalog), app.id],
        );
      }

      // Seed permissions into app_resources table
      for (const [perm, desc] of Object.entries(catalog)) {
        await c.query(
          `INSERT INTO app_resources (app_id, permission, description)
           VALUES ($1, $2, $3)
           ON CONFLICT (app_id, permission) DO UPDATE SET description = EXCLUDED.description`,
          [app.id, perm, desc],
        );
      }
    }

    // Master reference data (departments, degrees, branches, programs, designations)
    await seedMasterData(c);
    const report = await backfillUserReferences(c);
    if (report.unmapped.length) {
      console.warn('master-data backfill: unmapped legacy values', report.unmapped);
    }

    // Bootstrap super admin
    const email = config.bootstrapAdminEmail?.toLowerCase();
    if (email) {
      if (!isDomainAllowed(email)) {
        throw new Error(`Bootstrap admin email domain not allowed: ${email}`);
      }
      const uRes = await c.query(
        `INSERT INTO users (id,email,name) VALUES ($1,$2,$3)
         ON CONFLICT (email) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [newId('usr'), email, email.split('@')[0]],
      );
      const userId = uRes.rows[0].id;

      const existingSuperAdmin = await c.query(
        `SELECT 1 FROM user_app_roles
         WHERE app_id = $1 AND role = 'SUPER_ADMIN' AND (expires_at IS NULL OR expires_at > now())
         LIMIT 1`,
        [config.internalAppId],
      );
      if (existingSuperAdmin.rowCount === 0) {
        await c.query(
          `INSERT INTO user_app_roles (id,user_id,app_id,role,scope) VALUES ($1,$2,$3,'SUPER_ADMIN','{}')
           ON CONFLICT (user_id,app_id,role,scope) DO NOTHING`,
          [newId('uar'), userId, config.internalAppId],
        );
      }
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed().then(() => {
    console.log('seeded');
    return pool.end();
  });
}
