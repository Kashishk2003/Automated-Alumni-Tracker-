import React, { useState, useEffect, useRef } from 'react';

const API = 'http://127.0.0.1:8000';

const COLORS = {
  dark: {
    bg: '#080C14', surface: '#0D1421', surface2: '#111827', surface3: '#1A2235',
    border: '#1E2D45', text1: '#E8EDF5', text2: '#6B7FA3', text3: '#3D5080',
    accent: '#3B82F6', accentGlow: '#3B82F622', green: '#10B981', amber: '#F59E0B', red: '#EF4444',
    purple: '#8B5CF6',
  },
  light: {
    bg: '#F0F4FA', surface: '#FFFFFF', surface2: '#F7F9FC', surface3: '#EEF2F8',
    border: '#DDE4F0', text1: '#0D1421', text2: '#5A6A8A', text3: '#9AAAC8',
    accent: '#2563EB', accentGlow: '#2563EB18', green: '#059669', amber: '#D97706', red: '#DC2626',
    purple: '#7C3AED',
  },
};

// ── Fix 1: Better nav icons (SVG-based) ──────────────────────────────────────
const NAV = [
  { id: 'batches',   label: 'Alumni Batches', icon: 'batches'   },
  { id: 'analytics', label: 'Analytics',      icon: 'analytics' },
  { id: 'map',       label: 'Alumni Map',     icon: 'map'       },
  { id: 'path',      label: 'Find My Path',   icon: 'path'      },
  { id: 'add',       label: 'Add Profile',    icon: 'add'       },
];

const NavIcon = ({ id, color }) => {
  const s = { width: 16, height: 16, fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', flexShrink: 0 };
  switch (id) {
    case 'batches':   return <svg viewBox="0 0 24 24" style={s}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>;
    case 'analytics': return <svg viewBox="0 0 24 24" style={s}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    case 'map':       return <svg viewBox="0 0 24 24" style={s}><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>;
    case 'path':      return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="12" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>;
    case 'add':       return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 10-16 0"/><line x1="19" y1="11" x2="19" y2="17"/><line x1="16" y1="14" x2="22" y2="14"/></svg>;
    default:          return null;
  }
};

function FreshnessDot({ lastUpdated, c }) {
  if (!lastUpdated) return <span style={{ color: c.text3, fontSize: '10px' }}>—</span>;
  const days = Math.floor((Date.now() - new Date(lastUpdated)) / 86400000);
  const color = days <= 7 ? c.green : days <= 30 ? c.amber : c.red;
  const label = days <= 7 ? 'Fresh' : `${days}d ago`;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ fontSize: '10px', color }}>{label}</span>
    </span>
  );
}

// ── Fix 1: Batch year — single year → treat as enrollment, compute graduation ─
function parseBatchLabel(batch) {
  if (!batch || batch === 'Unknown') return { display: 'Unknown', sub: 'No batch info', isUnknown: true };
  const parts = batch.split('-').map(s => s.trim()).filter(Boolean);
  if (parts.length === 1 && /^\d{4}$/.test(parts[0])) {
    const enroll = parseInt(parts[0], 10);
    const grad   = enroll + 4;
    return { display: `Batch ${enroll}-${grad}`, sub: `Enrolled ${enroll} · Graduating ${grad}`, isUnknown: false, normalized: `${enroll}-${grad}` };
  }
  if (parts.length >= 2) {
    return { display: `Batch ${batch}`, sub: `Enrolled ${parts[0]} · Graduated ${parts[1]}`, isUnknown: false, normalized: batch };
  }
  return { display: `Batch ${batch}`, sub: '', isUnknown: false, normalized: batch };
}

export default function App() {
  const [profiles, setProfiles]               = useState([]);
  const [displayProfiles, setDisplayProfiles] = useState([]);
  const [stats, setStats]                     = useState({});
  const [analytics, setAnalytics]             = useState(null);

  // ── Fix 3: LinkedIn URL validation/submission ─────────────────────────────
  const [linkedinUrl, setLinkedinUrl]         = useState('');
  const [loading, setLoading]                 = useState(false);
  const [loadingMore, setLoadingMore]         = useState(false);
  const [currentPage, setCurrentPage]         = useState(1);
  const [totalPages, setTotalPages]           = useState(1);
  const [totalProfiles, setTotalProfiles]     = useState(0);
  const [page, setPage]                       = useState('batches');
  const pageHistory                           = useRef(['batches']);

  const navigate = (newPage) => {
    pageHistory.current.push(newPage);
    setPage(newPage);
    if (newPage !== 'detail' && scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const [selected, setSelected]             = useState(null);
  const [search, setSearch]                 = useState('');
  const [addTab, setAddTab]                 = useState('single');
  const [csvStatus, setCsvStatus]           = useState('');
  const [sidebarOpen, setSidebarOpen]       = useState(true);
  const [dark, setDark]                     = useState(true);
  const [confirmDelete, setConfirmDelete]         = useState(null);
  const [confirmDeleteBatch, setConfirmDeleteBatch] = useState(null);

  // ── Fix 5: Multi-select state ─────────────────────────────────────────────
  const [selectedRows, setSelectedRows]     = useState(new Set());
  const [multiMoving, setMultiMoving]       = useState(false);
  const [multiMoveTarget, setMultiMoveTarget] = useState('');
  const [multiMoveStatus, setMultiMoveStatus] = useState('');

  const [moveBatchProfile, setMoveBatchProfile] = useState(null);
  const [moveBatchTarget, setMoveBatchTarget]   = useState('');
  const [moveBatchStatus, setMoveBatchStatus]   = useState('');
  const [recentlyViewed, setRecentlyViewed] = useState([]);
  const [addStatus, setAddStatus]           = useState('');
  const [refreshing, setRefreshing]         = useState(false);

  const scrollRef      = useRef(null);
  const savedScrollPos = useRef(0);
  const touchStartX    = useRef(null);
  const touchStartY    = useRef(null);
  const swipeDelta     = useRef(0);

  const [filterCompany,  setFilterCompany]  = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [filterSkill,    setFilterSkill]    = useState('');
  const [showFilters,    setShowFilters]    = useState(false);

  const [outreachLoading, setOutreachLoading] = useState(false);
  const [outreachMsg,     setOutreachMsg]     = useState('');
  const [studentCtx,      setStudentCtx]      = useState('');
  const [copied,          setCopied]          = useState(false);

  const [pathGoal,    setPathGoal]    = useState('');
  const [pathLoading, setPathLoading] = useState(false);
  const [pathResults, setPathResults] = useState([]);

  const [batches,        setBatches]        = useState([]);
  const [selectedBatch,  setSelectedBatch]  = useState(null);
  const [batchProfiles,  setBatchProfiles]  = useState([]);
  const [batchLoading,   setBatchLoading]   = useState(false);
  const [batchSearch,    setBatchSearch]    = useState('');
  const [batchAiResults, setBatchAiResults] = useState(null);
  const [batchAiLoading, setBatchAiLoading] = useState(false);
  const [strictField,    setStrictField]    = useState('all');
  const [filteredCount,  setFilteredCount]  = useState(null);

  const [mapAlumni,    setMapAlumni]    = useState([]);
  const [mapLoading,   setMapLoading]   = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [nearestList,  setNearestList]  = useState([]);
  const [mapError,     setMapError]     = useState('');
  const [leafletReady, setLeafletReady] = useState(false);
  const [selectedCity, setSelectedCity] = useState(null);

  const c = dark ? COLORS.dark : COLORS.light;

  const S = {
    btn: (v) => ({
      padding: '7px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer',
      fontSize: '12px', fontWeight: '600', transition: 'all 0.15s',
      ...(v === 'primary' ? { background: c.accent,   color: 'white' }
        : v === 'ghost'   ? { background: c.surface3, color: c.text2, border: `1px solid ${c.border}` }
        : v === 'danger'  ? { background: c.red,      color: 'white' }
        : v === 'purple'  ? { background: c.purple,   color: 'white' }
        : v === 'green'   ? { background: c.green,    color: 'white' }
        : v === 'teal'    ? { background: '#14B8A6',  color: 'white' }
        : {}),
    }),
    card:      { background: c.surface, borderRadius: '12px', padding: '20px', border: `1px solid ${c.border}` },
    cardTitle: { color: c.text3, margin: '0 0 12px', fontSize: '10px', fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase' },
    input:     { padding: '9px 13px', borderRadius: '8px', border: `1px solid ${c.border}`, fontSize: '13px', background: c.surface, color: c.text1, outline: 'none' },
    select:    { padding: '7px 10px', borderRadius: '8px', border: `1px solid ${c.border}`, fontSize: '12px', background: c.surface, color: c.text1, outline: 'none', cursor: 'pointer' },
    iconBtn:   (color) => ({ background: color + '15', color, border: 'none', width: '26px', height: '26px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }),
    th:        { padding: '10px 16px', textAlign: 'left', fontSize: '10px', fontWeight: '700', color: c.text3, background: c.surface2, borderBottom: `1px solid ${c.border}`, letterSpacing: '0.8px', textTransform: 'uppercase' },
    td:        { padding: '11px 16px', fontSize: '13px' },
    checkbox:  { width: '15px', height: '15px', accentColor: c.accent, cursor: 'pointer' },
  };

  useEffect(() => { fetchData(); fetchRecentlyViewed(); }, []); // eslint-disable-line

  useEffect(() => {
    if (document.getElementById('leaflet-css')) { setLeafletReady(true); return; }
    const link  = document.createElement('link');
    link.id     = 'leaflet-css'; link.rel = 'stylesheet';
    link.href   = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(link);
    const script  = document.createElement('script');
    script.src    = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    script.onload = () => setLeafletReady(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (page !== 'map' || mapAlumni.length > 0) return;
    loadMapData();
  }, [page]); // eslint-disable-line

  const loadMapData = async () => {
    setMapLoading(true); setMapError('');
    try {
      const r    = await fetch(`${API}/map-data`);
      const data = await r.json();
      setMapAlumni(data.alumni || []);
    } catch { setMapError('Failed to load map data. Is the backend running?'); }
    setMapLoading(false);
  };

  const getUserLocation = () => {
    if (!navigator.geolocation) { setMapError('Geolocation not supported.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ul = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(ul);
        const withDist = mapAlumni.map(a => {
          const dlat = a.city_lat - ul.lat, dlng = a.city_lng - ul.lng;
          return { ...a, dist_km: Math.round(Math.sqrt(dlat*dlat + dlng*dlng) * 111) };
        });
        withDist.sort((a, b) => a.dist_km - b.dist_km);
        setNearestList(withDist.slice(0, 5));
      },
      () => setMapError('Location access denied.')
    );
  };

  const fetchData = async (pg = 1) => {
    const p     = await fetch(`${API}/profiles?page=${pg}&page_size=100`);
    const pData = await p.json();
    const newPs = pData.profiles || [];
    if (pg === 1) {
      setProfiles(newPs);
      if (!search || search.trim() === '') setDisplayProfiles(newPs);
    } else {
      setProfiles(prev => {
        const merged = [...prev, ...newPs];
        if (!search || search.trim() === '') setDisplayProfiles(merged);
        return merged;
      });
    }
    setCurrentPage(pData.page || 1); setTotalPages(pData.total_pages || 1); setTotalProfiles(pData.total || newPs.length);
    const s = await fetch(`${API}/stats`); setStats(await s.json());
  };

  const fetchRecentlyViewed = async () => {
    const r = await fetch(`${API}/recently-viewed`); const data = await r.json();
    setRecentlyViewed(data.profiles || []);
  };

  const fetchAnalytics = async () => {
    const r = await fetch(`${API}/analytics`); setAnalytics(await r.json());
  };

  const fetchBatches = async () => {
    const r = await fetch(`${API}/batches`); const data = await r.json();
    setBatches(data.batches || []);
  };

  const openBatch = async (batch) => {
    setSelectedBatch(batch); setBatchLoading(true); setBatchSearch(''); setBatchAiResults(null); setFilteredCount(null);
    setSelectedRows(new Set());
    if (batch === '__all__') {
      const r = await fetch(`${API}/profiles?page=1&page_size=100`); const data = await r.json();
      setBatchProfiles(data.profiles || []); setCurrentPage(data.page || 1); setTotalPages(data.total_pages || 1); setTotalProfiles(data.total || 0);
    } else {
      const r = await fetch(`${API}/batches/${encodeURIComponent(batch)}`); const data = await r.json();
      setBatchProfiles(data.profiles || []);
    }
    setBatchLoading(false);
  };

  useEffect(() => { if (page === 'analytics' && !analytics) fetchAnalytics(); }, [page]); // eslint-disable-line
  useEffect(() => { if (page === 'batches' && batches.length === 0) fetchBatches(); }, [page, batches.length]); // eslint-disable-line

  useEffect(() => {
    if (!batchProfiles.length) { setFilteredCount(null); return; }
    const source = batchAiResults !== null ? batchAiResults : batchProfiles;
    const terms  = (!batchAiResults && batchSearch) ? batchSearch.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];
    const hasActive = terms.length > 0 || batchAiResults !== null || filterCompany || filterLocation || filterSkill;
    if (!hasActive) { setFilteredCount(null); return; }
    const count = source.filter(p => {
      if (filterCompany  && p.current_company !== filterCompany) return false;
      if (filterLocation && !p.location?.includes(filterLocation)) return false;
      if (filterSkill    && !(p.skills || []).some(s => s.toLowerCase().includes(filterSkill.toLowerCase()))) return false;
      if (!terms.length) return true;
      return terms.some(q => matchProfile(p, q, strictField));
    }).length;
    setFilteredCount(count);
  }, [batchSearch, batchAiResults, filterCompany, filterLocation, filterSkill, strictField, batchProfiles]); // eslint-disable-line

  useEffect(() => {
    if (page !== 'map' || !leafletReady || mapAlumni.length === 0) return;
    const L = window.L; if (!L) return;
    const container = document.getElementById('alumni-map');
    if (!container) return;
    if (container._leaflet_id) container._leaflet_id = null;
    const map = L.map('alumni-map', { zoomControl: true }).setView([20.5937, 78.9629], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(map);
    const cityMap = {};
    mapAlumni.forEach(a => {
      const key = `${a.city_lat},${a.city_lng}`;
      if (!cityMap[key]) cityMap[key] = { name: a.location?.split(',')[0]?.trim() || a.location, lat: a.city_lat, lng: a.city_lng, alumni: [] };
      cityMap[key].alumni.push(a);
    });
    Object.values(cityMap).forEach(city => {
      const count = city.alumni.length, size = Math.min(20 + count * 4, 52);
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#3B82F6;border:3px solid white;box-shadow:0 2px 8px #0004;display:flex;align-items:center;justify-content:center;font-family:DM Sans,sans-serif;font-size:${count>9?11:13}px;font-weight:700;color:white;cursor:pointer;">${count}</div>`,
        iconSize: [size, size], iconAnchor: [size/2, size/2],
      });
      L.marker([city.lat, city.lng], { icon }).addTo(map).on('click', () => window.__openCityPanel(city));
    });
    window.__openCityPanel = (city) => setSelectedCity(city);
    if (userLocation) {
      const youIcon = L.divIcon({ className: '', html: `<div style="width:16px;height:16px;border-radius:50%;background:#EF4444;border:3px solid white;box-shadow:0 0 0 3px #EF444455;"></div>`, iconSize: [16,16], iconAnchor: [8,8] });
      L.marker([userLocation.lat, userLocation.lng], { icon: youIcon }).addTo(map).bindPopup('<b>📍 You are here</b>').openPopup();
      map.setView([userLocation.lat, userLocation.lng], 6);
    }
    return () => { try { map.remove(); } catch {} };
  }, [page, leafletReady, mapAlumni, userLocation]); // eslint-disable-line

  // ── Helpers ────────────────────────────────────────────────────────────────
  const matchProfile = (p, q, field) => {
    if (field === 'position')       return (p.current_position || '').toLowerCase().includes(q);
    if (field === 'company')        return (p.current_company  || '').toLowerCase().includes(q);
    if (field === 'location')       return (p.location         || '').toLowerCase().includes(q);
    if (field === 'skills')         return (p.skills || []).some(s => s.toLowerCase().includes(q));
    if (field === 'past_roles')     return (p.work_history || []).some(w => (w.role||'').toLowerCase().includes(q)||(w.description||'').toLowerCase().includes(q));
    if (field === 'any_experience') return (p.current_position||'').toLowerCase().includes(q)||(p.work_history||[]).some(w=>(w.role||'').toLowerCase().includes(q)||(w.description||'').toLowerCase().includes(q));
    return (
      (p.name||'').toLowerCase().includes(q)||(p.current_company||'').toLowerCase().includes(q)||
      (p.location||'').toLowerCase().includes(q)||(p.current_position||'').toLowerCase().includes(q)||
      (p.skills||[]).some(s=>s.toLowerCase().includes(q))||
      (p.work_history||[]).some(w=>(w.company||'').toLowerCase().includes(q)||(w.role||'').toLowerCase().includes(q)||(w.description||'').toLowerCase().includes(q))||
      (p.education||[]).some(e=>(e.institution||'').toLowerCase().includes(q)||(e.degree||'').toLowerCase().includes(q))||
      (p.batch||'').toLowerCase().includes(q)
    );
  };

  const normalizeSkill = (s) => { const m = s.match(/\(([^)]+)\)$/); return m ? m[1].trim() : s.trim(); };
  const applyFilters   = (list) => list.filter(p => {
    if (filterCompany  && p.current_company !== filterCompany) return false;
    if (filterLocation && !p.location?.includes(filterLocation)) return false;
    if (filterSkill    && !(p.skills||[]).some(s => normalizeSkill(s).toLowerCase() === filterSkill.toLowerCase() || s.toLowerCase().includes(filterSkill.toLowerCase()))) return false;
    return true;
  });
  const clearFilters = () => { setFilterCompany(''); setFilterLocation(''); setFilterSkill(''); };
  const filtered = applyFilters(displayProfiles);

  const exportCSV = () => {
    const toExport = filtered.length > 0 ? filtered : profiles;
    const headers  = ['Name','Position','Company','Location','LinkedIn URL','Skills','Timeline'];
    const rows     = toExport.map(p => [p.name||'',p.current_position||'',p.current_company||'',p.location||'',p.linkedin_url||'',(p.skills||[]).join('; '),p.timeline||'']);
    const csv  = [headers,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a    = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='alumni_export.csv'; a.click();
  };

  // ── Fix 3: LinkedIn URL — normalize & validate properly ───────────────────
  const normalizeLinkedinUrl = (raw) => {
    let url = raw.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    try { const u = new URL(url); return u.origin + u.pathname.replace(/\/$/, ''); } catch { return url; }
  };

  const addProfile = async () => {
    if (!linkedinUrl.trim()) return;
    const raw = linkedinUrl.trim();
    // Accept linkedin.com/in/ with or without protocol/www
    if (!raw.replace(/^https?:\/\/(www\.)?/i, '').startsWith('linkedin.com/in/')) {
      setAddStatus('❌ Must be a LinkedIn profile URL — e.g. linkedin.com/in/username');
      return;
    }
    const normalized = normalizeLinkedinUrl(raw);
    setLoading(true); setAddStatus('⏳ Sending to backend...');
    try {
      const res = await fetch(`${API}/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedin_url: normalized }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setAddStatus('❌ Backend error: ' + (err.detail || res.status));
      } else {
        setLinkedinUrl(''); setAddStatus('✅ Profile added successfully!'); fetchData();
      }
    } catch (e) { setAddStatus('❌ Network error — is your backend running? ' + (e.message || '')); }
    setLoading(false);
  };

  const deleteProfile = async (linkedin_url) => {
    await fetch(`${API}/profile`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkedin_url }) });
    setConfirmDelete(null); fetchData();
  };

  // ── Fix 2: Move button — backend endpoint uses /move-batch correctly ──────
  const doMoveBatch = async () => {
    if (!moveBatchProfile || !moveBatchTarget) return;
    setMoveBatchStatus('Moving...');
    try {
      const res = await fetch(`${API}/move-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedin_url: moveBatchProfile.linkedin_url, new_batch: moveBatchTarget }),
      });
      if (!res.ok) {
        let errMsg = `Server error ${res.status}`;
        try { const e = await res.json(); errMsg = e.detail || errMsg; } catch {}
        setMoveBatchStatus(`❌ ${errMsg}`);
        return;
      }
      setMoveBatchStatus('✅ Moved!');
      setTimeout(() => { setMoveBatchProfile(null); setMoveBatchTarget(''); setMoveBatchStatus(''); fetchBatches(); if (selectedBatch) openBatch(selectedBatch); }, 800);
    } catch (e) { setMoveBatchStatus(`❌ Network error: ${e.message || 'Check your backend'}`); }
  };

  // ── Fix 5: Multi-select move ──────────────────────────────────────────────
  const toggleRow = (url) => {
    setSelectedRows(prev => {
      const next = new Set(prev);
      next.has(url) ? next.delete(url) : next.add(url);
      return next;
    });
  };

  const toggleAllRows = (list) => {
    if (selectedRows.size === list.length) { setSelectedRows(new Set()); }
    else { setSelectedRows(new Set(list.map(p => p.linkedin_url))); }
  };

  const doMultiMove = async () => {
    if (!multiMoveTarget || selectedRows.size === 0) return;
    setMultiMoveStatus(`Moving ${selectedRows.size} students...`);
    let ok = 0, fail = 0;
    for (const url of selectedRows) {
      try {
        const res = await fetch(`${API}/move-batch`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkedin_url: url, new_batch: multiMoveTarget }),
        });
        if (res.ok) { ok++; } else { fail++; console.warn('move failed for', url, res.status); }
      } catch (e) { fail++; console.warn('network error for', url, e); }
    }
    if (ok > 0 || fail === 0) {
      setMultiMoveStatus(`✅ Moved ${ok} student${ok !== 1 ? 's' : ''}${fail ? ` · ❌ ${fail} failed` : ''}`);
      setTimeout(() => { setMultiMoving(false); setMultiMoveTarget(''); setMultiMoveStatus(''); setSelectedRows(new Set()); fetchBatches(); if (selectedBatch) openBatch(selectedBatch); }, 1200);
    } else {
      setMultiMoveStatus(`❌ All ${fail} moves failed — check backend`);
    }
  };

  const doDeleteBatch = async () => {
    if (!confirmDeleteBatch) return;
    try {
      // Backend uses POST /delete-batch (not DELETE)
      await fetch(`${API}/delete-batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: confirmDeleteBatch.batch }) });
    } catch {}
    setConfirmDeleteBatch(null); fetchBatches(); fetchData();
  };

  const handleCSV = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const text = await file.text(); const lines = text.split('\n').filter(l => l.trim());
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const urlIndex = header.indexOf('linkedin_url');
    if (urlIndex === -1) { setCsvStatus('❌ Column linkedin_url not found!'); return; }
    const urls = lines.slice(1).map(l => l.split(',')[urlIndex]?.trim()).filter(Boolean);
    let success = 0;
    for (const u of urls) {
      await fetch(`${API}/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkedin_url: u }) });
      setCsvStatus(`Processing ${++success} / ${urls.length}...`);
    }
    setCsvStatus(`✅ Done! ${success} profiles added.`); fetchData();
  };

  const handleSearch = (query) => {
    setSearch(query);
    if (!query.trim()) { setDisplayProfiles(profiles); return; }
    const terms = query.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    setDisplayProfiles(profiles.filter(p => terms.some(q => matchProfile(p, q, strictField))));
  };

  const handleRAGSearch = async (query) => {
    if (!query?.trim()) return;
    try {
      const r = await fetch(`${API}/search?q=${encodeURIComponent(query)}`); const data = await r.json();
      const ragProfiles = data.profiles || [];
      if (!ragProfiles.length) { setDisplayProfiles([]); return; }
      setDisplayProfiles(ragProfiles.map(rp => profiles.find(p => p.linkedin_url === rp.linkedin_url || p.name?.toLowerCase().trim() === rp.name?.toLowerCase().trim()) || rp));
    } catch (err) { console.log('RAG error:', err); }
  };

  const handleBatchAISearch = async (query) => {
    if (!query?.trim()) return;
    setBatchAiLoading(true);
    try {
      const r = await fetch(`${API}/search?q=${encodeURIComponent(query)}`); const data = await r.json();
      let ragProfiles = data.profiles || [];
      if (selectedBatch && selectedBatch !== '__all__') ragProfiles = ragProfiles.filter(rp => batchProfiles.find(bp => bp.linkedin_url === rp.linkedin_url));
      setBatchAiResults(ragProfiles.map(rp => batchProfiles.find(p => p.linkedin_url === rp.linkedin_url) || profiles.find(p => p.linkedin_url === rp.linkedin_url) || rp));
    } catch { setBatchAiResults([]); }
    setBatchAiLoading(false);
  };

  const viewProfile = async (p) => {
    savedScrollPos.current = scrollRef.current?.scrollTop || 0;
    setSelected(p); pageHistory.current.push('detail'); setPage('detail');
    setOutreachMsg(''); setStudentCtx(''); setCopied(false);
    await fetch(`${API}/viewed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkedin_url: p.linkedin_url }) });
    fetchRecentlyViewed();
  };

  const goBack = () => {
    pageHistory.current.pop();
    const prev = pageHistory.current[pageHistory.current.length - 1] || 'batches';
    const pos  = savedScrollPos.current;
    setPage(prev);
    const tryRestore = (attempts) => {
      const el = scrollRef.current;
      if (!el) { if (attempts > 0) setTimeout(() => tryRestore(attempts-1), 80); return; }
      el.scrollTop = pos;
      if (Math.abs(el.scrollTop - pos) > 10 && attempts > 0) setTimeout(() => tryRestore(attempts-1), 80);
    };
    setTimeout(() => tryRestore(8), 30);
  };

  const generateOutreach = async () => {
    if (!selected) return;
    setOutreachLoading(true); setOutreachMsg('');
    try {
      const r = await fetch(`${API}/outreach`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linkedin_url: selected.linkedin_url, student_context: studentCtx }) });
      const data = await r.json(); setOutreachMsg(data.message || '');
    } catch { setOutreachMsg('❌ Failed to generate message.'); }
    setOutreachLoading(false);
  };

  const findPath = async () => {
    if (!pathGoal.trim()) return;
    setPathLoading(true); setPathResults([]);
    try {
      const r = await fetch(`${API}/find-path`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: pathGoal }) });
      const data = await r.json(); setPathResults(data.results || []);
    } catch {}
    setPathLoading(false);
  };

  const manualRefresh = async () => { setRefreshing(true); await fetch(`${API}/refresh`); setRefreshing(false); fetchData(); };
  const copyToClipboard = (text) => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  const handleTouchStart = (e) => { touchStartX.current = e.touches[0].clientX; touchStartY.current = e.touches[0].clientY; };
  const handleTouchEnd   = (e) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY.current);
    if (dx > 80 && dy < 60 && pageHistory.current.length > 1) goBack();
    touchStartX.current = null;
  };
  const handleWheel = (e) => {
    if (pageHistory.current.length <= 1) return;
    if (e.deltaX < -8) { swipeDelta.current += Math.abs(e.deltaX); if (swipeDelta.current > 120) { swipeDelta.current = 0; goBack(); } }
    else swipeDelta.current = 0;
  };

  const pageLabel =
    page === 'batches'   ? (selectedBatch ? (selectedBatch === '__all__' ? 'All Students' : `Batch ${selectedBatch}`) : 'Alumni Batches')
    : page === 'add'     ? 'Add Profile'
    : page === 'analytics' ? 'Analytics'
    : page === 'map'     ? 'Alumni Map'
    : page === 'path'    ? 'Find My Path'
    : page === 'detail'  ? (selected?.name || 'Profile')
    : 'Alumni Batches';

  // ── Batch table rows ───────────────────────────────────────────────────────
  const renderBatchRows = () => {
    const source = batchAiResults !== null ? batchAiResults : batchProfiles;
    const terms  = (!batchAiResults && batchSearch) ? batchSearch.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];
    const list   = source.filter(p => {
      if (filterCompany  && p.current_company !== filterCompany) return false;
      if (filterLocation && !p.location?.includes(filterLocation)) return false;
      if (filterSkill    && !(p.skills||[]).some(s => s.toLowerCase().includes(filterSkill.toLowerCase()))) return false;
      if (!terms.length) return true;
      return terms.some(q => matchProfile(p, q, strictField));
    });

    if (list.length === 0) return (
      <tr><td colSpan={8} style={{ padding: '48px', textAlign: 'center', color: c.text3, fontSize: '13px' }}>
        {batchSearch ? 'No results found' : 'No alumni in this batch yet'}
      </td></tr>
    );

    return list.map((p, i) => {
      const isChecked = selectedRows.has(p.linkedin_url);
      return (
        <tr
          key={p.linkedin_url || i}
          style={{ borderBottom: `1px solid ${c.border}`, background: isChecked ? c.accentGlow : i % 2 === 0 ? c.surface : c.surface2, cursor: 'pointer', transition: 'background 0.15s' }}
          onMouseEnter={e => { if (!isChecked) e.currentTarget.style.background = c.accentGlow; }}
          onMouseLeave={e => { if (!isChecked) e.currentTarget.style.background = i % 2 === 0 ? c.surface : c.surface2; }}
        >
          {/* ── Fix 5: Checkbox column ── */}
          <td style={{ ...S.td, width: '36px', paddingRight: '4px' }} onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={isChecked}
              onChange={() => toggleRow(p.linkedin_url)}
              style={S.checkbox}
            />
          </td>
          <td style={{ ...S.td, fontWeight: '600', color: c.text1 }} onClick={() => viewProfile(p)}>{p.name}</td>
          <td style={{ ...S.td, color: c.text2 }} onClick={() => viewProfile(p)}>{p.current_position || '—'}</td>
          <td style={S.td} onClick={() => viewProfile(p)}>
            <span style={{ background: c.accentGlow, color: c.accent, padding: '3px 9px', borderRadius: '20px', fontSize: '11px', fontWeight: '600' }}>{p.current_company || '—'}</span>
          </td>
          <td style={{ ...S.td, color: c.text2 }} onClick={() => viewProfile(p)}>{p.location || '—'}</td>
          <td style={{ ...S.td, color: c.text3, fontSize: '12px' }} onClick={() => viewProfile(p)}>{p.timeline || '—'}</td>
          <td style={S.td} onClick={() => viewProfile(p)}><FreshnessDot lastUpdated={p.last_updated} c={dark ? COLORS.dark : COLORS.light} /></td>
          <td style={{ ...S.td, whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
            <button
              onClick={() => { setMoveBatchProfile(p); setMoveBatchTarget(''); setMoveBatchStatus(''); }}
              style={{ ...S.iconBtn('#14B8A6'), marginRight: '5px', width: 'auto', padding: '0 8px', fontSize: '11px', fontWeight: '600' }}
              title="Move to another batch"
            >⇄ Move</button>
            <button onClick={() => setConfirmDelete(p)} style={S.iconBtn(c.red)}>✕</button>
          </td>
        </tr>
      );
    });
  };

  // ── Compute filtered list for multi-move badge ─────────────────────────────
  const getFilteredList = () => {
    const source = batchAiResults !== null ? batchAiResults : batchProfiles;
    const terms  = (!batchAiResults && batchSearch) ? batchSearch.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];
    return source.filter(p => {
      if (filterCompany  && p.current_company !== filterCompany) return false;
      if (filterLocation && !p.location?.includes(filterLocation)) return false;
      if (filterSkill    && !(p.skills||[]).some(s => s.toLowerCase().includes(filterSkill.toLowerCase()))) return false;
      if (!terms.length) return true;
      return terms.some(q => matchProfile(p, q, strictField));
    });
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'DM Sans','Helvetica Neue',sans-serif", background: c.bg, color: c.text1 }}>

      {/* ── Delete Profile Modal ── */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: '#00000070', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: c.surface, borderRadius: '14px', padding: '26px', width: '380px', border: `1px solid ${c.border}` }}>
            <h3 style={{ color: c.text1, margin: '0 0 8px', fontSize: '16px', fontWeight: '700' }}>Delete Profile</h3>
            <p style={{ color: c.text2, fontSize: '13px', margin: '0 0 20px', lineHeight: '1.7' }}>Remove <strong style={{ color: c.text1 }}>{confirmDelete.name}</strong>? This cannot be undone.</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(null)} style={S.btn('ghost')}>Cancel</button>
              <button onClick={() => deleteProfile(confirmDelete.linkedin_url)} style={S.btn('danger')}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Move Batch Modal (single) ── */}
      {moveBatchProfile && (
        <div style={{ position: 'fixed', inset: 0, background: '#00000070', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: c.surface, borderRadius: '14px', padding: '26px', width: '420px', border: `1px solid ${c.border}` }}>
            <h3 style={{ color: c.text1, margin: '0 0 4px', fontSize: '16px', fontWeight: '700' }}>Move to Another Batch</h3>
            <p style={{ color: c.text2, fontSize: '13px', margin: '0 0 18px', lineHeight: '1.6' }}>
              Moving <strong style={{ color: c.text1 }}>{moveBatchProfile.name}</strong> from{' '}
              <span style={{ color: c.accent, fontWeight: '600' }}>{selectedBatch === '__all__' ? 'All Students' : `Batch ${selectedBatch}`}</span>
            </p>
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '10px', color: c.text3, fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '7px' }}>Select Target Batch</div>
              <select value={moveBatchTarget} onChange={e => setMoveBatchTarget(e.target.value)} style={{ ...S.select, width: '100%', padding: '10px 12px', fontSize: '13px' }}>
                <option value="">— Choose a batch —</option>
                {batches.filter(b => b.batch !== selectedBatch && b.batch !== 'Unknown').map(b => {
                  const parsed = parseBatchLabel(b.batch);
                  return <option key={b.batch} value={parsed.normalized || b.batch}>{`${parsed.display} (${b.count} alumni)`}</option>;
                })}
                <option value="__new__">+ Enter custom batch...</option>
              </select>
            </div>
            {moveBatchTarget === '__new__' && (
              <div style={{ marginBottom: '14px' }}>
                <div style={{ fontSize: '10px', color: c.text3, fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '7px' }}>Custom Batch (e.g. 2023-2027)</div>
                <input placeholder="YYYY-YYYY" onChange={e => setMoveBatchTarget(e.target.value === '__new__' ? '' : e.target.value)} style={{ ...S.input, width: '100%', boxSizing: 'border-box' }} />
              </div>
            )}
            {moveBatchStatus && (
              <div style={{ fontSize: '12px', color: moveBatchStatus.startsWith('✅') ? c.green : moveBatchStatus.startsWith('❌') ? c.red : c.amber, marginBottom: '12px', fontWeight: '600' }}>{moveBatchStatus}</div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => { setMoveBatchProfile(null); setMoveBatchTarget(''); setMoveBatchStatus(''); }} style={S.btn('ghost')}>Cancel</button>
              <button
                onClick={doMoveBatch}
                disabled={!moveBatchTarget || moveBatchTarget === '__new__' || !!moveBatchStatus}
                style={{ ...S.btn('teal'), opacity: (!moveBatchTarget || moveBatchTarget === '__new__') ? 0.5 : 1 }}
              >⇄ Move Student</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Multi-Move Modal ── */}
      {multiMoving && (
        <div style={{ position: 'fixed', inset: 0, background: '#00000070', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: c.surface, borderRadius: '14px', padding: '26px', width: '440px', border: `1px solid ${c.border}` }}>
            <h3 style={{ color: c.text1, margin: '0 0 4px', fontSize: '16px', fontWeight: '700' }}>Move {selectedRows.size} Students</h3>
            <p style={{ color: c.text2, fontSize: '13px', margin: '0 0 18px', lineHeight: '1.6' }}>
              Select the destination batch for all <strong style={{ color: c.accent }}>{selectedRows.size}</strong> selected students.
            </p>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '10px', color: c.text3, fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '7px' }}>Destination Batch</div>
              <select value={multiMoveTarget} onChange={e => setMultiMoveTarget(e.target.value)} style={{ ...S.select, width: '100%', padding: '10px 12px', fontSize: '13px' }}>
                <option value="">— Choose a batch —</option>
                {batches.filter(b => b.batch !== selectedBatch && b.batch !== 'Unknown').map(b => {
                  const parsed = parseBatchLabel(b.batch);
                  return <option key={b.batch} value={parsed.normalized || b.batch}>{`${parsed.display} (${b.count} alumni)`}</option>;
                })}
                <option value="__custom__">+ Custom batch...</option>
              </select>
            </div>
            {multiMoveTarget === '__custom__' && (
              <div style={{ marginBottom: '16px' }}>
                <input placeholder="e.g. 2023-2027" onChange={e => setMultiMoveTarget(e.target.value === '__custom__' ? '' : e.target.value)} style={{ ...S.input, width: '100%', boxSizing: 'border-box' }} />
              </div>
            )}
            {multiMoveStatus && (
              <div style={{ fontSize: '12px', color: multiMoveStatus.startsWith('✅') ? c.green : multiMoveStatus.startsWith('❌') ? c.red : c.amber, marginBottom: '12px', fontWeight: '600' }}>{multiMoveStatus}</div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => { setMultiMoving(false); setMultiMoveTarget(''); setMultiMoveStatus(''); }} style={S.btn('ghost')}>Cancel</button>
              <button
                onClick={doMultiMove}
                disabled={!multiMoveTarget || multiMoveTarget === '__custom__' || !!multiMoveStatus}
                style={{ ...S.btn('teal'), opacity: (!multiMoveTarget || multiMoveTarget === '__custom__') ? 0.5 : 1 }}
              >⇄ Move {selectedRows.size} Students</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Batch Modal ── */}
      {confirmDeleteBatch && (
        <div style={{ position: 'fixed', inset: 0, background: '#00000080', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: c.surface, borderRadius: '14px', padding: '28px', width: '400px', border: `1px solid ${c.red}44` }}>
            <div style={{ fontSize: '28px', marginBottom: '12px' }}>🗑</div>
            <h3 style={{ color: c.text1, margin: '0 0 8px', fontSize: '17px', fontWeight: '700' }}>Delete Entire Batch?</h3>
            <p style={{ color: c.text2, fontSize: '13px', margin: '0 0 6px', lineHeight: '1.7' }}>
              Permanently delete <strong style={{ color: c.red }}>{parseBatchLabel(confirmDeleteBatch.batch).display}</strong> and all{' '}
              <strong style={{ color: c.red }}>{confirmDeleteBatch.count} student profiles</strong> in it.
            </p>
            <p style={{ color: c.text3, fontSize: '12px', margin: '0 0 22px' }}>This cannot be undone.</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDeleteBatch(null)} style={S.btn('ghost')}>Cancel</button>
              <button onClick={doDeleteBatch} style={{ ...S.btn('danger'), padding: '8px 18px' }}>🗑 Delete Batch</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sidebar ── */}
      <div style={{ width: sidebarOpen ? '220px' : '0px', minWidth: sidebarOpen ? '220px' : '0px', background: c.surface, borderRight: `1px solid ${c.border}`, overflow: 'hidden', transition: 'width 0.2s, min-width 0.2s', height: '100vh', position: 'sticky', top: 0, flexShrink: 0, zIndex: 30 }}>
        <div style={{ width: '220px', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          <div style={{ padding: '18px 16px 14px', borderBottom: `1px solid ${c.border}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: `linear-gradient(135deg, ${c.accent}, #6366F1)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', color: 'white', fontWeight: '800', flexShrink: 0 }}>A</div>
            <div>
              <div style={{ fontSize: '13px', fontWeight: '700', color: c.text1 }}>Alumni Tracker</div>
              <div style={{ fontSize: '10px', color: c.text3 }}>Network Intelligence</div>
            </div>
          </div>

          <div style={{ padding: '10px 8px', flex: 1 }}>
            {NAV.map(n => {
              const isActive = page === n.id || (page === 'detail' && n.id === 'batches');
              return (
                <button
                  key={n.id}
                  onClick={() => navigate(n.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '9px 12px', borderRadius: '8px', border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: '13px', fontWeight: isActive ? '600' : '500', marginBottom: '2px', background: isActive ? c.accentGlow : 'transparent', color: isActive ? c.accent : c.text2, transition: 'all 0.15s' }}
                >
                  <NavIcon id={n.id} color={isActive ? c.accent : c.text2} />
                  {n.label}
                </button>
              );
            })}

            <div style={{ fontSize: '10px', color: c.text3, letterSpacing: '1.2px', fontWeight: '600', padding: '14px 12px 6px', textTransform: 'uppercase' }}>Recently Viewed</div>
            {recentlyViewed.length === 0
              ? <div style={{ fontSize: '11px', color: c.text3, padding: '6px 12px' }}>Nothing yet</div>
              : recentlyViewed.map(p => (
                <button key={p.linkedin_url} onClick={() => viewProfile(p)} style={{ display: 'block', width: '100%', padding: '7px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: '12px', background: selected?.linkedin_url === p.linkedin_url && page === 'detail' ? c.accentGlow : 'transparent', color: selected?.linkedin_url === p.linkedin_url && page === 'detail' ? c.accent : c.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '1px' }}>
                  {p.name}
                </button>
              ))
            }
          </div>
        </div>
      </div>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onWheel={handleWheel}>

        {/* Topbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', height: '52px', background: c.surface, borderBottom: `1px solid ${c.border}`, position: 'sticky', top: 0, zIndex: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button onClick={() => setSidebarOpen(!sidebarOpen)} style={{ background: 'transparent', border: `1px solid ${c.border}`, color: c.text2, width: '32px', height: '32px', borderRadius: '7px', cursor: 'pointer', fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>☰</button>
            <span style={{ fontSize: '14px', fontWeight: '600', color: c.text1 }}>{pageLabel}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {page === 'batches' && (
              <button onClick={manualRefresh} disabled={refreshing} style={{ ...S.btn('ghost'), opacity: refreshing ? 0.6 : 1 }}>
                {refreshing ? '⏳ Refreshing...' : '↻ Refresh'}
              </button>
            )}
            <button onClick={() => setDark(!dark)} style={{ background: 'transparent', border: `1px solid ${c.border}`, color: c.text2, width: '32px', height: '32px', borderRadius: '7px', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {dark ? '☀' : '☾'}
            </button>
          </div>
        </div>

        {/* ── Page Content ── */}
        <div ref={scrollRef} style={{ flex: 1, padding: '26px 30px', overflowY: 'auto' }}>

          {/* ── DETAIL ── */}
          {page === 'detail' && selected && (
            <div>
              <button onClick={goBack} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: c.surface, border: `1px solid ${c.border}`, color: c.text1, cursor: 'pointer', fontSize: '14px', marginBottom: '20px', padding: '10px 20px', borderRadius: '10px', fontWeight: '600', transition: 'all 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = c.accent; e.currentTarget.style.color = c.accent; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = c.border; e.currentTarget.style.color = c.text1; }}
              >← Back</button>

              <div style={{ background: 'linear-gradient(135deg, #1A2744, #0D1B3E)', borderRadius: '14px', padding: '26px 30px', marginBottom: '18px', border: '1px solid #1E3060', position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%', background: '#3B82F610' }} />
                <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                  <div>
                    <h2 style={{ margin: '0 0 4px', color: 'white', fontSize: '22px', fontWeight: '800' }}>{selected.name}</h2>
                    <p style={{ margin: '0 0 10px', color: '#93C5FD', fontSize: '13px' }}>{selected.current_position} · {selected.current_company}</p>
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                      <span style={{ color: '#BFDBFE', fontSize: '12px' }}>📍 {selected.location}</span>
                      <span style={{ color: '#BFDBFE', fontSize: '12px' }}>🗓 {selected.timeline}</span>
                      {selected.last_updated && <FreshnessDot lastUpdated={selected.last_updated} c={COLORS.dark} />}
                    </div>
                  </div>
                  {selected.linkedin_url && (
                    <a href={selected.linkedin_url.startsWith('http') ? selected.linkedin_url : `https://${selected.linkedin_url}`} target="_blank" rel="noreferrer" style={{ background: '#3B82F620', color: '#93C5FD', padding: '7px 13px', borderRadius: '8px', fontSize: '12px', fontWeight: '600', textDecoration: 'none', border: '1px solid #3B82F630', whiteSpace: 'nowrap' }}>LinkedIn ↗</a>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '16px' }}>
                <div style={{ flex: 1.4, display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {selected.professional_summary && (
                    <div style={S.card}>
                      <h4 style={S.cardTitle}>Professional Summary</h4>
                      <p style={{ color: c.text2, lineHeight: '1.8', fontSize: '13px', margin: 0 }}>{selected.professional_summary}</p>
                    </div>
                  )}
                  {selected.work_history?.length > 0 && (
                    <div style={S.card}>
                      <h4 style={S.cardTitle}>Work History</h4>
                      {selected.work_history.map((w, i) => (
                        <div key={i} style={{ padding: '13px 15px', background: c.surface2, borderRadius: '9px', marginBottom: '10px', borderLeft: `3px solid ${c.accent}` }}>
                          <div style={{ fontWeight: '700', color: c.text1, fontSize: '13px' }}>{w.role} · {w.company}</div>
                          <div style={{ color: c.accent, fontSize: '11px', margin: '3px 0', fontWeight: '600' }}>{w.period}</div>
                          <div style={{ color: c.text2, fontSize: '12px', lineHeight: '1.7' }}>{w.description}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={S.card}>
                    <h4 style={S.cardTitle}>✉ Outreach Message Generator</h4>
                    <input value={studentCtx} onChange={e => setStudentCtx(e.target.value)} placeholder="Your goal (e.g. 'I'm a CS student interested in AI roles')" style={{ ...S.input, width: '100%', marginBottom: '10px', boxSizing: 'border-box' }} />
                    <button onClick={generateOutreach} disabled={outreachLoading} style={{ ...S.btn('purple'), opacity: outreachLoading ? 0.6 : 1 }}>{outreachLoading ? '⏳ Generating...' : '✨ Generate Message'}</button>
                    {outreachMsg && (
                      <div style={{ marginTop: '12px' }}>
                        <div style={{ background: c.surface2, borderRadius: '8px', padding: '14px', fontSize: '13px', color: c.text1, lineHeight: '1.8', border: `1px solid ${c.border}`, whiteSpace: 'pre-wrap', marginBottom: '8px' }}>{outreachMsg}</div>
                        <button onClick={() => copyToClipboard(outreachMsg)} style={S.btn(copied ? 'green' : 'ghost')}>{copied ? '✓ Copied!' : '⎘ Copy'}</button>
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ flex: 0.8, display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {selected.skills?.length > 0 && (
                    <div style={S.card}>
                      <h4 style={S.cardTitle}>Skills</h4>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {selected.skills.map((s, i) => <span key={i} style={{ background: c.accentGlow, color: c.accent, padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: '600' }}>{s}</span>)}
                      </div>
                    </div>
                  )}
                  {selected.achievements?.length > 0 && (
                    <div style={S.card}>
                      <h4 style={S.cardTitle}>Achievements</h4>
                      {selected.achievements.map((a, i) => <div key={i} style={{ padding: '9px 12px', background: c.green + '12', borderRadius: '8px', marginBottom: '7px', borderLeft: `3px solid ${c.green}`, color: c.green, fontSize: '12px', lineHeight: '1.6' }}>{a}</div>)}
                    </div>
                  )}
                  {selected.education?.length > 0 && (
                    <div style={S.card}>
                      <h4 style={S.cardTitle}>Education</h4>
                      {selected.education.map((e, i) => (
                        <div key={i} style={{ padding: '10px 13px', background: c.surface2, borderRadius: '8px', marginBottom: '8px', border: `1px solid ${c.border}` }}>
                          <div style={{ fontWeight: '600', color: c.text1, fontSize: '13px' }}>{e.degree}</div>
                          <div style={{ color: c.text2, fontSize: '11px', marginTop: '3px' }}>{e.institution} · {e.year}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── ANALYTICS ── */}
          {page === 'analytics' && (
            <div>
              {!analytics ? (
                <div style={{ textAlign: 'center', padding: '60px', color: c.text3 }}>Loading analytics...</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {[
                    { title: 'Top Companies', data: analytics.top_companies, color: c.accent },
                    { title: 'Top Locations', data: analytics.top_locations, color: c.green },
                    { title: 'Top Skills',    data: analytics.top_skills,    color: c.amber },
                  ].map(({ title, data, color }) => {
                    const max = data[0]?.count || 1;
                    return (
                      <div key={title} style={S.card}>
                        <h4 style={S.cardTitle}>{title}</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          {data.map((item, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <div style={{ width: '140px', fontSize: '12px', color: c.text1, fontWeight: '500', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                              <div style={{ flex: 1, height: '8px', background: c.surface3, borderRadius: '4px', overflow: 'hidden' }}>
                                <div style={{ width: `${(item.count/max)*100}%`, height: '100%', background: color, borderRadius: '4px', transition: 'width 0.4s' }} />
                              </div>
                              <div style={{ fontSize: '12px', color: c.text2, width: '30px', textAlign: 'right', flexShrink: 0 }}>{item.count}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── ALUMNI MAP ── */}
          {page === 'map' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <button onClick={getUserLocation} style={{ ...S.btn('primary'), padding: '9px 18px', fontSize: '13px' }}>📍 Show My Location</button>
                <button onClick={() => { setMapAlumni([]); setUserLocation(null); setNearestList([]); setSelectedCity(null); loadMapData(); }} style={S.btn('ghost')}>↻ Reload</button>
                <span style={{ fontSize: '12px', color: c.text3 }}>
                  {mapAlumni.length} alumni · <strong style={{ color: c.accent }}>{new Set(mapAlumni.map(a => a.location?.split(',')[0]?.trim())).size} cities</strong> · click a pin to see who's there
                </span>
                {mapError && <span style={{ fontSize: '12px', color: c.red }}>{mapError}</span>}
              </div>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  {mapLoading ? (
                    <div style={{ height: '520px', background: c.surface, borderRadius: '12px', border: `1px solid ${c.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ fontSize: '28px' }}>🗺</div>
                      <div style={{ color: c.text3, fontSize: '13px' }}>Geocoding locations…</div>
                    </div>
                  ) : (
                    <div id="alumni-map" style={{ height: '520px', borderRadius: '12px', border: `1px solid ${c.border}`, overflow: 'hidden', zIndex: 0 }} />
                  )}
                </div>
                <div style={{ width: '260px', flexShrink: 0 }}>
                  {!selectedCity ? (
                    <div style={{ ...S.card, textAlign: 'center', padding: '32px 16px' }}>
                      <div style={{ fontSize: '32px', marginBottom: '12px' }}>📍</div>
                      <div style={{ fontSize: '13px', fontWeight: '600', color: c.text1, marginBottom: '6px' }}>Click any city pin</div>
                      <div style={{ fontSize: '12px', color: c.text3, lineHeight: '1.6' }}>Pins show number of alumni. Click to see who's there.</div>
                    </div>
                  ) : (
                    <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
                      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${c.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '14px', fontWeight: '700', color: c.text1 }}>📍 {selectedCity.name}</div>
                          <div style={{ fontSize: '11px', color: c.accent, fontWeight: '600', marginTop: '2px' }}>{selectedCity.alumni.length} alumni here</div>
                        </div>
                        <button onClick={() => setSelectedCity(null)} style={{ background: 'none', border: 'none', color: c.text3, cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}>✕</button>
                      </div>
                      <div style={{ maxHeight: '460px', overflowY: 'auto' }}>
                        {selectedCity.alumni.map((a, i) => {
                          const profile = profiles.find(p => p.linkedin_url === a.linkedin_url);
                          return (
                            <div key={a.linkedin_url || i} onClick={() => profile && viewProfile(profile)}
                              style={{ padding: '12px 16px', borderBottom: `1px solid ${c.border}`, cursor: profile ? 'pointer' : 'default', transition: 'background 0.15s' }}
                              onMouseEnter={e => { if (profile) e.currentTarget.style.background = c.accentGlow; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              <div style={{ fontWeight: '700', fontSize: '13px', color: c.text1, marginBottom: '2px' }}>{a.name}</div>
                              <div style={{ fontSize: '11px', color: c.text2, marginBottom: '2px' }}>{a.current_position || '—'}</div>
                              <div style={{ fontSize: '11px' }}><span style={{ background: c.accentGlow, color: c.accent, padding: '1px 7px', borderRadius: '8px', fontWeight: '600' }}>{a.current_company || '—'}</span></div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── FIND MY PATH ── */}
          {page === 'path' && (
            <div style={{ maxWidth: '700px' }}>
              <div style={S.card}>
                <h4 style={S.cardTitle}>Describe Your Goal</h4>
                <p style={{ color: c.text2, fontSize: '13px', marginTop: 0, marginBottom: '12px', lineHeight: '1.7' }}>
                  Tell us what you're looking for — industry, role, company type, or anything specific. We'll find the most relevant alumni for you.
                </p>
                <textarea value={pathGoal} onChange={e => setPathGoal(e.target.value)} placeholder="e.g. I want to get into AI product management at a startup, or I'm looking for alumni in investment banking in Mumbai" rows={3}
                  style={{ ...S.input, width: '100%', boxSizing: 'border-box', resize: 'vertical', marginBottom: '12px', lineHeight: '1.6' }} />
                <button onClick={findPath} disabled={pathLoading || !pathGoal.trim()} style={{ ...S.btn('purple'), opacity: pathLoading || !pathGoal.trim() ? 0.6 : 1, padding: '9px 20px', fontSize: '13px' }}>
                  {pathLoading ? '⏳ Finding alumni...' : '◎ Find My Path'}
                </button>
              </div>
              {pathResults.length > 0 && (
                <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ fontSize: '11px', color: c.text3, fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase' }}>{pathResults.length} Relevant Alumni Found</div>
                  {pathResults.map((r, i) => (
                    <div key={i} style={{ ...S.card, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: '700', color: c.text1, fontSize: '14px', marginBottom: '3px' }}>{r.name}</div>
                        <div style={{ fontSize: '12px', color: c.text2, marginBottom: '8px' }}>
                          {r.current_position} · <span style={{ background: c.accentGlow, color: c.accent, padding: '2px 7px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>{r.current_company}</span>
                        </div>
                        <div style={{ fontSize: '12px', color: c.text2, lineHeight: '1.7', fontStyle: 'italic', borderLeft: `3px solid ${c.purple}`, paddingLeft: '10px' }}>{r.relevance}</div>
                      </div>
                      <button onClick={() => { const p = profiles.find(p => p.linkedin_url === r.linkedin_url); if (p) viewProfile(p); }} style={S.btn('ghost')}>View ↗</button>
                    </div>
                  ))}
                </div>
              )}
              {!pathLoading && pathResults.length === 0 && pathGoal && (
                <div style={{ textAlign: 'center', padding: '40px', color: c.text3, fontSize: '13px', marginTop: '20px' }}>No matching alumni found. Try rephrasing your goal.</div>
              )}
            </div>
          )}

          {/* ── BATCHES ── */}
          {page === 'batches' && (
            <div>
              {!selectedBatch ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                    <div>
                      <h3 style={{ margin: 0, color: c.text1, fontSize: '16px', fontWeight: '700' }}>JKLU Batches</h3>
                      <p style={{ margin: '4px 0 0', color: c.text3, fontSize: '12px' }}>Click a batch to see all alumni from that year</p>
                    </div>
                    <button onClick={async () => { await fetch(`${API}/backfill-batches`, { method: 'POST' }); fetchBatches(); }} style={S.btn('ghost')} title="Re-extract batch info">↻ Sync Batches</button>
                  </div>
                  {batches.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '60px', color: c.text3, fontSize: '13px' }}>No batches found. Add profiles first, then click "Sync Batches".</div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '14px' }}>
                      <div onClick={() => openBatch('__all__')}
                        style={{ background: `linear-gradient(135deg, ${c.purple}, #6366F1)`, borderRadius: '14px', padding: '24px 20px', cursor: 'pointer', border: `1px solid ${c.border}`, transition: 'transform 0.15s, box-shadow 0.15s', position: 'relative', overflow: 'hidden' }}
                        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = `0 8px 24px ${c.purple}40`; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                      >
                        <div style={{ position: 'absolute', top: -20, right: -20, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.08)' }} />
                        <div style={{ fontSize: '28px', fontWeight: '800', color: 'white', marginBottom: '6px' }}>{batches.reduce((acc, b) => acc + b.count, 0)}</div>
                        <div style={{ fontSize: '13px', fontWeight: '700', color: 'rgba(255,255,255,0.9)', marginBottom: '3px' }}>All Students</div>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>View everyone</div>
                      </div>

                      {/* ── Fix 1: Use parseBatchLabel for display ── */}
                      {batches.map((b, i) => {
                        const parsed = parseBatchLabel(b.batch);
                        const colors = [c.accent, c.green, c.amber, '#EC4899', '#14B8A6', '#F97316'];
                        const color  = parsed.isUnknown ? c.text3 : colors[i % colors.length];
                        return (
                          <div key={b.batch} onClick={() => openBatch(b.batch)}
                            style={{ background: c.surface, borderRadius: '14px', padding: '24px 20px', cursor: 'pointer', border: `1px solid ${c.border}`, borderTop: `3px solid ${color}`, transition: 'transform 0.15s, box-shadow 0.15s', position: 'relative', overflow: 'hidden' }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = `0 8px 24px ${color}30`; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                          >
                            <div style={{ position: 'absolute', top: -20, right: -20, width: 80, height: 80, borderRadius: '50%', background: color + '10' }} />
                            <button onClick={e => { e.stopPropagation(); setConfirmDeleteBatch(b); }} title="Delete batch" style={{ position: 'absolute', top: '10px', right: '10px', background: c.red + '18', border: 'none', color: c.red, width: '24px', height: '24px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>✕</button>
                            <div style={{ fontSize: '28px', fontWeight: '800', color: c.text1, marginBottom: '6px' }}>{b.count}</div>
                            <div style={{ fontSize: '14px', fontWeight: '700', color: parsed.isUnknown ? c.text3 : c.text1, marginBottom: '3px' }}>{parsed.display}</div>
                            <div style={{ fontSize: '11px', color, fontWeight: '600' }}>{parsed.sub}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
                    <button onClick={() => { setSelectedBatch(null); setBatchProfiles([]); setBatchSearch(''); setSelectedRows(new Set()); }}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: c.surface, border: `1px solid ${c.border}`, color: c.text1, cursor: 'pointer', fontSize: '14px', padding: '10px 20px', borderRadius: '10px', fontWeight: '600', transition: 'all 0.15s' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = c.accent; e.currentTarget.style.color = c.accent; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = c.border; e.currentTarget.style.color = c.text1; }}
                    >← All Batches</button>
                    <span style={{ color: c.text1, fontSize: '15px', fontWeight: '700' }}>
                      {selectedBatch === '__all__' ? 'All Students' : parseBatchLabel(selectedBatch).display}
                    </span>
                    <span style={{ background: c.accentGlow, color: c.accent, padding: '2px 10px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>{batchProfiles.length} alumni</span>
                    {filteredCount !== null && filteredCount !== batchProfiles.length && (
                      <span style={{ background: '#F59E0B20', color: c.amber, padding: '2px 10px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>↳ {filteredCount} filtered</span>
                    )}

                    {/* ── Fix 5: Multi-select action bar ── */}
                    {selectedRows.size > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '4px', padding: '5px 12px', background: c.accentGlow, borderRadius: '10px', border: `1px solid ${c.accent}44` }}>
                        <span style={{ fontSize: '12px', fontWeight: '700', color: c.accent }}>{selectedRows.size} selected</span>
                        <button onClick={() => { setMultiMoving(true); setMultiMoveTarget(''); setMultiMoveStatus(''); }} style={{ ...S.btn('teal'), padding: '4px 10px', fontSize: '11px' }}>⇄ Move All</button>
                        <button onClick={() => setSelectedRows(new Set())} style={{ background: 'none', border: 'none', color: c.text3, cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>✕</button>
                      </div>
                    )}

                    <button onClick={() => {
                      const rows = [['Name','Position','Company','Location','Since','LinkedIn URL']];
                      batchProfiles.forEach(p => rows.push([p.name||'',p.current_position||'',p.current_company||'',p.location||'',p.timeline||'',p.linkedin_url||'']));
                      const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
                      const a = document.createElement('a'); a.href = 'data:text/csv,' + encodeURIComponent(csv); a.download = `batch_${selectedBatch}.csv`; a.click();
                    }} style={{ ...S.btn('ghost'), marginLeft: 'auto' }}>⬇ Export CSV</button>
                  </div>

                  {/* Stats bar */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '16px' }}>
                    {[
                      { label: 'Total Alumni', value: batchProfiles.length, color: c.accent },
                      { label: 'Companies',    value: new Set(batchProfiles.map(p => p.current_company).filter(Boolean)).size, color: c.green },
                      { label: 'Locations',    value: new Set(batchProfiles.map(p => p.location?.split(',')[0]?.trim()).filter(Boolean)).size, color: c.amber },
                    ].map((s, i) => (
                      <div key={i} style={{ background: c.surface, borderRadius: '10px', padding: '14px 16px', border: `1px solid ${c.border}`, borderTop: `3px solid ${s.color}` }}>
                        <div style={{ fontSize: '22px', fontWeight: '800', color: c.text1 }}>{s.value}</div>
                        <div style={{ fontSize: '11px', color: c.text2, marginTop: '3px', fontWeight: '500' }}>{s.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Search row */}
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', alignItems: 'center' }}>
                    <input value={batchSearch} onChange={e => { setBatchSearch(e.target.value); if (batchAiResults) setBatchAiResults(null); }} onKeyDown={e => e.key === 'Enter' && batchSearch.trim() && handleBatchAISearch(batchSearch)} placeholder="Search by name, company, skills, location..." style={{ ...S.input, flex: 1 }} />
                    <button onClick={() => batchSearch.trim() && handleBatchAISearch(batchSearch)} disabled={batchAiLoading || !batchSearch.trim()} style={{ ...S.btn('purple'), opacity: (batchAiLoading||!batchSearch.trim()) ? 0.6 : 1, whiteSpace: 'nowrap' }} title="Semantic AI search">{batchAiLoading ? '⏳' : '✦ AI'}</button>

                    <div style={{ position: 'relative' }}>
                      <button onClick={() => setShowFilters(v => !v)} style={{ ...S.btn('ghost'), whiteSpace: 'nowrap', borderColor: (filterCompany||filterLocation||filterSkill||strictField!=='all') ? c.accent : c.border, color: (filterCompany||filterLocation||filterSkill||strictField!=='all') ? c.accent : c.text2 }}>
                        ⊞ Filter{(filterCompany||filterLocation||filterSkill||strictField!=='all') ? ' ●' : ''}
                      </button>
                      {showFilters && (
                        <div style={{ position: 'absolute', right: 0, top: '38px', background: c.surface, border: `1px solid ${c.border}`, borderRadius: '12px', padding: '16px', zIndex: 50, minWidth: '280px', boxShadow: '0 8px 24px #00000030', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <div style={{ fontSize: '10px', color: c.text3, fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase' }}>Search in field</div>
                          <select value={strictField} onChange={e => { setStrictField(e.target.value); setBatchSearch(''); setBatchAiResults(null); }} style={{ ...S.select, width: '100%' }}>
                            <option value="all">All Fields</option>
                            <option value="position">Current Position only</option>
                            <option value="past_roles">Past Experience only</option>
                            <option value="any_experience">Current + Past Experience</option>
                            <option value="company">Company only</option>
                            <option value="location">Location only</option>
                            <option value="skills">Skills only</option>
                          </select>
                          <div style={{ fontSize: '10px', color: c.text3, fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase' }}>Filter by</div>
                          {(() => {
                            const batchCompanies = [...new Set(batchProfiles.map(p => p.current_company).filter(Boolean))].sort();
                            const batchLocations = [...new Set(batchProfiles.map(p => p.location?.split(',')[0]?.trim()).filter(Boolean))].sort();
                            const batchSkills    = [...new Set(batchProfiles.flatMap(p => p.skills||[]).filter(Boolean))].sort();
                            return (
                              <>
                                <select value={filterCompany} onChange={e => setFilterCompany(e.target.value)} style={{ ...S.select, width: '100%' }}>
                                  <option value="">All Companies</option>
                                  {batchCompanies.map(co => <option key={co} value={co}>{co}</option>)}
                                </select>
                                <select value={filterLocation} onChange={e => setFilterLocation(e.target.value)} style={{ ...S.select, width: '100%' }}>
                                  <option value="">All Locations</option>
                                  {batchLocations.map(l => <option key={l} value={l}>{l}</option>)}
                                </select>
                                <select value={filterSkill} onChange={e => setFilterSkill(e.target.value)} style={{ ...S.select, width: '100%' }}>
                                  <option value="">All Skills</option>
                                  {batchSkills.map(sk => <option key={sk} value={sk}>{sk}</option>)}
                                </select>
                              </>
                            );
                          })()}
                          {(filterCompany||filterLocation||filterSkill||strictField!=='all') && (
                            <button onClick={() => { clearFilters(); setStrictField('all'); setShowFilters(false); }} style={{ ...S.btn('ghost'), width: '100%', textAlign: 'center' }}>✕ Clear all filters</button>
                          )}
                        </div>
                      )}
                    </div>
                    {(batchSearch||batchAiResults) && <button onClick={() => { setBatchSearch(''); setBatchAiResults(null); }} style={S.btn('ghost')}>✕</button>}
                  </div>

                  {/* Table */}
                  {batchLoading ? (
                    <div style={{ textAlign: 'center', padding: '60px', color: c.text3 }}>Loading alumni...</div>
                  ) : (
                    <div>
                      <div style={{ background: c.surface, borderRadius: '12px', overflow: 'hidden', border: `1px solid ${c.border}` }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              {/* ── Fix 5: Select-all checkbox in header ── */}
                              <th style={{ ...S.th, width: '36px', paddingRight: '4px' }}>
                                {(() => {
                                  const list = getFilteredList();
                                  return (
                                    <input
                                      type="checkbox"
                                      checked={list.length > 0 && selectedRows.size === list.length}
                                      onChange={() => toggleAllRows(list)}
                                      style={S.checkbox}
                                      title="Select all"
                                    />
                                  );
                                })()}
                              </th>
                              {['Name','Position','Company','Location','Since','Updated',''].map(h => (
                                <th key={h} style={S.th}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>{renderBatchRows()}</tbody>
                        </table>
                      </div>

                      {selectedBatch === '__all__' && currentPage < totalPages && (
                        <div style={{ textAlign: 'center', padding: '20px' }}>
                          <button onClick={async () => {
                            setLoadingMore(true);
                            const next = currentPage + 1;
                            const r = await fetch(`${API}/profiles?page=${next}&page_size=100`); const data = await r.json();
                            setBatchProfiles(prev => [...prev, ...(data.profiles||[])]);
                            setCurrentPage(next); setLoadingMore(false);
                          }} disabled={loadingMore} style={{ ...S.btn('ghost'), padding: '10px 28px', fontSize: '13px' }}>
                            {loadingMore ? '⏳ Loading...' : `Load More (${batchProfiles.length} of ${totalProfiles} shown)`}
                          </button>
                        </div>
                      )}
                      {selectedBatch === '__all__' && currentPage >= totalPages && batchProfiles.length > 0 && (
                        <div style={{ textAlign: 'center', padding: '12px', color: c.text3, fontSize: '12px' }}>All {totalProfiles} alumni loaded</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── ADD ── */}
          {page === 'add' && (
            <div style={{ maxWidth: '480px' }}>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '18px' }}>
                {['single','bulk'].map(t => (
                  <button key={t} onClick={() => setAddTab(t)} style={{ padding: '7px 16px', borderRadius: '8px', border: `1px solid ${c.border}`, cursor: 'pointer', fontSize: '12px', fontWeight: '600', background: addTab===t ? c.accent : c.surface, color: addTab===t ? 'white' : c.text2 }}>
                    {t === 'single' ? 'Single URL' : 'Bulk CSV'}
                  </button>
                ))}
              </div>
              <div style={S.card}>
                {addTab === 'single' ? (
                  <>
                    <h4 style={S.cardTitle}>LinkedIn URL</h4>
                    {/* ── Fix 3: Accepts any valid linkedin.com/in/ form ── */}
                    <input
                      value={linkedinUrl}
                      onChange={e => { setLinkedinUrl(e.target.value); if (addStatus) setAddStatus(''); }}
                      onKeyDown={e => e.key === 'Enter' && addProfile()}
                      placeholder="linkedin.com/in/username or https://www.linkedin.com/in/username"
                      style={{ ...S.input, width: '100%', marginBottom: '13px', boxSizing: 'border-box' }}
                    />
                    <button onClick={addProfile} disabled={loading || !linkedinUrl} style={{ ...S.btn('primary'), opacity: loading||!linkedinUrl ? 0.6 : 1, padding: '9px 20px', fontSize: '13px' }}>
                      {loading ? '⏳ Adding...' : '+ Add Profile'}
                    </button>
                    {addStatus && (
                      <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: '500', lineHeight: '1.5',
                        background: addStatus.startsWith('❌') ? c.red+'18' : addStatus.startsWith('⏳') ? c.amber+'18' : c.green+'18',
                        color:      addStatus.startsWith('❌') ? c.red      : addStatus.startsWith('⏳') ? c.amber      : c.green,
                        border:     `1px solid ${addStatus.startsWith('❌') ? c.red+'44' : addStatus.startsWith('⏳') ? c.amber+'44' : c.green+'44'}`,
                      }}>{addStatus}</div>
                    )}
                  </>
                ) : (
                  <>
                    <h4 style={S.cardTitle}>Upload CSV</h4>
                    <p style={{ color: c.text2, fontSize: '12px', marginBottom: '12px', marginTop: 0, lineHeight: '1.6' }}>
                      CSV must have a column named <code style={{ background: c.surface3, padding: '1px 5px', borderRadius: '4px', color: c.accent }}>linkedin_url</code>
                    </p>
                    <input type="file" accept=".csv" onChange={handleCSV} style={{ fontSize: '13px', color: c.text1, marginBottom: '10px' }} />
                    {csvStatus && <p style={{ color: c.green, fontSize: '12px', marginTop: '8px', marginBottom: 0 }}>{csvStatus}</p>}
                  </>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}