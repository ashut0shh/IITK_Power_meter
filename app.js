// ============================================================
//  ESP32 Power Monitor — Dashboard Script
//  Polls /api/telemetry every second, updates DOM.
// ============================================================

(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────
  const API_URL      = '/api/telemetry';
  const POLL_MS      = 1000;   // polling interval (ms)
  const FAIL_THRESH  = 4;      // failures before showing overlay
  const MAX_VOLTAGE  = 260;    // V — bar 100%
  const MAX_CURRENT  = 16;     // A — bar 100%
  const MAX_POWER    = 3680;   // W — bar 100%

  // ── State ──────────────────────────────────────────────
  let failCount  = 0;
  let connected  = true;
  let pollCount  = 0;

  // ── DOM refs ───────────────────────────────────────────
  const q  = id => document.getElementById(id);
  const qs = sel => document.querySelector(sel);

  const el = {
    voltage    : q('val-voltage'),
    current    : q('val-current'),
    power      : q('val-power'),
    energy     : q('val-energy'),
    apparent   : q('val-apparent'),
    freq       : q('val-freq'),
    pf         : q('val-pf'),
    uptime     : q('val-uptime'),
    headerTime : q('headerTime'),
    liveBadge  : q('liveBadge'),
    overlay    : q('overlay'),
    footerInfo : q('footer-info'),
    loadPct    : q('load-pct'),
    voltStatus : q('voltage-status'),
    energyKwh  : q('energy-kwh'),
    sysStatus  : q('sys-status'),

    barVoltage : qs('#bar-voltage'),
    barCurrent : qs('#bar-current'),
    barPower   : qs('#bar-power'),
  };

  // ── Utilities ──────────────────────────────────────────
  function fmt(v, d) {
    return Number(v).toFixed(d);
  }

  function fmtUptime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
  }

  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth;   // trigger reflow
    el.classList.add('flash');
  }

  function pct(val, max) {
    return Math.min(100, Math.max(0, (val / max) * 100)).toFixed(1) + '%';
  }

  // ── Update UI ──────────────────────────────────────────
  function updateUI(d) {
    // ── Voltage ──────────────────────────────────────────
    el.voltage.textContent = fmt(d.voltage, 1);
    el.barVoltage.style.width = pct(d.voltage, MAX_VOLTAGE);
    flash(el.voltage);

    if (d.voltage < 210 || d.voltage > 250) {
      el.voltage.classList.add('c-err');
      el.voltage.classList.remove('c-warn');
      el.voltStatus.textContent = 'VOLTAGE FAULT';
      el.voltStatus.className = 'meta-status c-err';
    } else if (d.voltage < 220 || d.voltage > 240) {
      el.voltage.classList.remove('c-err');
      el.voltage.classList.add('c-warn');
      el.voltStatus.textContent = 'OUT OF RANGE';
      el.voltStatus.className = 'meta-status c-warn';
    } else {
      el.voltage.classList.remove('c-err', 'c-warn');
      el.voltStatus.textContent = 'AC\u00a0RMS';
      el.voltStatus.className = 'meta-status';
    }

    // ── Current ──────────────────────────────────────────
    el.current.textContent = fmt(d.current, 2);
    el.barCurrent.style.width = pct(d.current, MAX_CURRENT);
    flash(el.current);

    // ── Power ─────────────────────────────────────────────
    el.power.textContent = fmt(d.power, 1);
    el.barPower.style.width = pct(d.power, MAX_POWER);
    flash(el.power);

    const loadP = ((d.power / MAX_POWER) * 100).toFixed(0);
    el.loadPct.textContent = loadP + '%\u00a0load';
    el.loadPct.className = loadP > 85
      ? 'meta-status c-err' : loadP > 60
      ? 'meta-status c-warn' : 'meta-status';

    // ── Energy ────────────────────────────────────────────
    el.energy.textContent  = fmt(d.energy, 3);
    el.energyKwh.textContent = fmt(d.energy / 1000, 5) + '\u00a0kWh';
    flash(el.energy);

    // ── Apparent power ────────────────────────────────────
    if (d.apparentPower !== undefined) {
      el.apparent.textContent = fmt(d.apparentPower, 1);
    }

    // ── Frequency ─────────────────────────────────────────
    if (d.frequency !== undefined) {
      el.freq.textContent = fmt(d.frequency, 2);
    }

    // ── Power Factor ──────────────────────────────────────
    if (d.powerFactor !== undefined) {
      el.pf.textContent = fmt(d.powerFactor, 2);
    }

    // ── Uptime ────────────────────────────────────────────
    if (d.uptime !== undefined) {
      el.uptime.textContent = fmtUptime(d.uptime);
    }

    // ── System status text ────────────────────────────────
    const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
    if (d.voltage < 210 || d.voltage > 250) {
      el.sysStatus.textContent = 'VOLTAGE FAULT';
      el.sysStatus.className = 'card-note c-err';
    } else if (d.power > 3000) {
      el.sysStatus.textContent = 'HIGH LOAD';
      el.sysStatus.className = 'card-note c-warn';
    } else {
      el.sysStatus.textContent = 'System nominal';
      el.sysStatus.className = 'card-note c-ok';
    }

    // Footer poll info
    el.footerInfo.textContent =
      `last update ${now} · poll #${pollCount}`;
  }

  // ── Connection state ───────────────────────────────────
  function setConnected(ok) {
    connected = ok;
    if (ok) {
      el.liveBadge.classList.remove('offline');
      el.liveBadge.innerHTML =
        '<span class="live-dot"></span><span class="live-label">LIVE</span>';
      el.overlay.classList.remove('show');
    } else {
      el.liveBadge.classList.add('offline');
      el.liveBadge.innerHTML =
        '<span class="live-dot"></span><span class="live-label">OFFLINE</span>';
      el.overlay.classList.add('show');
    }
  }

  // ── Poll ──────────────────────────────────────────────
  async function poll() {
    pollCount++;
    try {
      const res = await fetch(API_URL, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      failCount = 0;
      if (!connected) setConnected(true);
      updateUI(data);
    } catch (err) {
      failCount++;
      console.warn(`[PowerMonitor] Poll #${pollCount} failed:`, err.message);
      if (failCount >= FAIL_THRESH) setConnected(false);
    }
  }

  // ── Clock ─────────────────────────────────────────────
  function tickClock() {
    el.headerTime.textContent =
      new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  // ── Boot ──────────────────────────────────────────────
  function init() {
    tickClock();
    setInterval(tickClock, 1000);
    poll();                              // immediate first fetch
    setInterval(poll, POLL_MS);
    console.log('[PowerMonitor] Started — polling', API_URL, 'every', POLL_MS, 'ms');
  }

  // Start after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
