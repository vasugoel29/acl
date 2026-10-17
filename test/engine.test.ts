import { describe, expect, it } from 'vitest';
import { checkPermission, mergeScopes, resolveEffective, scopeAllows } from '../src/acl/engine.js';
import { DomainError, verifyGoogleClaims } from '../src/auth/google.js';

const rolePermissions = {
  VIEWER: ['rooms:view', 'schedule:view'],
  STUDENT_REP: ['rooms:book', 'bookings:transfer', 'rooms:view'],
  FACULTY: ['halls:reserve', 'slots:cancel', 'rooms:view'],
};

describe('resolveEffective', () => {
  it('unions permissions across roles', () => {
    const r = resolveEffective({
      grants: [
        { role: 'VIEWER', scope: {} },
        { role: 'FACULTY', scope: {} },
      ],
      rolePermissions,
      overrides: [],
    });
    expect(r.permissions).toEqual(['halls:reserve', 'rooms:view', 'schedule:view', 'slots:cancel']);
    expect(r.roles.sort()).toEqual(['FACULTY', 'VIEWER']);
  });

  it('applies ALLOW then DENY overrides', () => {
    const r = resolveEffective({
      grants: [{ role: 'VIEWER', scope: {} }],
      rolePermissions,
      overrides: [
        { permission: 'rooms:book', effect: 'ALLOW' },
        { permission: 'rooms:view', effect: 'DENY' },
      ],
    });
    expect(r.permissions).toEqual(['rooms:book', 'schedule:view']);
  });

  it('keeps scopes per permission so an unscoped role does not widen a scoped one', () => {
    const rep = { branch: 'CSAI', section: 1 };
    const r = resolveEffective({
      grants: [
        { role: 'VIEWER', scope: {} },
        { role: 'STUDENT_REP', scope: rep },
      ],
      rolePermissions,
      overrides: [],
    });
    expect(checkPermission(r, 'rooms:book', { branch: 'CSAI', section: 1 })).toBe(true);
    expect(checkPermission(r, 'rooms:book', { branch: 'CSAI', section: 2 })).toBe(false);
    // rooms:view is granted by VIEWER unscoped => anywhere
    expect(checkPermission(r, 'rooms:view', { branch: 'ECE' })).toBe(true);
    expect(checkPermission(r, 'nope:nope')).toBe(false);
    expect(r.scope).toEqual(rep);
  });

  it('supports array scope values (rep for two sections)', () => {
    const r = resolveEffective({
      grants: [{ role: 'STUDENT_REP', scope: { branch: 'CSAI', section: [1, 2] } }],
      rolePermissions,
      overrides: [],
    });
    expect(checkPermission(r, 'rooms:book', { branch: 'CSAI', section: 2 })).toBe(true);
    expect(checkPermission(r, 'rooms:book', { branch: 'CSAI', section: 3 })).toBe(false);
  });

  it('requires the resource to specify every scoped key', () => {
    expect(scopeAllows({ branch: 'CSAI' }, {})).toBe(false);
    expect(scopeAllows({}, {})).toBe(true);
  });

  it('merges scopes per key', () => {
    expect(mergeScopes([{ branch: 'CSAI', section: 1 }, { branch: 'ECE', section: 1 }])).toEqual({ branch: ['CSAI', 'ECE'], section: 1 });
  });

  it('returns no role when nothing is granted', () => {
    const r = resolveEffective({ grants: [], rolePermissions, overrides: [] });
    expect(r.role).toBeNull();
    expect(r.permissions).toEqual([]);
  });
});

describe('verifyGoogleClaims', () => {
  const ok = { sub: '1', email: 'A@nsut.ac.in', email_verified: true, hd: 'nsut.ac.in', name: 'A' };
  it('accepts nsut accounts and lowercases email', () => {
    expect(verifyGoogleClaims(ok).email).toBe('a@nsut.ac.in');
  });
  it.each([
    ['unverified email', { ...ok, email_verified: false }],
    ['wrong hd', { ...ok, hd: 'gmail.com' }],
    ['missing hd', { ...ok, hd: undefined }],
    ['wrong email domain', { ...ok, email: 'a@evil.com' }],
    ['suffix spoof', { ...ok, email: 'a@nsut.ac.in.evil.com' }],
  ])('rejects %s', (_n, claims) => {
    expect(() => verifyGoogleClaims(claims as any)).toThrow(DomainError);
  });
});
