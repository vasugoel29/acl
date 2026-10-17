import { fileURLToPath } from 'node:url';
import { pool, tx } from './pool.js';
import { config } from '../config.js';
import { newId } from '../util.js';
import { isDomainAllowed } from '../auth/google.js';

interface RoleDef {
  perms: string[];
  isDefault?: boolean;
  defaultScope?: Record<string, string>;
  description?: string;
}
interface AppDef {
  id: string;
  name: string;
  redirectUris: string[];
  roles: Record<string, RoleDef>;
}

/** Starter catalog (spec Appendix A) plus the internal ACL app used by the admin console. */
export const CATALOG: AppDef[] = [
  {
    id: config.internalAppId,
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
    id: 'CRAS',
    name: 'Campus Room Allocation System',
    redirectUris: ['http://localhost:3001/callback'],
    roles: {
      ADMIN: { perms: ['rooms:manage', 'timetable:import', 'audit:view', 'rooms:view'] },
      FACULTY: { perms: ['halls:reserve', 'slots:cancel', 'rooms:view'] },
      STUDENT_REP: { perms: ['rooms:book', 'bookings:transfer', 'rooms:view'] },
      VIEWER: { perms: ['rooms:view', 'schedule:view'], isDefault: true },
    },
  },
];

export async function seed() {
  await tx(async (c) => {
    for (const app of CATALOG) {
      const res = await c.query(
        `INSERT INTO applications (id,name,redirect_uris) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET
           redirect_uris = CASE
             WHEN applications.id = $4 THEN ARRAY(SELECT DISTINCT unnest(applications.redirect_uris || EXCLUDED.redirect_uris))
             ELSE applications.redirect_uris
           END
         RETURNING (xmax = 0) AS is_new`,
        [app.id, app.name, app.redirectUris, config.internalAppId],
      );
      const isNew = res.rows[0]?.is_new ?? false;
      if (isNew) {
        const allPerms = new Set(Object.values(app.roles).flatMap((r) => r.perms));
        for (const p of allPerms) {
          await c.query(`INSERT INTO app_permissions (app_id,permission) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [app.id, p]);
        }
        for (const [role, def] of Object.entries(app.roles)) {
          await c.query(
            `INSERT INTO app_roles (app_id,role,description,is_default,default_scope) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (app_id,role) DO NOTHING`,
            [app.id, role, def.description ?? null, def.isDefault ?? false, def.defaultScope ?? {}],
          );
          for (const p of def.perms) {
            await c.query(`INSERT INTO role_permissions (app_id,role,permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [app.id, role, p]);
          }
        }
      }
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
