import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api, fetchCurrentSession, handleCallback, logout, startLogin, downloadErrorReport, downloadExportFile } from './api.js';
import {
  IconDashboard,
  IconUsers,
  IconApps,
  IconIngest,
  IconAudit,
  IconSearch,
  IconDownload,
  IconUpload,
  IconPlus,
  IconRefresh,
  IconLogout,
  IconArrowRight,
  IconResource,
  IconChevronDown,
  IconCheck,
} from './icons.jsx';

function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debounced;
}

function SearchableSelect({
  options = [],
  value,
  onChange,
  placeholder = 'Select option…',
  searchPlaceholder = 'Filter options…',
  searchable = true,
  disabled = false,
  style = {},
  triggerStyle = {},
  popoverStyle = {},
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);

  const normalizedOptions = useMemo(() => {
    return options.map((opt) => {
      if (typeof opt === 'object' && opt !== null) {
        return {
          value: opt.value,
          label: opt.label ?? String(opt.value),
          badge: opt.badge ?? null,
          description: opt.description ?? null,
        };
      }
      return { value: opt, label: String(opt), badge: null, description: null };
    });
  }, [options]);

  const selectedOpt = normalizedOptions.find((o) => String(o.value) === String(value));

  const filtered = useMemo(() => {
    if (!filter.trim()) return normalizedOptions;
    const f = filter.toLowerCase();
    return normalizedOptions.filter((o) =>
      o.label.toLowerCase().includes(f) ||
      (o.description && o.description.toLowerCase().includes(f)) ||
      (o.badge && o.badge.toLowerCase().includes(f)) ||
      String(o.value).toLowerCase().includes(f)
    );
  }, [normalizedOptions, filter]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (open && searchable) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setFilter('');
    }
  }, [open, searchable]);

  return (
    <div className="searchable-select-container" ref={containerRef} style={style}>
      <div
        className={`searchable-select-trigger ${open ? 'active' : ''}`}
        style={{
          borderRadius: '10px',
          height: '42px',
          ...triggerStyle,
        }}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!disabled) setOpen((prev) => !prev);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {selectedOpt ? (
            <>
              <span style={{ fontWeight: 500, color: '#0f172a' }}>{selectedOpt.label}</span>
              {selectedOpt.badge && (
                <span className="badge muted sm" style={{ fontSize: '10px', padding: '1px 6px' }}>{selectedOpt.badge}</span>
              )}
            </>
          ) : (
            <span style={{ color: '#94a3b8' }}>{placeholder}</span>
          )}
        </div>
        <div style={{
          color: '#64748b',
          display: 'flex',
          alignItems: 'center',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s ease',
          marginLeft: '8px',
          flexShrink: 0
        }}>
          <IconChevronDown size={15} />
        </div>
      </div>

      {open && (
        <div className="searchable-select-popover" style={popoverStyle}>
          {searchable && (
            <div className="searchable-select-search-wrap">
              <span style={{ position: 'absolute', left: '10px', color: '#94a3b8', display: 'flex', pointerEvents: 'none' }}>
                <IconSearch size={13} />
              </span>
              <input
                ref={searchInputRef}
                className="searchable-select-search-input"
                placeholder={searchPlaceholder}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                  if (e.key === 'Enter' && filtered.length > 0) {
                    onChange(filtered[0].value);
                    setOpen(false);
                  }
                }}
              />
              {filter && (
                <button
                  type="button"
                  style={{
                    position: 'absolute',
                    right: '8px',
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: '2px 4px',
                  }}
                  onClick={() => setFilter('')}
                >
                  ✕
                </button>
              )}
            </div>
          )}

          <div className="searchable-select-list custom-scrollbar">
            {filtered.length === 0 ? (
              <div className="searchable-select-empty">No options found</div>
            ) : (
              filtered.map((opt) => {
                const isSelected = String(opt.value) === String(value);
                return (
                  <div
                    key={String(opt.value)}
                    className={`searchable-select-option ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: isSelected ? 600 : 400 }}>{opt.label}</span>
                        {opt.badge && (
                          <span className="badge muted sm" style={{ fontSize: '10px', padding: '1px 5px' }}>{opt.badge}</span>
                        )}
                      </div>
                      {opt.description && (
                        <div style={{ fontSize: '11px', color: '#64748b', whiteSpace: 'normal' }}>
                          {opt.description}
                        </div>
                      )}
                    </div>
                    {isSelected && (
                      <span style={{ color: '#2563eb', display: 'flex', marginLeft: '8px', flexShrink: 0 }}>
                        <IconCheck size={14} />
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getInitials(name, email) {
  const raw = (name || email || 'Admin').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return raw.slice(0, 2).toUpperCase();
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [errorBanner, setErrorBanner] = useState('');

  useEffect(() => {
    (async () => {
      const q = new URLSearchParams(location.search);
      if (q.get('error') && location.pathname !== '/callback') {
        const errType = q.get('error');
        const errDesc = q.get('error_description');
        if (errDesc) {
          setErrorBanner(errDesc);
        } else if (errType === 'session_expired') {
          setErrorBanner('Your authentication session expired. Please sign in again.');
        } else if (errType === 'access_denied') {
          setErrorBanner('Access denied. Your account does not have administrative permissions to access the NSUT Identity Console.');
        } else {
          setErrorBanner(errType);
        }
        history.replaceState({}, '', '/');
      } else {
        try {
          await handleCallback();
        } catch (err) {
          setErrorBanner(err.message);
        }
      }
      try {
        const s = await fetchCurrentSession();
        setSession(s);
      } catch (err) {
        setSession(null);
        setErrorBanner(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', background: 'radial-gradient(circle at 0 0, #ffffff 0%, #f8fafc 50%, #eef2f7 100%)', color: '#0f172a', padding: '20px' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: '68px', height: '68px', margin: '0 auto 16px', background: '#ffffff', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px', border: '1px solid #e2e8f0', boxShadow: '0 6px 20px rgba(15, 23, 42, 0.08)' }}>
            <img src="/nsut-logo.png" alt="NSUT Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          <div style={{ fontSize: '15px', fontFamily: 'var(--font-serif)', fontWeight: 700, marginBottom: '6px', color: '#111827' }}>
            Authenticating Session
          </div>
          <div style={{ fontSize: '13px', color: '#64748b' }}>Connecting to NSUT Central Identity Provider…</div>
        </div>
      </div>
    );
  }

  if (!session) {
    return <EnterpriseLoginGateway error={errorBanner} />;
  }

  const userInitials = getInitials(session.user.name, session.user.email);

  return (
    <div className="app-shell">
      {/* Enterprise Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-top-row">
          <div className="brand-section">
            <div className="brand-crest">
              <img src="/nsut-logo.png" alt="NSUT Logo" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="brand-text-title">NSUT Identity</div>
              <div className="brand-text-sub">Campus Access Management</div>
            </div>
          </div>

          <div className="mobile-header-actions">
            <div className="user-avatar-circle" title={`${session.user.name} (${session.user.email})`}>
              {userInitials}
            </div>
            <button className="btn-signout" title="Sign Out" onClick={logout} style={{ border: '1px solid #e2e8f0', background: '#f8fafc' }}>
              <IconLogout size={16} />
            </button>
          </div>
        </div>

        <div className="nav-group-title">Navigation</div>
        <nav className="nav-menu">
          <button className={`nav-button ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
            <span className="nav-icon"><IconDashboard size={18} /></span>
            <span className="nav-label-full">Overview</span>
            <span className="nav-label-short">Overview</span>
          </button>
          <button className={`nav-button ${activeTab === 'directory' ? 'active' : ''}`} onClick={() => setActiveTab('directory')}>
            <span className="nav-icon"><IconUsers size={18} /></span>
            <span className="nav-label-full">Campus Directory</span>
            <span className="nav-label-short">Directory</span>
          </button>
          <button className={`nav-button ${activeTab === 'apps' ? 'active' : ''}`} onClick={() => setActiveTab('apps')}>
            <span className="nav-icon"><IconApps size={18} /></span>
            <span className="nav-label-full">Applications</span>
            <span className="nav-label-short">Apps</span>
          </button>
          <button className={`nav-button ${activeTab === 'resources' ? 'active' : ''}`} onClick={() => setActiveTab('resources')}>
            <span className="nav-icon"><IconResource size={18} /></span>
            <span className="nav-label-full">Resources</span>
            <span className="nav-label-short">Resources</span>
          </button>
          <button className={`nav-button ${activeTab === 'ingest' ? 'active' : ''}`} onClick={() => setActiveTab('ingest')}>
            <span className="nav-icon"><IconIngest size={18} /></span>
            <span className="nav-label-full">Data Management</span>
            <span className="nav-label-short">Data Sync</span>
          </button>
          <button className={`nav-button ${activeTab === 'audit' ? 'active' : ''}`} onClick={() => setActiveTab('audit')}>
            <span className="nav-icon"><IconAudit size={18} /></span>
            <span className="nav-label-full">Audit Log</span>
            <span className="nav-label-short">Audit Log</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile-badge">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden', minWidth: 0 }}>
              <div className="user-avatar-circle">{userInitials}</div>
              <div className="user-profile-details">
                <div className="user-profile-name">{session.user.name}</div>
                <div className="user-profile-role">{session.access.roles.map((r) => r.replace(/_/g, ' ')).join(', ') || 'ADMIN'}</div>
              </div>
            </div>
            <button className="btn-signout" title="Sign Out" onClick={logout}>
              <IconLogout size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-view">
        <header className="top-bar">
          <div className="top-bar-left">
            <div className="top-bar-brand">
              <img src="/nsut-logo.png" alt="NSUT Seal" style={{ width: '22px', height: '22px', objectFit: 'contain', flexShrink: 0 }} />
              <span className="tenant-title">Netaji Subhas University of Technology</span>
            </div>
          </div>
          <div className="top-bar-right">
            <span className="mono top-bar-email">{session.user.email}</span>
          </div>
        </header>

        <main className="content-container">
          {errorBanner && (
            <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#b91c1c', marginBottom: '20px', fontSize: '13px' }}>
              {errorBanner}
            </div>
          )}

          {activeTab === 'overview' && <Overview onViewTab={setActiveTab} />}
          {activeTab === 'directory' && <Directory />}
          {activeTab === 'apps' && <Applications />}
          {activeTab === 'resources' && <ResourcesCatalog />}
          {activeTab === 'ingest' && <IngestionCenter />}
          {activeTab === 'audit' && <AuditStream />}
        </main>
      </div>
    </div>
  );
}

/* ================= 1. Enterprise Login Gateway ================= */
function EnterpriseLoginGateway({ error }) {
  return (
    <div className="login-gateway-shell">
      <div className="login-gateway-card">
        <div style={{ width: '84px', height: '84px', margin: '0 auto 20px', background: '#ffffff', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px', border: '1px solid #e2e8f0', boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)' }}>
          <img src="/nsut-logo.png" alt="NSUT Official Seal" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <h1 style={{ fontSize: 'clamp(24px, 5vw, 28px)', fontWeight: 700, color: '#111827', marginBottom: '8px', lineHeight: 1.15 }}>
          NSUT Identity
        </h1>
        <p style={{ fontSize: '13.5px', color: '#64748b', marginBottom: '28px' }}>
          Central Identity &amp; Access Management (IAM) Portal
        </p>

        {error && (
          <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '12px', color: '#b91c1c', fontSize: '13px', marginBottom: '22px', textAlign: 'left', fontWeight: 500, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <button className="btn" onClick={startLogin} style={{ width: '100%', justifyContent: 'center', padding: '13px 20px', fontSize: '14.5px', borderRadius: '14px', background: '#111827', color: '#ffffff', fontWeight: 600, boxShadow: '0 4px 14px rgba(15, 23, 42, 0.12)', whiteSpace: 'normal' }}>
          Sign In with Google Workspace
        </button>

        <div style={{ marginTop: '24px', fontSize: '12px', color: '#64748b', lineHeight: 1.6 }}>
          Restricted to authorized <strong style={{ color: '#0f172a' }}>@nsut.ac.in</strong> or <strong style={{ color: '#0f172a' }}>@nsit.ac.in</strong> accounts.<br />
          Single Sign-On protected by NSUT OpenID Connect Provider 2.0.
        </div>
      </div>
    </div>
  );
}

/* ================= 2. Overview ================= */
function formatAction(action) {
  switch (action) {
    case 'USERS_IMPORTED': return 'Roster Ingested';
    case 'SEMESTER_ROLLOVER': return 'Semester Rollover';
    case 'ROLE_GRANTED': return 'Role Granted';
    case 'ROLE_REVOKED': return 'Role Revoked';
    case 'LOGIN': return 'User Login';
    case 'LOGOUT': return 'User Logout';
    case 'ADMIN_LOGOUT': return 'Admin Logout';
    case 'USER_CREATED': return 'User Created';
    case 'USER_UPDATED': return 'User Updated';
    case 'USER_PROVISIONED': return 'User Provisioned';
    case 'APP_REGISTERED': return 'Application Registered';
    case 'PERMISSIONS_DEFINED': return 'Permissions Defined';
    case 'ROLES_DEFINED': return 'Roles Defined';
    case 'ROLES_EXPIRED': return 'Roles Expired';
    default:
      if (!action) return 'Action';
      return action
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
  }
}

function Overview({ onViewTab }) {
  const [metrics, setMetrics] = useState(null);
  const [recentLogs, setRecentLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/v1/overview/metrics'),
      api('/v1/audit?limit=6').catch(() => ({ entries: [] })),
    ])
      .then(([m, a]) => {
        setMetrics(m.metrics);
        setRecentLogs(a.entries ?? []);
      })
      .catch((err) => console.error('Failed to load overview data:', err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <p>Campus accounts, department divisions, and client application access.</p>
        </div>
      </div>

      {/* Balanced 4-Column KPI Grid */}
      <div className="metrics-row">
        <div className="metric-card">
          <div className="metric-title">Total Campus Users</div>
          <div className="metric-value">{loading ? '—' : (metrics?.totalUsers ?? 0).toLocaleString()}</div>
          <div className="metric-meta">Accounts active in NSUT IAM</div>
        </div>
        <div className="metric-card">
          <div className="metric-title">Academic Departments</div>
          <div className="metric-value">{loading ? '—' : (metrics?.totalDepartments ?? 20).toLocaleString()}</div>
          <div className="metric-meta">Teaching &amp; research divisions</div>
        </div>
        <div className="metric-card">
          <div className="metric-title">Connected Applications</div>
          <div className="metric-value">{loading ? '—' : (metrics?.activeApps ?? 1)}</div>
          <div className="metric-meta">Active campus client services</div>
        </div>
        <div className="metric-card">
          <div className="metric-title">Active Role Grants</div>
          <div className="metric-value">{loading ? '—' : (metrics?.activeAssignments ?? 0).toLocaleString()}</div>
          <div className="metric-meta">Scoped application assignments</div>
        </div>
      </div>

      {/* 2-Column Main Section */}
      <div className="overview-grid">
        {/* Left: Real Administrative Activity Feed */}
        <div className="table-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '16px', color: '#0f172a' }}>Recent Activity</h3>
              <p style={{ margin: '3px 0 0', fontSize: '12.5px', color: '#64748b' }}>
                Latest security and directory actions across the university.
              </p>
            </div>
            <button className="btn sm" onClick={() => onViewTab('audit')} style={{ gap: '6px' }}>
              View All <IconArrowRight size={13} />
            </button>
          </div>

          <div className="activity-stream">
            {recentLogs.length === 0 && (
              <div style={{ padding: '28px 0', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                No recent activity logged.
              </div>
            )}
            {recentLogs.map((log) => (
              <div key={log.id} className="activity-item">
                <div style={{ minWidth: 0 }}>
                  <div className="activity-action">{formatAction(log.action)}</div>
                  <div className="activity-meta">
                    <span style={{ color: '#0f172a', fontWeight: 500 }}>
                      {log.actor_name || (log.actor_email ? log.actor_email.split('@')[0] : (log.actor_id ? (log.actor_id.includes('@') ? log.actor_id.split('@')[0] : log.actor_id) : 'System'))}
                    </span>
                    {log.app_id && (
                      <span> · <span className="mono" style={{ color: '#1d4ed8' }}>{log.app_id}</span></span>
                    )}
                  </div>
                </div>
                <div className="activity-time">
                  {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Quick Actions & Connected Apps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', minWidth: 0 }}>
          <div className="table-card" style={{ padding: '20px' }}>
            <h3 style={{ marginBottom: '4px', fontSize: '15.5px', color: '#0f172a' }}>Quick Actions</h3>
            <p style={{ marginBottom: '16px', fontSize: '12.5px', color: '#64748b' }}>
              Common identity management tasks.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button className="btn" onClick={() => onViewTab('directory')} style={{ justifyContent: 'space-between', padding: '10px 14px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <IconUsers size={16} /> Campus Directory
                </span>
                <IconArrowRight size={14} className="text-muted" />
              </button>
              <button className="btn" onClick={() => onViewTab('ingest')} style={{ justifyContent: 'space-between', padding: '10px 14px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <IconUpload size={16} /> Upload Roster (CSV)
                </span>
                <IconArrowRight size={14} className="text-muted" />
              </button>
              <button className="btn" onClick={() => onViewTab('apps')} style={{ justifyContent: 'space-between', padding: '10px 14px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <IconApps size={16} /> Application Roles
                </span>
                <IconArrowRight size={14} className="text-muted" />
              </button>
            </div>
          </div>

          <div className="table-card" style={{ padding: '20px' }}>
            <h3 style={{ marginBottom: '4px', fontSize: '15.5px', color: '#0f172a' }}>Connected Applications</h3>
            <p style={{ marginBottom: '14px', fontSize: '12.5px', color: '#64748b' }}>
              Active client platforms using NSUT single sign-on.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>CRAS <span style={{ fontWeight: 400, color: '#64748b' }}>· Rooms &amp; Timetables</span></span>
                <span className="badge active">Connected</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ================= 3. Campus Directory Grid & Drawer ================= */
function Directory() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [departments, setDepartments] = useState([]);
  const [sort, setSort] = useState('name_asc');
  const [page, setPage] = useState(0);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const limit = 25;

  useEffect(() => {
    api('/v1/departments')
      .then((res) => setDepartments(res.departments || []))
      .catch(() => {});
  }, []);

  const debouncedSearch = useDebounce(search, 300);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
        sort: sort || 'name_asc',
        ...(debouncedSearch ? { q: debouncedSearch } : {}),
        ...(dept ? { dept } : {}),
      });
      const res = await api(`/v1/users?${q.toString()}`);
      setUsers(res.users);
      setTotal(res.total ?? res.users.length);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, dept, sort, page]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Campus Directory</h1>
          <p>Master directory of enrolled accounts and academic coordinates.</p>
        </div>
        <button className="btn primary" onClick={() => setCreateUserOpen(true)}>
          <IconPlus size={15} /> Add User
        </button>
      </div>

      <div className="filter-bar filter-bar-3">
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', marginBottom: '6px' }}>
            Search
          </div>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: '13px', color: '#94a3b8', display: 'flex' }}>
              <IconSearch size={15} />
            </span>
            <input
              className="input"
              style={{ paddingLeft: '36px', height: '42px', borderRadius: '10px' }}
              placeholder="Search by name, email, or roll number..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#64748b', marginBottom: '6px' }}>
            Department
          </div>
          <SearchableSelect
            options={[
              { value: '', label: 'All Departments' },
              ...departments.map((d) => ({ value: d, label: d })),
            ]}
            value={dept}
            onChange={(val) => { setDept(val); setPage(0); }}
            placeholder="All Departments"
            searchPlaceholder="Search department…"
            triggerStyle={{ height: '42px', borderRadius: '10px' }}
          />
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#64748b', marginBottom: '6px' }}>
            Sort By
          </div>
          <SearchableSelect
            options={[
              { value: 'name_asc', label: 'Name (A–Z)' },
              { value: 'name_desc', label: 'Name (Z–A)' },
              { value: 'roll_asc', label: 'Roll Number' },
              { value: 'newest', label: 'Recently Added' },
            ]}
            value={sort}
            onChange={(val) => { setSort(val || 'name_asc'); setPage(0); }}
            placeholder="Name (A–Z)"
            searchable={false}
            triggerStyle={{ height: '42px', borderRadius: '10px' }}
          />
        </div>
      </div>

      <div className="table-card">
        <div className="table-scroll-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Campus ID / Roll No</th>
                <th>Department / Academics</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan="4" style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>
                    Loading directory records…
                  </td>
                </tr>
              )}
              {!loading && users.length === 0 && (
                <tr>
                  <td colSpan="4" style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>
                    No campus identities match the current filters.
                  </td>
                </tr>
              )}
              {!loading &&
                users.map((u) => (
                  <tr key={u.id} className="interactive-row" onClick={() => setSelectedUserId(u.id)}>
                    <td data-label="Name">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <strong style={{ color: '#0f172a', fontWeight: 600 }}>{u.name}</strong>
                        {u.status && u.status !== 'ACTIVE' && (
                          <span className={`badge ${u.status === 'SUSPENDED' ? 'suspended' : 'archived'}`}>
                            {u.status}
                          </span>
                        )}
                      </div>
                    </td>
                    <td data-label="Email" className="mono" style={{ color: '#1d4ed8', fontWeight: 500 }}>
                      <span>{u.email}</span>
                    </td>
                    <td data-label="Campus ID">
                      {u.roll_no ? (
                        <span className="mono" style={{ fontWeight: 600, color: '#0f172a' }}>{u.roll_no}</span>
                      ) : u.employee_id ? (
                        <span className="mono" style={{ fontWeight: 600, color: '#0f172a' }}>Emp #{u.employee_id}</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td data-label="Department">
                      {u.roll_no ? (
                        <div style={{ fontSize: '12.5px' }}>
                          <div style={{ color: '#0f172a', fontWeight: 600 }}>
                            {u.dept || u.branch || 'Student'} {u.degree ? <span style={{ color: '#64748b', fontWeight: 400 }}>({u.degree})</span> : null}
                          </div>
                          <div className="mono text-muted" style={{ fontSize: '11.5px', color: '#475569', marginTop: '2px' }}>
                            {[
                              u.year ? `Year ${u.year}` : null,
                              u.semester ? `Sem ${u.semester}` : null,
                              u.section ? `Sec ${u.section}` : null,
                              u.group_no ? `Grp ${u.group_no}` : null,
                              u.batch_no ? `Batch ${u.batch_no}` : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                      ) : (
                        <div style={{ fontSize: '12.5px' }}>
                          <div style={{ color: '#0f172a', fontWeight: 600 }}>{u.dept || 'General Campus'}</div>
                          {u.designation && (
                            <div className="text-muted" style={{ fontSize: '11.5px', marginTop: '2px' }}>{u.designation}</div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="table-pagination">
          <div>
            Showing {Math.min(page * limit + 1, total)}–{Math.min((page + 1) * limit, total)} of {total.toLocaleString()} identities
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <button className="btn sm" disabled={(page + 1) * limit >= total} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </div>
      </div>

      {selectedUserId && (
        <UserSlideDrawer
          userId={selectedUserId}
          onClose={() => { setSelectedUserId(null); loadUsers(); }}
        />
      )}

      {createUserOpen && (
        <CreateIdentityModal
          onClose={(created) => { setCreateUserOpen(false); if (created) loadUsers(); }}
        />
      )}
    </>
  );
}

/* ================= 4. Identity Slide-Over Drawer ================= */
function formatScope(scope) {
  if (!scope || Object.keys(scope).length === 0) {
    return <span style={{ color: '#059669', background: '#ecfdf5', padding: '2px 7px', borderRadius: '4px', fontSize: '11px', fontWeight: 500 }}>Global Access</span>;
  }
  const parts = [];
  if (scope.branch) parts.push(`Branch: ${scope.branch}`);
  if (scope.semester) parts.push(`Sem: ${scope.semester}`);
  if (scope.section) parts.push(`Sec: ${scope.section}`);
  if (scope.roll_no) parts.push(`Roll: ${scope.roll_no}`);
  if (scope.app) {
    const appList = Array.isArray(scope.app) ? scope.app.join(', ') : scope.app;
    parts.push(`Apps: ${appList}`);
  }
  for (const [k, v] of Object.entries(scope)) {
    if (!['branch', 'semester', 'section', 'roll_no', 'app'].includes(k)) {
      parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
  }

  return (
    <span style={{ color: '#1d4ed8', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '2px 7px', borderRadius: '4px', fontSize: '11px', fontWeight: 500 }}>
      {parts.join(' · ')}
    </span>
  );
}

function UserSlideDrawer({ userId, onClose }) {
  const [data, setData] = useState(null);
  const [apps, setApps] = useState([]);
  const [assigningApp, setAssigningApp] = useState(null);
  const [inlineRole, setInlineRole] = useState('');
  const [scopeType, setScopeType] = useState('GLOBAL');
  const [scopeBranch, setScopeBranch] = useState('');
  const [scopeSemester, setScopeSemester] = useState('');
  const [scopeSection, setScopeSection] = useState('');
  const [scopeSelectedApps, setScopeSelectedApps] = useState(['CRAS']);
  const [inlineExpiry, setInlineExpiry] = useState('');
  const [inlineError, setInlineError] = useState('');
  const [submittingRole, setSubmittingRole] = useState(false);

  const refresh = useCallback(async () => {
    const [acc, prof, appList] = await Promise.all([
      api(`/v1/users/${userId}/access`),
      api(`/v1/users/${userId}`),
      api('/v1/apps'),
    ]);
    setData({ access: acc, profile: prof });
    setApps(appList.apps);
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleStatus = async (newStatus) => {
    await api(`/v1/users/${userId}`, { method: 'PATCH', body: { status: newStatus } });
    refresh();
  };

  const toggleAppAssign = (appKey) => {
    if (assigningApp === appKey) {
      setAssigningApp(null);
      setInlineRole('');
      setInlineError('');
    } else {
      setAssigningApp(appKey);
      setInlineRole('');
      setInlineError('');
      setScopeType('GLOBAL');
      if (data?.profile?.academic) {
        setScopeBranch(data.profile.academic.branch || '');
        setScopeSemester(data.profile.academic.semester || '');
        setScopeSection(data.profile.academic.section || '');
      } else {
        setScopeBranch('');
        setScopeSemester('');
        setScopeSection('');
      }
    }
  };

  const handleRoleSelection = (role) => {
    setInlineRole(role);
    if (role === 'APP_ADMIN') {
      setScopeType('APPS');
    } else if (['STUDENT_REP', 'CLASS_REP', 'CR'].includes(role)) {
      setScopeType('ACADEMIC');
      if (data?.profile?.academic) {
        setScopeBranch(data.profile.academic.branch || '');
        setScopeSemester(data.profile.academic.semester || '');
        setScopeSection(data.profile.academic.section || '');
      } else {
        setScopeBranch('');
        setScopeSemester('');
        setScopeSection('');
      }
    } else {
      setScopeType('GLOBAL');
    }
  };

  const handleInlineGrant = async (e, appKey) => {
    e.preventDefault();
    setInlineError('');
    setSubmittingRole(true);
    try {
      let finalScope = {};
      if (scopeType === 'GLOBAL') {
        finalScope = {};
      } else if (scopeType === 'ACADEMIC') {
        finalScope = {};
        if (scopeBranch.trim()) finalScope.branch = scopeBranch.trim().toUpperCase();
        if (scopeSemester) finalScope.semester = Number(scopeSemester);
        if (scopeSection) finalScope.section = Number(scopeSection);
      } else if (scopeType === 'APPS') {
        finalScope = { app: scopeSelectedApps };
      }

      await api(`/v1/users/${userId}/apps/${appKey}/roles`, {
        method: 'POST',
        body: {
          role: inlineRole,
          scope: finalScope,
          expires_at: inlineExpiry ? new Date(inlineExpiry).toISOString() : null,
        },
      });
      setAssigningApp(null);
      setInlineRole('');
      setInlineExpiry('');
      await refresh();
    } catch (err) {
      setInlineError(err.message);
    } finally {
      setSubmittingRole(false);
    }
  };

  const handleRevoke = async (appKey, assignmentId) => {
    await api(`/v1/users/${userId}/apps/${appKey}/roles/${assignmentId}`, { method: 'DELETE' });
    refresh();
  };

  if (!data) return null;
  const { user } = data.access;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="slide-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h2>{user.name}</h2>
            <div className="mono text-muted" style={{ fontSize: '12px' }}>{user.email}</div>
          </div>
          <button className="btn sm" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-content">
          <div className="drawer-section">
            {user.status && user.status !== 'ACTIVE' && (
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <span className={`badge ${user.status === 'SUSPENDED' ? 'suspended' : 'archived'}`}>{user.status}</span>
              </div>
            )}

            <div className="section-label">Academic &amp; Profile Attributes</div>
            <div className="meta-grid">
              {data.profile.academic && Object.values(data.profile.academic).some((v) => v !== null && v !== undefined && v !== '') ? (
                Object.entries(data.profile.academic)
                  .filter(([, v]) => v !== null && v !== undefined && v !== '')
                  .map(([k, v]) => (
                    <div key={k} className="meta-item">
                      <div className="meta-key">{k.replace(/_/g, ' ')}</div>
                      <div className="meta-val">{String(v)}</div>
                    </div>
                  ))
              ) : (
                <div className="meta-item" style={{ gridColumn: 'span 2' }}>
                  <div className="meta-key">Department</div>
                  <div className="meta-val">{user.dept || 'General Staff / Central Admin'}</div>
                </div>
              )}
            </div>

            <div style={{ marginTop: '16px' }}>
              {user.status === 'ACTIVE' ? (
                <button className="btn danger sm" onClick={() => toggleStatus('SUSPENDED')}>
                  Suspend Account Access
                </button>
              ) : (
                <button className="btn sm" onClick={() => toggleStatus('ACTIVE')}>
                  Reactivate Identity
                </button>
              )}
            </div>
          </div>

          <div className="drawer-section">
            <div className="section-label">Application Permissions &amp; Scopes</div>
            {data.access.access.map((appAccess) => {
              const appDef = apps.find((a) => a.id === appAccess.app);
              const availableRoles = appDef?.roles ?? [];

              return (
                <div key={appAccess.app} className="app-access-row">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                      <strong style={{ color: '#0f172a' }}>{appAccess.app}</strong> · <span className="text-muted">{appAccess.name}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      {appAccess.role ? (
                        <span className="badge blue">
                          {appAccess.roles.map((r) => r.replace(/_/g, ' ')).join(' + ')}
                          {appAccess.implicit_default && (
                            <span style={{ opacity: 0.65, fontSize: '10.5px', marginLeft: '4px' }}>· Default</span>
                          )}
                        </span>
                      ) : (
                        <span className="badge archived">No Access</span>
                      )}
                      <button
                        className={`btn sm ${assigningApp === appAccess.app ? '' : 'primary'}`}
                        style={{ padding: '3px 8px', fontSize: '11.5px', height: '26px' }}
                        onClick={() => toggleAppAssign(appAccess.app)}
                      >
                        <IconPlus size={12} /> {assigningApp === appAccess.app ? 'Cancel' : 'Assign Role'}
                      </button>
                    </div>
                  </div>

                  {appAccess.permissions.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '8px 0' }}>
                      {appAccess.permissions.map((p) => (
                        <span key={p} className="mono" style={{ fontSize: '11px', background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', padding: '2px 6px', borderRadius: '4px' }}>
                          {p}
                        </span>
                      ))}
                    </div>
                  )}

                  {appAccess.assignments.map((asg) => (
                    <div key={asg.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', marginTop: '6px', paddingTop: '6px', borderTop: '1px dashed var(--border-subtle)', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <strong style={{ color: '#0f172a' }}>{asg.role.replace(/_/g, ' ')}</strong>
                        {formatScope(asg.scope)}
                        {asg.expires_at && (
                          <span style={{ color: '#f59e0b', fontSize: '11px' }}>
                            · Expires: {new Date(asg.expires_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <button
                        className="btn danger sm"
                        onClick={() => handleRevoke(appAccess.app, asg.id)}
                        style={{ padding: '2px 8px', fontSize: '11px' }}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}

                  {assigningApp === appAccess.app && (
                    <div style={{
                      marginTop: '12px',
                      padding: '16px',
                      background: '#ffffff',
                      border: '1px solid #cbd5e1',
                      borderRadius: '12px',
                      boxShadow: '0 3px 12px rgba(15, 23, 42, 0.06)',
                    }}>
                      <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#1e3a8a', marginBottom: '12px' }}>
                        Assign Role for {appAccess.app}
                      </div>
                      <form onSubmit={(e) => handleInlineGrant(e, appAccess.app)} className="form-stack">
                        <div>
                          <label className="field-label" style={{ fontSize: '11px' }}>Role</label>
                          <SearchableSelect
                            options={availableRoles.map((r) => ({
                              value: r.role,
                              label: r.role,
                              badge: r.is_default ? 'Default' : null,
                              description: r.description || null,
                            }))}
                            value={inlineRole}
                            onChange={(val) => handleRoleSelection(val)}
                            placeholder={`Select Role for ${appAccess.app}…`}
                            searchPlaceholder="Filter role name or description…"
                            triggerStyle={{ height: '40px', borderRadius: '8px', fontSize: '13px' }}
                          />
                        </div>

                        {/* Visual Human-Friendly Scope Selector */}
                        <div style={{ marginTop: '4px' }}>
                          <label className="field-label" style={{ fontSize: '11px', marginBottom: '6px' }}>Access Scope</label>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px', background: '#f1f5f9', padding: '3px', borderRadius: '8px' }}>
                            <button
                              type="button"
                              className="btn sm"
                              style={{
                                flex: '1 1 110px',
                                justifyContent: 'center',
                                padding: '5px 8px',
                                fontSize: '11.5px',
                                fontWeight: scopeType === 'GLOBAL' ? 600 : 500,
                                background: scopeType === 'GLOBAL' ? '#ffffff' : 'transparent',
                                border: scopeType === 'GLOBAL' ? '1px solid #cbd5e1' : '1px solid transparent',
                                boxShadow: scopeType === 'GLOBAL' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                                color: scopeType === 'GLOBAL' ? '#0f172a' : '#64748b'
                              }}
                              onClick={() => setScopeType('GLOBAL')}
                            >
                              Full App (Global)
                            </button>
                            <button
                              type="button"
                              className="btn sm"
                              style={{
                                flex: '1 1 130px',
                                justifyContent: 'center',
                                padding: '5px 8px',
                                fontSize: '11.5px',
                                fontWeight: scopeType === 'ACADEMIC' ? 600 : 500,
                                background: scopeType === 'ACADEMIC' ? '#ffffff' : 'transparent',
                                border: scopeType === 'ACADEMIC' ? '1px solid #cbd5e1' : '1px solid transparent',
                                boxShadow: scopeType === 'ACADEMIC' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                                color: scopeType === 'ACADEMIC' ? '#0f172a' : '#64748b'
                              }}
                              onClick={() => {
                                setScopeType('ACADEMIC');
                                if (data?.profile?.academic) {
                                  setScopeBranch(data.profile.academic.branch || '');
                                  setScopeSemester(data.profile.academic.semester || '');
                                  setScopeSection(data.profile.academic.section || '');
                                } else {
                                  setScopeBranch('');
                                  setScopeSemester('');
                                  setScopeSection('');
                                }
                              }}
                            >
                              Academic Coordinates
                            </button>
                            {appAccess.app === 'ACL' && (
                              <button
                                type="button"
                                className="btn sm"
                                style={{
                                  flex: '1 1 110px',
                                  justifyContent: 'center',
                                  padding: '5px 8px',
                                  fontSize: '11.5px',
                                  fontWeight: scopeType === 'APPS' ? 600 : 500,
                                  background: scopeType === 'APPS' ? '#ffffff' : 'transparent',
                                  border: scopeType === 'APPS' ? '1px solid #cbd5e1' : '1px solid transparent',
                                  boxShadow: scopeType === 'APPS' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                                  color: scopeType === 'APPS' ? '#0f172a' : '#64748b'
                                }}
                                onClick={() => setScopeType('APPS')}
                              >
                                Specific Apps
                              </button>
                            )}
                          </div>

                          {scopeType === 'GLOBAL' && (
                            <div style={{ padding: '8px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px', color: '#475569' }}>
                              ✓ Grants unrestricted access across the entire <strong>{appAccess.name}</strong> application without resource limits.
                            </div>
                          )}

                          {scopeType === 'ACADEMIC' && (
                            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                              <div className="scope-academic-grid">
                                <div>
                                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Branch / Stream</label>
                                  <input
                                    className="input"
                                    style={{ height: '36px', borderRadius: '6px', fontSize: '12.5px' }}
                                    placeholder="e.g. CSAI"
                                    value={scopeBranch}
                                    onChange={(e) => setScopeBranch(e.target.value.toUpperCase())}
                                  />
                                </div>
                                <div>
                                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Semester</label>
                                  <SearchableSelect
                                    options={[
                                      { value: '', label: 'Any / Unspecified' },
                                      ...[1, 2, 3, 4, 5, 6, 7, 8].map((s) => ({ value: s, label: `Semester ${s}` })),
                                    ]}
                                    value={scopeSemester}
                                    onChange={(val) => setScopeSemester(val !== '' ? Number(val) : '')}
                                    placeholder="Any / Unspecified"
                                    searchable={false}
                                    triggerStyle={{ height: '36px', borderRadius: '6px', fontSize: '12.5px' }}
                                  />
                                </div>
                                <div>
                                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Section</label>
                                  <SearchableSelect
                                    options={[
                                      { value: '', label: 'Any / Unspecified' },
                                      ...[1, 2, 3, 4, 5].map((s) => ({ value: s, label: `Section ${s}` })),
                                    ]}
                                    value={scopeSection}
                                    onChange={(val) => setScopeSection(val !== '' ? Number(val) : '')}
                                    placeholder="Any / Unspecified"
                                    searchable={false}
                                    triggerStyle={{ height: '36px', borderRadius: '6px', fontSize: '12.5px' }}
                                  />
                                </div>
                              </div>
                              <div style={{ marginTop: '8px', fontSize: '11.5px', color: '#1e3a8a', fontWeight: 500 }}>
                                Scoped to: {[scopeBranch || 'Any Branch', scopeSemester ? `Semester ${scopeSemester}` : null, scopeSection ? `Section ${scopeSection}` : null].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                          )}

                          {scopeType === 'APPS' && (
                            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px' }}>
                              <div style={{ fontSize: '11px', color: '#475569', marginBottom: '6px' }}>Select applications this administrator can manage:</div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                {apps.filter((a) => a.id !== 'ACL').map((a) => {
                                  const checked = scopeSelectedApps.includes(a.id);
                                  return (
                                    <label
                                      key={a.id}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '6px',
                                        padding: '4px 10px',
                                        background: checked ? '#eff6ff' : '#ffffff',
                                        border: checked ? '1px solid #3b82f6' : '1px solid #cbd5e1',
                                        borderRadius: '6px',
                                        fontSize: '12px',
                                        cursor: 'pointer',
                                        fontWeight: checked ? 600 : 400,
                                        color: checked ? '#1d4ed8' : '#334155'
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={(e) => {
                                          if (e.target.checked) setScopeSelectedApps([...scopeSelectedApps, a.id]);
                                          else setScopeSelectedApps(scopeSelectedApps.filter((id) => id !== a.id));
                                        }}
                                        style={{ margin: 0 }}
                                      />
                                      {a.id} ({a.name})
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>

                        <div>
                          <label className="field-label" style={{ fontSize: '11px' }}>Optional Expiry Date</label>
                          <input
                            type="date"
                            className="input"
                            style={{ height: '36px', borderRadius: '8px', fontSize: '12px' }}
                            value={inlineExpiry}
                            onChange={(e) => setInlineExpiry(e.target.value)}
                          />
                        </div>

                        {inlineError && (
                          <div style={{ color: '#b91c1c', fontSize: '11.5px', background: '#fef2f2', padding: '6px 8px', borderRadius: '6px', border: '1px solid #fecaca' }}>
                            {inlineError}
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                          <button className="btn primary sm" type="submit" disabled={submittingRole}>
                            {submittingRole ? 'Granting…' : 'Grant Role'}
                          </button>
                          <button className="btn sm" type="button" onClick={() => { setAssigningApp(null); setInlineError(''); }}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= 5. Applications & RBAC Matrix ================= */
function Applications() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newAppOpen, setNewAppOpen] = useState(false);
  const [editingApp, setEditingApp] = useState(null);
  const [newSecretAlert, setNewSecretAlert] = useState(null);

  const load = () => {
    api('/v1/apps')
      .then((res) => { setApps(res.apps); setLoading(false); })
      .catch(() => setLoading(false));
  };

  const handleDeleteApp = async (appId) => {
    if (!window.confirm(`Delete application "${appId}"? All roles and assignments for this app will be permanently deleted.`)) return;
    try {
      await api(`/v1/apps/${appId}`, { method: 'DELETE' });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Connected Applications</h1>
          <p>Manage registered client platforms, OAuth/OIDC credentials, and application-scoped roles.</p>
        </div>
        <button className="btn primary" onClick={() => setNewAppOpen(true)}>
          <IconPlus size={15} /> Register Application
        </button>
      </div>

      {newSecretAlert && (
        <div style={{ padding: '16px', background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.35)', borderRadius: '10px', marginBottom: '20px' }}>
          <strong style={{ color: '#a5b4fc', display: 'block', marginBottom: '6px' }}>
            Client Secret Generated for {newSecretAlert.client_id}
          </strong>
          <p style={{ marginBottom: '10px', fontSize: '12.5px' }}>
            Store this client secret securely. It is hashed at rest and will not be displayed again:
          </p>
          <code className="mono" style={{ background: '#090d16', padding: '6px 10px', borderRadius: '6px', color: '#67e8f9', display: 'block' }}>
            {newSecretAlert.client_secret}
          </code>
        </div>
      )}

      <div className="apps-grid">
        {loading && <div style={{ color: '#64748b' }}>Loading applications…</div>}
        {apps.map((a) => (
          <div key={a.id} className="table-card" style={{ padding: '22px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', color: '#0f172a' }}>{a.id}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span className={`badge ${a.confidential ? 'indigo' : 'blue'}`}>
                  {a.confidential ? 'Confidential Client' : 'Public Client (PKCE)'}
                </span>
                <button
                  className="btn sm"
                  style={{ padding: '3px 9px', fontSize: '11.5px', height: '26px' }}
                  onClick={() => setEditingApp(a)}
                >
                  Edit Roles
                </button>
                <button
                  className="btn danger sm"
                  style={{ padding: '3px 9px', fontSize: '11.5px', height: '26px' }}
                  onClick={() => handleDeleteApp(a.id)}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="text-muted" style={{ fontSize: '13px', marginBottom: '16px' }}>{a.name}</div>

            <div className="section-label">Roles &amp; Permissions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
              {a.roles.map((r) => (
                <div key={r.role} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', padding: '10px 12px', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '13px', color: '#0f172a' }}>{r.role}</strong>
                    {r.is_default && <span className="badge active">Default Role</span>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                    {r.permissions.map((p) => (
                      <span key={p} className="mono" style={{ fontSize: '11px', background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', padding: '2px 6px', borderRadius: '4px' }}>
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="section-label">Authorized Redirect URIs</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {a.redirect_uris.map((uri) => (
                <code key={uri} className="mono text-muted" style={{ fontSize: '11.5px', background: '#f8fafc', padding: '4px 8px', borderRadius: '4px', border: '1px solid #f1f5f9', wordBreak: 'break-all' }}>{uri}</code>
              ))}
            </div>
          </div>
        ))}
      </div>

      {newAppOpen && (
        <RegisterAppModal
          onClose={(res) => {
            setNewAppOpen(false);
            if (res) {
              if (res.client_secret) setNewSecretAlert(res);
              load();
            }
          }}
        />
      )}

      {editingApp && (
        <EditAppRolesModal
          app={editingApp}
          onClose={() => setEditingApp(null)}
          onSaved={() => {
            setEditingApp(null);
            load();
          }}
        />
      )}
    </>
  );
}

/* ================= 5b. Interactive Application Role & Resource Editor ================= */
function EditAppRolesModal({ app, onClose, onSaved }) {
  const [roles, setRoles] = useState(
    app.roles.map((r) => ({
      role: r.role,
      description: r.description || '',
      is_default: !!r.is_default,
      permissions: [...(r.permissions || [])],
    }))
  );
  const [appPermissions, setAppPermissions] = useState(app.permissions || []);
  const [selectedRoleIndex, setSelectedRoleIndex] = useState(0);
  const [newRoleName, setNewRoleName] = useState('');
  const [newResourceKey, setNewResourceKey] = useState('');
  const [newResourceDesc, setNewResourceDesc] = useState('');
  const [showAddResource, setShowAddResource] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const currentRole = roles[selectedRoleIndex] || roles[0];

  const handleAddRole = (e) => {
    e.preventDefault();
    const formatted = newRoleName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!formatted) return;
    if (roles.some((r) => r.role === formatted)) {
      setError(`Role ${formatted} already exists.`);
      return;
    }
    setError('');
    const newR = { role: formatted, description: '', is_default: false, permissions: [] };
    const nextRoles = [...roles, newR];
    setRoles(nextRoles);
    setSelectedRoleIndex(nextRoles.length - 1);
    setNewRoleName('');
  };

  const handleDeleteRole = (roleNameToDelete) => {
    if (roles.length <= 1) {
      setError('An application must have at least one defined role.');
      return;
    }
    if (!window.confirm(`Delete role "${roleNameToDelete}"? Any accounts assigned this role will lose it.`)) return;
    setError('');
    const updated = roles.filter((r) => r.role !== roleNameToDelete);
    if (!updated.some((r) => r.is_default)) {
      updated[0].is_default = true;
    }
    setRoles(updated);
    setSelectedRoleIndex(0);
  };

  const handleSetDefaultRole = (idx) => {
    setRoles(roles.map((r, i) => ({ ...r, is_default: i === idx })));
  };

  const togglePermissionForCurrentRole = (perm) => {
    if (!currentRole) return;
    const has = currentRole.permissions.includes(perm);
    const nextPerms = has
      ? currentRole.permissions.filter((p) => p !== perm)
      : [...currentRole.permissions, perm];

    const updated = [...roles];
    updated[selectedRoleIndex] = { ...currentRole, permissions: nextPerms };
    setRoles(updated);
  };

  const handleSelectAllPerms = () => {
    if (!currentRole) return;
    const updated = [...roles];
    updated[selectedRoleIndex] = { ...currentRole, permissions: [...appPermissions] };
    setRoles(updated);
  };

  const handleClearAllPerms = () => {
    if (!currentRole) return;
    const updated = [...roles];
    updated[selectedRoleIndex] = { ...currentRole, permissions: [] };
    setRoles(updated);
  };

  const handleCreateResource = async (e) => {
    e.preventDefault();
    const perm = newResourceKey.trim().toLowerCase();
    if (!perm || !perm.includes(':')) {
      setError('Resource key must follow format resource:action (e.g. rooms:book)');
      return;
    }
    setError('');
    try {
      await api('/v1/resources', {
        method: 'POST',
        body: {
          app_id: app.id,
          permission: perm,
          description: newResourceDesc.trim() || undefined,
        },
      });
      if (!appPermissions.includes(perm)) {
        const next = [...appPermissions, perm].sort();
        setAppPermissions(next);
        if (currentRole && !currentRole.permissions.includes(perm)) {
          const updated = [...roles];
          updated[selectedRoleIndex] = { ...currentRole, permissions: [...currentRole.permissions, perm] };
          setRoles(updated);
        }
      }
      setNewResourceKey('');
      setNewResourceDesc('');
      setShowAddResource(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaveAll = async () => {
    setError('');
    setSaving(true);
    try {
      await api(`/v1/apps/${app.id}/roles`, {
        method: 'PUT',
        body: {
          roles: roles.map((r) => ({
            role: r.role,
            description: r.description || undefined,
            is_default: r.is_default,
            permissions: r.permissions,
            default_scope: {},
          })),
        },
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog wide" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '860px' }}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0, fontSize: '18px', color: '#0f172a' }}>
              Manage Roles &amp; Permissions · {app.id}
            </h2>
            <div className="text-muted" style={{ fontSize: '12px', marginTop: '2px' }}>
              {app.name}
            </div>
          </div>
          <button className="btn sm" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 0 }}>
          {error && (
            <div style={{ margin: '16px 20px 0', padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#b91c1c', fontSize: '12.5px' }}>
              {error}
            </div>
          )}

          <div className="role-editor-grid">
            {/* Left: Role Navigation & Creation */}
            <div className="role-editor-sidebar">
              <div>
                <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b', marginBottom: '10px' }}>
                  Defined Roles ({roles.length})
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {roles.map((r, idx) => {
                    const isSelected = idx === selectedRoleIndex;
                    return (
                      <div
                        key={r.role}
                        onClick={() => { setSelectedRoleIndex(idx); setError(''); }}
                        style={{
                          padding: '10px 12px',
                          borderRadius: '8px',
                          border: isSelected ? '1px solid #3b82f6' : '1px solid #e2e8f0',
                          background: isSelected ? '#eff6ff' : '#ffffff',
                          cursor: 'pointer',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <div>
                          <strong style={{ fontSize: '13px', color: isSelected ? '#1d4ed8' : '#0f172a', display: 'block' }}>
                            {r.role}
                          </strong>
                          <span style={{ fontSize: '11px', color: '#64748b' }}>
                            {r.permissions.length} resource{r.permissions.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        {r.is_default && (
                          <span className="badge active" style={{ fontSize: '10px', padding: '1px 5px' }}>Default</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Add New Role input */}
              <form onSubmit={handleAddRole} style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid #e2e8f0' }}>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                  Add Role
                </label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    className="input mono"
                    style={{ height: '34px', fontSize: '12px', borderRadius: '6px' }}
                    placeholder="e.g. DEAN, HOD"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                  />
                  <button type="submit" className="btn primary sm" style={{ height: '34px', padding: '0 10px' }}>
                    +
                  </button>
                </div>
              </form>
            </div>

            {/* Right: Selected Role Permissions & Resources Checklist */}
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              {currentRole ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--card-border)', flexWrap: 'wrap', gap: '10px' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <h3 style={{ margin: 0, fontSize: '17px', color: '#0f172a' }}>{currentRole.role}</h3>
                        {currentRole.is_default && <span className="badge active">Default Role</span>}
                      </div>
                      <span style={{ fontSize: '12.5px', color: '#64748b' }}>
                        Configure accessible resources for accounts with this role.
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#475569', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={currentRole.is_default}
                          onChange={() => handleSetDefaultRole(selectedRoleIndex)}
                        />
                        <span>Set as Default</span>
                      </label>
                      {roles.length > 1 && (
                        <button
                          type="button"
                          className="btn danger sm"
                          style={{ padding: '2px 8px', fontSize: '11px' }}
                          onClick={() => handleDeleteRole(currentRole.role)}
                        >
                          Delete Role
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Resource Permissions Header & Bulk Toggles */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b' }}>
                      Allowed Resources ({currentRole.permissions.length} of {appPermissions.length})
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button type="button" className="btn sm" style={{ fontSize: '11px', padding: '2px 8px' }} onClick={handleSelectAllPerms}>
                        Select All
                      </button>
                      <button type="button" className="btn sm" style={{ fontSize: '11px', padding: '2px 8px' }} onClick={handleClearAllPerms}>
                        Clear All
                      </button>
                    </div>
                  </div>

                  {/* Checklist of Resources */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '8px', maxHeight: '220px', overflowY: 'auto', paddingRight: '4px' }}>
                    {appPermissions.length === 0 && (
                      <div style={{ padding: '20px', color: '#94a3b8', fontSize: '12.5px', textAlign: 'center', gridColumn: 'span 2' }}>
                        No resources registered for this application yet.
                      </div>
                    )}
                    {appPermissions.map((perm) => {
                      const isChecked = currentRole.permissions.includes(perm);
                      return (
                        <label
                          key={perm}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 10px',
                            background: isChecked ? '#eff6ff' : '#f8fafc',
                            border: isChecked ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => togglePermissionForCurrentRole(perm)}
                          />
                          <span className="mono" style={{ fontSize: '11.5px', fontWeight: isChecked ? 600 : 400, color: isChecked ? '#1d4ed8' : '#334155' }}>
                            {perm}
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  {/* Quick Add Resource to this app */}
                  <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px dashed #e2e8f0' }}>
                    {!showAddResource ? (
                      <button
                        type="button"
                        className="btn sm"
                        style={{ fontSize: '11.5px', gap: '4px' }}
                        onClick={() => setShowAddResource(true)}
                      >
                        <IconPlus size={12} /> Add New Resource to {app.id}
                      </button>
                    ) : (
                      <form onSubmit={handleCreateResource} style={{ background: '#f8fafc', padding: '10px 12px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                        <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#1e3a8a', marginBottom: '8px' }}>
                          Add Resource to {app.id} (resource:action)
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
                          <input
                            className="input mono"
                            style={{ height: '34px', fontSize: '12px', flex: '1 1 160px' }}
                            placeholder="e.g. rooms:approve"
                            value={newResourceKey}
                            onChange={(e) => setNewResourceKey(e.target.value)}
                            required
                          />
                          <input
                            className="input"
                            style={{ height: '34px', fontSize: '12px', flex: '1.5 1 200px' }}
                            placeholder="Description (optional)"
                            value={newResourceDesc}
                            onChange={(e) => setNewResourceDesc(e.target.value)}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <button type="submit" className="btn primary sm" style={{ fontSize: '11.5px' }}>
                            Add &amp; Grant to {currentRole.role}
                          </button>
                          <button type="button" className="btn sm" style={{ fontSize: '11.5px' }} onClick={() => setShowAddResource(false)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary sm" onClick={handleSaveAll} disabled={saving}>
            {saving ? 'Saving Changes…' : 'Save Roles & Permissions'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= 5c. Central Resources & Permissions Catalog ================= */
function ResourcesCatalog() {
  const [resources, setResources] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterApp, setFilterApp] = useState('');
  const [search, setSearch] = useState('');
  const [newResourceOpen, setNewResourceOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [resData, appsData] = await Promise.all([
        api('/v1/resources'),
        api('/v1/apps'),
      ]);
      setResources(resData.resources || []);
      setApps(appsData.apps || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDeleteResource = async (appId, permission) => {
    if (!window.confirm(`Delete resource "${permission}" from ${appId}? Roles will immediately lose access to this resource.`)) return;
    try {
      await api(`/v1/resources/${appId}/${encodeURIComponent(permission)}`, { method: 'DELETE' });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const debouncedSearch = useDebounce(search, 300);

  const filtered = resources.filter((r) => {
    if (filterApp && r.app_id !== filterApp) return false;
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      return r.permission.toLowerCase().includes(q) || (r.description && r.description.toLowerCase().includes(q)) || r.app_id.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Campus Resources &amp; Permissions</h1>
          <p>Central registry of protected services, entities, and actions across campus applications.</p>
        </div>
        <button className="btn primary" onClick={() => setNewResourceOpen(true)}>
          <IconPlus size={15} /> Add Resource
        </button>
      </div>

      {/* Summary KPI Grid */}
      <div className="metrics-row" style={{ marginBottom: '24px' }}>
        <div className="metric-card">
          <div className="metric-label">Total Resources</div>
          <div className="metric-value">{resources.length}</div>
          <div className="metric-sub">Protected endpoints &amp; operations</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Applications</div>
          <div className="metric-value">{apps.length}</div>
          <div className="metric-sub">Active campus client services</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Access Architecture</div>
          <div className="metric-value" style={{ fontSize: '20px', color: '#1d4ed8' }}>RBAC + Scopes</div>
          <div className="metric-sub">Role mappings configured in Applications</div>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="filter-bar filter-bar-2">
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', marginBottom: '6px' }}>
            Search Resources
          </div>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: '13px', color: '#94a3b8', display: 'flex' }}>
              <IconSearch size={15} />
            </span>
            <input
              className="input"
              style={{ paddingLeft: '36px', height: '42px', borderRadius: '10px' }}
              placeholder="e.g. rooms:view, attendance:mark, users:read..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', marginBottom: '6px' }}>
            Application
          </div>
          <SearchableSelect
            options={[
              { value: '', label: 'All Applications' },
              ...apps.map((a) => ({ value: a.id, label: a.id, description: a.name })),
            ]}
            value={filterApp}
            onChange={(val) => setFilterApp(val)}
            placeholder="All Applications"
            searchPlaceholder="Filter application…"
            triggerStyle={{ height: '42px', borderRadius: '10px' }}
          />
        </div>
      </div>

      {/* Table */}
      <div className="table-card">
        <div className="table-scroll-wrap">
          <table>
            <thead>
              <tr>
                <th>Resource Key</th>
                <th>Application</th>
                <th>Description</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan="4" style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>Loading campus resources…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan="4" style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>No resources match the current filter.</td></tr>
              )}
              {!loading && filtered.map((r) => (
                <tr key={`${r.app_id}-${r.permission}`}>
                  <td data-label="Resource Key">
                    <strong className="mono" style={{ color: '#0f172a', fontSize: '13px' }}>
                      {r.permission}
                    </strong>
                  </td>
                  <td data-label="Application">
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span className="badge blue">{r.app_id}</span>
                      <span className="text-muted" style={{ fontSize: '12px' }}>{r.app_name}</span>
                    </div>
                  </td>
                  <td data-label="Description" style={{ fontSize: '12.5px', color: '#475569', maxWidth: '320px' }}>
                    <span>{r.description || <span className="text-muted">—</span>}</span>
                  </td>
                  <td data-label="Actions" style={{ textAlign: 'right' }}>
                    <button
                      className="btn danger sm"
                      style={{ padding: '3px 8px', fontSize: '11.5px' }}
                      onClick={() => handleDeleteResource(r.app_id, r.permission)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {newResourceOpen && (
        <AddResourceModal
          apps={apps}
          onClose={(created) => {
            setNewResourceOpen(false);
            if (created) load();
          }}
        />
      )}
    </>
  );
}

function AddResourceModal({ apps, onClose }) {
  const [appId, setAppId] = useState(apps[0]?.id || 'CRAS');
  const [resource, setResource] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const formatted = resource.trim().toLowerCase();
    if (!formatted.includes(':')) {
      setError('Resource key must follow format resource:action (e.g. rooms:book, events:create)');
      return;
    }
    setError('');
    try {
      await api('/v1/resources', {
        method: 'POST',
        body: {
          app_id: appId,
          permission: formatted,
          description: desc.trim() || undefined,
        },
      });
      onClose(true);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => onClose(false)}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Campus Resource</h2>
          <button className="btn sm" onClick={() => onClose(false)}>✕</button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body form-stack">
            <div>
              <label className="field-label">Target Application</label>
              <SearchableSelect
                options={apps.map((a) => ({ value: a.id, label: a.id, description: a.name }))}
                value={appId}
                onChange={(val) => setAppId(val)}
                placeholder="Select Application…"
                searchPlaceholder="Filter application…"
                triggerStyle={{ height: '42px', borderRadius: '10px' }}
              />
            </div>

            <div>
              <label className="field-label">Resource Key (resource:action)</label>
              <input
                className="input mono"
                placeholder="e.g. library:issue or rooms:book"
                value={resource}
                onChange={(e) => setResource(e.target.value)}
                required
              />
              <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px', display: 'block' }}>
                Use lowercase identifier followed by colon and action name.
              </span>
            </div>

            <div>
              <label className="field-label">Description</label>
              <input
                className="input"
                placeholder="e.g. Allows issuing books and physical reserve materials"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
              />
            </div>

            {error && <div style={{ color: '#b91c1c', fontSize: '12px' }}>{error}</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn sm" onClick={() => onClose(false)}>Cancel</button>
            <button type="submit" className="btn primary sm">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <IconPlus size={14} /> Add Resource
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ================= 6. Ingestion & Job Control Center ================= */
function IngestionCenter() {
  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [activeJob, setActiveJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const loadJobs = useCallback(async () => {
    try {
      const res = await api('/v1/jobs');
      setJobs(res.jobs ?? []);
    } catch (err) {
      console.error('Failed to load jobs:', err);
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Live polling: poll every 1.5s whenever any job is queued or actively processing
  useEffect(() => {
    const hasActive = jobs.some((j) => ['QUEUED', 'PROCESSING'].includes(j.status));
    if (!hasActive && !submitting && !exporting) return;

    const timer = setInterval(() => {
      loadJobs();
    }, 1500);

    return () => clearInterval(timer);
  }, [jobs, submitting, exporting, loadJobs]);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setStatusMsg('');
    setSubmitting(true);

    file.text().then(async (csvContent) => {
      try {
        const query = new URLSearchParams({ filename: file.name });
        const { job_id } = await api(`/v1/users/import?${query.toString()}`, {
          method: 'POST',
          body: csvContent,
          raw: true,
        });
        await loadJobs();
        // Fetch newly created job to make it active in telemetry card
        const newJob = await api(`/v1/jobs/${job_id}`);
        setActiveJob(newJob);
      } catch (err) {
        setStatusMsg(err.message);
      } finally {
        setSubmitting(false);
      }
    });
    e.target.value = '';
  };

  const handleExport = async () => {
    setStatusMsg('');
    setExporting(true);
    try {
      const { job_id } = await api('/v1/users/export', { method: 'POST', body: {} });
      await loadJobs();
      const newJob = await api(`/v1/jobs/${job_id}`);
      setActiveJob(newJob);
    } catch (err) {
      setStatusMsg(err.message);
    } finally {
      setExporting(false);
    }
  };

  const handleRollover = async () => {
    if (!window.confirm('Trigger Semester Rollover? All student semesters will advance by 1, graduating batches will be archived, and semester-scoped assignments will expire.')) return;
    setSubmitting(true);
    setStatusMsg('');
    try {
      const { job_id } = await api('/v1/users/rollover', { method: 'POST', body: {} });
      await loadJobs();
      const newJob = await api(`/v1/jobs/${job_id}`);
      setActiveJob(newJob);
    } catch (err) {
      setStatusMsg(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Roster Ingestion &amp; Bulk Operations</h1>
          <p>Process campus roster spreadsheets, export identity directories, and automate semester transitions.</p>
        </div>
      </div>

      {/* 3 Action Cards */}
      <div className="ingest-cards-grid">
        <div className="table-card" style={{ padding: '24px' }}>
          <h3 style={{ marginBottom: '8px', fontSize: '16px', color: '#0f172a' }}>Upload Student Roster</h3>
          <p style={{ marginBottom: '16px', fontSize: '13px', color: '#64748b' }}>
            Upload CSV or TSV exports from ERP. Flexible column auto-mapping standardizes student and faculty attributes.
          </p>

          <label className="dropzone" style={{ display: 'block', cursor: submitting ? 'wait' : 'pointer' }}>
            <div style={{ marginBottom: '10px', color: '#1e3a8a', display: 'flex', justifyContent: 'center' }}>
              <IconUpload size={28} />
            </div>
            <strong style={{ fontSize: '13.5px', color: '#0f172a', display: 'block', marginBottom: '4px' }}>
              {submitting ? 'Streaming file to background worker…' : 'Choose CSV / TSV file or drag & drop'}
            </strong>
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              Supports .csv and .tsv files up to 50MB
            </span>
            <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain" onChange={handleFileUpload} disabled={submitting} style={{ display: 'none' }} />
          </label>

          <div style={{ marginTop: '14px', fontSize: '11.5px', color: '#64748b' }}>
            <strong>Expected format:</strong> Standard ERP roster (<span style={{ color: '#0f172a', fontWeight: 500 }}>Exam Year, Degree, Department, Roll Number, Name, Current Semester, 12-Digit Roll, NSUT Email</span>).
          </div>
        </div>

        <div className="table-card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ marginBottom: '8px', fontSize: '16px', color: '#0f172a' }}>Export Directory Snapshot</h3>
            <p style={{ marginBottom: '16px', fontSize: '13px', color: '#64748b' }}>
              Generate a complete CSV snapshot of all enrolled campus accounts, academic departments, and roll numbers.
            </p>
          </div>
          <div>
            <button className="btn primary" onClick={handleExport} disabled={exporting} style={{ width: '100%', justifyContent: 'center' }}>
              {exporting ? (
                'Generating export file…'
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <IconDownload size={15} /> Export Directory (.csv)
                </span>
              )}
            </button>
            <div style={{ marginTop: '12px', fontSize: '11.5px', color: '#64748b' }}>
              Exports are generated asynchronously in the background and stored for 48 hours.
            </div>
          </div>
        </div>

        <div className="table-card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ marginBottom: '8px', fontSize: '16px', color: '#0f172a' }}>Semester Rollover</h3>
            <p style={{ marginBottom: '16px', fontSize: '13px', color: '#64748b' }}>
              Advance all active students to the next semester. Students completing final semester transition to graduated status.
            </p>
          </div>
          <div>
            <button className="btn danger" onClick={handleRollover} disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
              {submitting ? 'Processing Rollover…' : 'Execute Semester Rollover…'}
            </button>
            <div style={{ marginTop: '12px', fontSize: '11.5px', color: '#64748b' }}>
              Bulk update operation. Expired academic role assignments are cleared automatically.
            </div>
          </div>
        </div>
      </div>

      {statusMsg && (
        <div style={{ marginTop: '20px', padding: '12px 16px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', color: '#b91c1c', fontSize: '13px' }}>
          {statusMsg}
        </div>
      )}

      {/* Live Job Inspection Telemetry Card (Active / Selected) */}
      {activeJob && (
        <div className="job-progress-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span className={`badge ${activeJob.type === 'IMPORT' ? 'blue' : activeJob.type === 'EXPORT' ? 'indigo' : 'active'}`}>
                  {activeJob.type}
                </span>
                <h3 style={{ margin: 0, fontSize: '16px', color: '#0f172a', wordBreak: 'break-word' }}>{activeJob.filename || 'Job Details'}</h3>
              </div>
              <div className="mono text-muted" style={{ fontSize: '11.5px', marginTop: '4px', wordBreak: 'break-all' }}>
                ID: {activeJob.id} · Initiated by: {activeJob.actor_email || 'Admin'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span className={`badge ${activeJob.status === 'COMPLETED' ? 'active' : activeJob.status === 'FAILED' ? 'suspended' : 'blue'}`}>
                {activeJob.status === 'PROCESSING' && <span className="pulse-indicator" />}
                {activeJob.status}
              </span>
              <button className="btn sm" onClick={() => setActiveJob(null)}>✕ Close</button>
            </div>
          </div>

          <div className="job-progress-bar-bg">
            <div className="job-progress-bar-fill" style={{ width: `${activeJob.status === 'COMPLETED' ? 100 : activeJob.progress_pct || 15}%` }} />
          </div>

          <div className="job-stats-row">
            <div className="job-stat-box">
              <div className="meta-key">Total Records</div>
              <div className="job-stat-num">{activeJob.total_rows?.toLocaleString() ?? '—'}</div>
            </div>
            <div className="job-stat-box">
              <div className="meta-key">Processed / Created</div>
              <div className="job-stat-num" style={{ color: 'var(--emerald)' }}>
                {activeJob.type === 'EXPORT' ? (activeJob.processed_rows?.toLocaleString() ?? 0) : (activeJob.created_count?.toLocaleString() ?? 0)}
              </div>
            </div>
            <div className="job-stat-box">
              <div className="meta-key">Updated</div>
              <div className="job-stat-num" style={{ color: '#2563eb' }}>{activeJob.updated_count?.toLocaleString() ?? '0'}</div>
            </div>
            <div className="job-stat-box">
              <div className="meta-key">Failed</div>
              <div className="job-stat-num" style={{ color: 'var(--rose)' }}>{activeJob.failed_count?.toLocaleString() ?? '0'}</div>
            </div>
          </div>

          {activeJob.type === 'EXPORT' && activeJob.status === 'COMPLETED' && (
            <div style={{ marginTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn primary sm" onClick={() => downloadExportFile(activeJob.id)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <IconDownload size={14} /> Download File (.csv)
                </span>
              </button>
            </div>
          )}

          {activeJob.failed_count > 0 && (
            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <div style={{ fontSize: '13px', color: '#b91c1c' }}>
                {activeJob.failed_count.toLocaleString()} records encountered validation or database errors.
              </div>
              <button className="btn danger sm" onClick={() => downloadErrorReport(activeJob.id)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <IconDownload size={14} /> Download Failed Rows (.csv)
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Persistent Job History */}
      <div style={{ marginTop: '28px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <h2 style={{ fontSize: '18px', color: '#0f172a', margin: 0 }}>Job History</h2>
            <p style={{ fontSize: '13px', color: '#64748b', margin: '3px 0 0' }}>
              Status and history of background import, export, and rollover operations.
            </p>
          </div>
          <button className="btn sm" onClick={loadJobs} disabled={loadingJobs}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <IconRefresh size={13} /> Refresh
            </span>
          </button>
        </div>

        <div className="table-card">
          <div className="table-scroll-wrap">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Status &amp; Progress</th>
                  <th>Records</th>
                  <th>Initiated By</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingJobs && (
                  <tr>
                    <td colSpan="5" style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>
                      Loading job history…
                    </td>
                  </tr>
                )}
                {!loadingJobs && jobs.length === 0 && (
                  <tr>
                    <td colSpan="5" style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>
                      No jobs recorded yet. Ingest a roster or export the directory to start.
                    </td>
                  </tr>
                )}
                {!loadingJobs &&
                  jobs.map((j) => (
                    <tr key={j.id} className="interactive-row" onClick={() => setActiveJob(j)}>
                      <td data-label="Operation">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span className={`badge ${j.type === 'IMPORT' ? 'blue' : j.type === 'EXPORT' ? 'indigo' : 'active'}`}>
                            {j.type}
                          </span>
                          <div>
                            <strong style={{ color: '#0f172a', fontWeight: 600, fontSize: '13px' }}>
                              {j.filename || j.type}
                            </strong>
                            <div className="mono text-muted" style={{ fontSize: '11px' }}>ID: {j.id}</div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Status" style={{ minWidth: '160px' }}>
                        {j.status === 'PROCESSING' ? (
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', fontSize: '12px', fontWeight: 600, color: '#1d4ed8' }}>
                              <span className="pulse-indicator" /> Processing ({j.progress_pct}%)
                            </div>
                            <div className="cell-progress-bar">
                              <div className="cell-progress-fill" style={{ width: `${j.progress_pct || 15}%` }} />
                            </div>
                            <div className="mono text-muted" style={{ fontSize: '11px', marginTop: '3px' }}>
                              {j.processed_rows?.toLocaleString() ?? 0} / {j.total_rows ? j.total_rows.toLocaleString() : '?'} rows
                            </div>
                          </div>
                        ) : j.status === 'COMPLETED' ? (
                          <div>
                            <span className="badge active">COMPLETED</span>
                            {j.completed_at && j.started_at && (
                              <div className="text-muted" style={{ fontSize: '11px', marginTop: '3px' }}>
                                Done in {Math.max(1, Math.round((new Date(j.completed_at) - new Date(j.started_at)) / 1000))}s
                              </div>
                            )}
                          </div>
                        ) : j.status === 'FAILED' ? (
                          <div>
                            <span className="badge suspended">FAILED</span>
                            <div style={{ fontSize: '11px', color: '#b91c1c', marginTop: '3px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {j.error_message || 'Execution error'}
                            </div>
                          </div>
                        ) : (
                          <span className="badge blue">QUEUED</span>
                        )}
                      </td>
                      <td data-label="Records">
                        <div style={{ fontSize: '12.5px' }}>
                          <div>
                            <strong style={{ color: '#0f172a' }}>{j.total_rows?.toLocaleString() ?? '—'}</strong> total
                          </div>
                          <div className="mono text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
                            <span style={{ color: 'var(--emerald)' }}>+{j.created_count ?? 0}</span> ·{' '}
                            <span style={{ color: '#2563eb' }}>{j.updated_count ?? 0} updated</span>
                            {(j.failed_count ?? 0) > 0 && (
                              <span style={{ color: 'var(--rose)' }}> · {j.failed_count} failed</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td data-label="Initiated By">
                        <div>
                          <div style={{ fontSize: '12.5px', color: '#0f172a' }}>
                            {j.actor_email ? j.actor_email.split('@')[0] : 'System'}
                          </div>
                          <div className="text-muted" style={{ fontSize: '11px' }}>
                            {new Date(j.created_at).toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                      </td>
                      <td data-label="Actions" style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          {j.type === 'EXPORT' && j.status === 'COMPLETED' && (
                            <button className="btn primary sm" onClick={() => downloadExportFile(j.id)}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                <IconDownload size={12} /> CSV
                              </span>
                            </button>
                          )}
                          {j.type === 'IMPORT' && (j.failed_count ?? 0) > 0 && (
                            <button className="btn danger sm" onClick={() => downloadErrorReport(j.id)}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                <IconDownload size={12} /> Errors
                              </span>
                            </button>
                          )}
                          <button className="btn sm" onClick={() => setActiveJob(j)}>
                            Details
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function describeAuditLog(log) {
  const m = log.metadata || {};
  switch (log.action) {
    case 'ROLE_GRANTED': {
      const roleName = m.role ? m.role.replace(/_/g, ' ') : 'role';
      let scopeStr = '';
      if (m.scope) {
        if (m.scope.app && Array.isArray(m.scope.app)) {
          scopeStr = ` for ${m.scope.app.join(', ')}`;
        } else if (typeof m.scope === 'object' && Object.keys(m.scope).length > 0) {
          scopeStr = ` (${Object.entries(m.scope).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ')})`;
        }
      }
      const expStr = m.expires_at ? ` · Expires ${new Date(m.expires_at).toLocaleDateString()}` : '';
      return `Granted role ${roleName}${scopeStr}${expStr}`;
    }
    case 'ROLE_REVOKED': {
      const roleName = m.role ? m.role.replace(/_/g, ' ') : 'role';
      return `Revoked role ${roleName}`;
    }
    case 'LOGIN':
      return `Signed into ${log.app_id || 'campus service'} via Single Sign-On`;
    case 'LOGOUT':
      return `Signed out of ${log.app_id || 'campus service'}`;
    case 'ADMIN_LOGOUT':
      return 'Signed out of NSUT Identity Admin Console';
    case 'LOGIN_DENIED':
      return `Login denied (${m.status ? m.status.toLowerCase() : 'inactive account'})`;
    case 'LOGIN_REJECTED':
      return `Login rejected (${m.reason || 'authentication failed'})`;
    case 'USERS_IMPORTED': {
      const parts = [];
      if (m.created !== undefined) parts.push(`${m.created} created`);
      if (m.updated !== undefined && m.updated > 0) parts.push(`${m.updated} updated`);
      if (m.failed !== undefined && m.failed > 0) parts.push(`${m.failed} failed`);
      const details = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `Imported ${m.total ?? 'user'} roster records${details}`;
    }
    case 'SEMESTER_ROLLOVER': {
      const parts = [];
      if (m.advanced !== undefined) parts.push(`${m.advanced} advanced`);
      if (m.graduated !== undefined) parts.push(`${m.graduated} graduated`);
      if (m.expired !== undefined) parts.push(`${m.expired} roles expired`);
      return `Completed semester rollover: ${parts.join(', ')}`;
    }
    case 'USER_CREATED':
      return 'Created campus identity account';
    case 'PROFILE_UPDATED':
      return 'Updated identity profile details';
    case 'USER_PROVISIONED':
      return 'Provisioned user account via Google OAuth';
    case 'APP_REGISTERED':
      return 'Registered application client';
    case 'APP_UPDATED':
      return 'Updated application client settings';
    case 'PERMISSIONS_DEFINED':
      return `Configured ${m.count ?? ''} application permissions`;
    case 'ROLES_DEFINED':
      return 'Defined application roles and privileges';
    case 'ROLES_EXPIRED':
      return `Cleared ${m.count ?? ''} expired academic role assignment(s)`;
    default: {
      if (!log.metadata || Object.keys(log.metadata).length === 0) {
        return formatAction(log.action);
      }
      return Object.entries(log.metadata)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v).replace(/_/g, ' ')}`)
        .join(' · ');
    }
  }
}

/* ================= 7. Audit Stream ================= */
function AuditStream() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterAction, setFilterAction] = useState('');
  const [filterApp, setFilterApp] = useState('');
  const debouncedAction = useDebounce(filterAction, 300);
  const debouncedApp = useDebounce(filterApp, 300);

  const load = useCallback(() => {
    setLoading(true);
    const actionQuery = debouncedAction.trim().replace(/\s+/g, '_').toUpperCase();
    const appQuery = debouncedApp.trim().toUpperCase();
    const q = new URLSearchParams({
      ...(actionQuery ? { action: actionQuery } : {}),
      ...(appQuery ? { app: appQuery } : {}),
      limit: '100',
    });
    api(`/v1/audit?${q.toString()}`)
      .then((res) => { setLogs(res.entries); setLoading(false); })
      .catch(() => setLoading(false));
  }, [debouncedAction, debouncedApp]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Security Audit Log</h1>
          <p>Immutable log of administrative actions, authentication events, and role grants.</p>
        </div>
      </div>

      <div className="filter-bar filter-bar-2">
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', marginBottom: '6px' }}>
            Filter by Action
          </div>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: '13px', color: '#94a3b8', display: 'flex' }}>
              <IconSearch size={15} />
            </span>
            <input
              className="input"
              style={{ paddingLeft: '36px', height: '42px', borderRadius: '10px' }}
              placeholder="e.g. Role Granted, Login, User Created…"
              value={filterAction}
              onChange={(e) => setFilterAction(e.target.value)}
            />
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', marginBottom: '6px' }}>
            Filter by Application
          </div>
          <input
            className="input"
            style={{ height: '42px', borderRadius: '10px' }}
            placeholder="e.g. CRAS, HAJIRI, ACL…"
            value={filterApp}
            onChange={(e) => setFilterApp(e.target.value)}
          />
        </div>
      </div>

      <div className="table-card">
        <div className="table-scroll-wrap">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Action</th>
                <th>Application</th>
                <th>Actor</th>
                <th>Target</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan="6" style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>Loading audit records…</td></tr>
              )}
              {!loading && logs.length === 0 && (
                <tr><td colSpan="6" style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>No audit records found matching the filter criteria.</td></tr>
              )}
              {!loading && logs.map((log) => (
                <tr key={log.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td data-label="Timestamp" className="mono text-muted" style={{ fontSize: '11px', whiteSpace: 'nowrap', verticalAlign: 'middle', padding: '12px 14px' }}>
                    <span>{new Date(log.created_at).toLocaleString()}</span>
                  </td>
                  <td data-label="Action" style={{ verticalAlign: 'middle', padding: '12px 14px' }}>
                    <span className="badge blue">{formatAction(log.action)}</span>
                  </td>
                  <td data-label="Application" style={{ verticalAlign: 'middle', padding: '12px 14px' }}>
                    <strong style={{ color: '#0f172a' }}>{log.app_id || 'Central IAM'}</strong>
                  </td>
                  <td data-label="Actor" style={{ verticalAlign: 'middle', padding: '12px 14px' }}>
                    <div>
                      <div style={{ fontWeight: 500, color: '#0f172a', fontSize: '12px' }}>
                        {log.actor_name || log.actor_email || log.actor_id || '—'}
                      </div>
                      {(log.actor_name || log.actor_email) && log.actor_id && (
                        <div className="mono text-muted" style={{ fontSize: '10.5px' }}>{log.actor_id}</div>
                      )}
                    </div>
                  </td>
                  <td data-label="Target" style={{ verticalAlign: 'middle', padding: '12px 14px' }}>
                    <div>
                      <div style={{ fontWeight: 500, color: '#0f172a', fontSize: '12px' }}>
                        {log.target_name || log.target_email || log.target_id || '—'}
                      </div>
                      {(log.target_name || log.target_email) && log.target_id && (
                        <div className="mono text-muted" style={{ fontSize: '10.5px' }}>{log.target_id}</div>
                      )}
                    </div>
                  </td>
                  <td data-label="Description" style={{ fontSize: '12.5px', color: '#334155', lineHeight: 1.5, whiteSpace: 'normal', wordBreak: 'break-word', padding: '12px 14px' }}>
                    <span>{describeAuditLog(log)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ================= 8. Modals ================= */
function CreateIdentityModal({ onClose }) {
  const [f, setF] = useState({
    email: '',
    name: '',
    roll_no: '',
    twelve_digit_roll_no: '',
    dept: 'Computer Science and Engineering',
    branch: 'CSE',
    degree: 'B.Tech',
    semester: 1,
    section: 1,
    group_no: 1,
  });
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api('/v1/users', {
        method: 'POST',
        body: {
          email: f.email.trim(),
          name: f.name.trim(),
          roll_no: f.roll_no.trim() ? f.roll_no.trim().toUpperCase() : undefined,
          twelve_digit_roll_no: f.twelve_digit_roll_no.trim() || undefined,
          dept: f.dept.trim() || undefined,
          branch: f.branch.trim() || undefined,
          degree: f.degree.trim() || undefined,
          semester: f.semester ? Number(f.semester) : 1,
          year: f.semester ? Math.ceil(Number(f.semester) / 2) : 1,
          section: f.section ? Number(f.section) : 1,
          group_no: f.group_no ? Number(f.group_no) : 1,
        },
      });
      onClose(true);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => onClose(false)}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add User Account</h2>
          <button className="btn sm" onClick={() => onClose(false)}>✕</button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body form-stack">
            <div className="form-row-2">
              <div>
                <label className="field-label">Email (@nsut.ac.in or @nsit.ac.in)</label>
                <input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
              </div>
              <div>
                <label className="field-label">Full Name</label>
                <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
              </div>
            </div>

            <div className="form-row-2">
              <div>
                <label className="field-label">Roll Number</label>
                <input className="input" placeholder="e.g. 2023UCS1001" value={f.roll_no} onChange={(e) => setF({ ...f, roll_no: e.target.value })} />
              </div>
              <div>
                <label className="field-label">12-Digit Roll Number</label>
                <input className="input" placeholder="e.g. 202300000001" value={f.twelve_digit_roll_no} onChange={(e) => setF({ ...f, twelve_digit_roll_no: e.target.value })} />
              </div>
            </div>

            <div className="form-row-2">
              <div>
                <label className="field-label">Department</label>
                <input className="input" value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })} />
              </div>
              <div>
                <label className="field-label">Branch / Stream</label>
                <input className="input" value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} />
              </div>
            </div>

            <div className="form-row-2">
              <div>
                <label className="field-label">Degree</label>
                <input className="input" value={f.degree} onChange={(e) => setF({ ...f, degree: e.target.value })} />
              </div>
              <div>
                <label className="field-label">Current Semester</label>
                <input type="number" className="input" value={f.semester} onChange={(e) => setF({ ...f, semester: Number(e.target.value) })} min="1" max="10" />
              </div>
            </div>

            <div className="form-row-2">
              <div>
                <label className="field-label">Section</label>
                <input type="number" className="input" value={f.section} onChange={(e) => setF({ ...f, section: Number(e.target.value) })} min="1" />
              </div>
              <div>
                <label className="field-label">Group</label>
                <input type="number" className="input" value={f.group_no} onChange={(e) => setF({ ...f, group_no: Number(e.target.value) })} min="1" />
              </div>
            </div>

            {error && <div style={{ color: '#fca5a5', fontSize: '12px' }}>{error}</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn sm" onClick={() => onClose(false)}>Cancel</button>
            <button type="submit" className="btn primary sm">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <IconPlus size={14} /> Add User
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RegisterAppModal({ onClose }) {
  const [f, setF] = useState({ id: '', name: '', uris: '', confidential: false });
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await api('/v1/apps', {
        method: 'POST',
        body: {
          id: f.id.trim().toUpperCase(),
          name: f.name.trim(),
          redirect_uris: f.uris.split(/[\s,]+/).filter(Boolean),
          confidential: f.confidential,
        },
      });
      onClose(res);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => onClose(null)}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Register Application</h2>
          <button className="btn sm" onClick={() => onClose(null)}>✕</button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body form-stack">
            <div className="form-row-2">
              <div>
                <label className="field-label">Application Key (App ID)</label>
                <input className="input mono" placeholder="PORTAL" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} required />
              </div>
              <div>
                <label className="field-label">Display Name</label>
                <input className="input" placeholder="Campus Portal" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
              </div>
            </div>

            <div>
              <label className="field-label">Authorized Redirect URIs (space/comma separated)</label>
              <textarea
                className="input mono"
                rows="2"
                placeholder="http://localhost:3000/callback"
                value={f.uris}
                onChange={(e) => setF({ ...f, uris: e.target.value })}
                required
              />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={f.confidential}
                onChange={(e) => setF({ ...f, confidential: e.target.checked })}
              />
              <span>Confidential Client (issues a client secret for backend token verification)</span>
            </label>

            {error && <div style={{ color: '#fca5a5', fontSize: '12px' }}>{error}</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn sm" onClick={() => onClose(null)}>Cancel</button>
            <button type="submit" className="btn primary sm">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <IconPlus size={14} /> Register Application
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
