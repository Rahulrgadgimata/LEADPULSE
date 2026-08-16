/**
 * LeadPulse AI — Main Application Controller
 * Handles tabs, views, live signal stream simulation, Groq Copilot Chat, and search
 */

const App = {
  // Same-origin by default; see js/config.js for split-host deployments.
  API_BASE: (window.LEADPULSE_API_BASE || '').replace(/\/$/, ''),
  ACTIVE_ICP_KEY: 'leadpulse_active_icp_id',

  allLeads: [],
  filteredLeads: [],

  async init() {
    Modal.init();
    Review.init();
    this.bindEvents();

    // Resolve the active ICP before anything fetches data. Without this the
    // dashboard loaded with no target and pulled every lead from every ICP,
    // while the header showed the placeholder baked into the HTML.
    await this.restoreActiveICP();

    // Model names shown in the UI come from the server, so they cannot drift
    // out of date the way the hardcoded "Groq Llama-3" labels did.
    await this.applyEngineStatus();

    this.initRadarStream();
    this.initCopilotChat();
    await Outreach.init();

    await this.refreshLeadsFromBackend();

    // If this ICP has no leads yet, discover for it automatically.
    if (this.allLeads.length === 0 && window.ACTIVE_ICP?.id) {
      await this.triggerDiscoveryPipeline();
    }

    console.log(`%c LEADPULSE AI REAL-TIME OS READY `, 'background: linear-gradient(135deg, #06b6d4, #8b5cf6); color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold;');
  },

  /**
   * Work out which ICP is active on page load: the one last chosen, else the
   * first active one on the server. The choice is kept in localStorage because
   * window.ACTIVE_ICP is memory-only and did not survive a refresh.
   */
  async restoreActiveICP() {
    let icps = [];
    try {
      const res = await fetch(`${this.API_BASE}/api/icp`);
      if (res.ok) icps = await res.json();
    } catch (err) {
      console.warn('Could not load ICPs:', err.message);
    }

    if (!Array.isArray(icps) || icps.length === 0) {
      this.setActiveICP(null);
      return;
    }

    const savedId = localStorage.getItem(this.ACTIVE_ICP_KEY);
    const icp = (savedId && icps.find(i => i.id === savedId)) ||
                icps.find(i => i.is_active) ||
                icps[0];

    this.setActiveICP(icp);
  },

  /**
   * Fill in the engine labels from the server's real configuration.
   * These were previously hardcoded to "Groq Llama-3", which silently went
   * stale the moment the models changed.
   */
  async applyEngineStatus() {
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    try {
      const res = await fetch(`${this.API_BASE}/api/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.engineStatus = data;

      const extraction = data.models?.extraction || 'unknown model';
      const chatModel = data.models?.chat || 'unknown model';

      setText('engine-status-label', `${extraction} active`);
      setText('scoring-engine-label', `5-dimension scoring · explanations by ${extraction}`);
      setText('copilot-title', `AI Sales Copilot · ${chatModel}`);

      const enabled = Object.entries(data.providers || {})
        .filter(([, v]) => v.configured).length;
      setText('dedup-footer', `Deduplicated across ${enabled} configured source${enabled === 1 ? '' : 's'}`);
    } catch (err) {
      setText('engine-status-label', 'API unreachable');
      console.warn('Engine status unavailable:', err.message);
    }
  },

  /**
   * Single place that changes the active target: keeps window.ACTIVE_ICP, the
   * header label and the persisted id in step.
   */
  setActiveICP(icp) {
    window.ACTIVE_ICP = icp || null;
    this.activeICP = window.ACTIVE_ICP;

    const headerName = document.getElementById('current-icp-name');
    if (headerName) headerName.textContent = icp?.name || 'No ICP selected';

    if (icp?.id) localStorage.setItem(this.ACTIVE_ICP_KEY, icp.id);
    else localStorage.removeItem(this.ACTIVE_ICP_KEY);
  },

  /**
   * Triggered whenever the user switches or updates the Target ICP.
   */
  async onICPChanged(icpData) {
    this.setActiveICP(icpData);

    // Refresh leads and the signal stream for the newly selected target ICP
    await this.refreshLeadsFromBackend(icpData?.id);
    await this.refreshRadarStream();

    // If no leads exist for this new ICP yet, run discovery automatically for this target
    if (this.allLeads.length === 0 && icpData?.id) {
      await this.triggerDiscoveryPipeline();
    }
  },


  bindEvents() {
    // Navigation Tabs Switching
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

        tab.classList.add('active');
        const panelId = `panel-${tab.dataset.tab}`;
        const panel = document.getElementById(panelId);
        if (panel) panel.classList.add('active');

        // Render analytics if switching to analytics
        if (tab.dataset.tab === 'analytics' && window.Charts) {
          Charts.renderAll(this.filteredLeads);
        }
        // The outreach panes read live server state (drafts, sent log), so
        // they refresh on entry rather than showing whatever was last loaded.
        if (tab.dataset.tab === 'outreach' && window.Outreach) {
          Outreach.refreshStatus();
          Outreach.refreshMessages();
          Outreach.showSub(Outreach.activeSub);
        }
      });
    });

    // Table header "select all" mirrors the bulk bar's select-all.
    document.getElementById('table-select-all')?.addEventListener('change', (e) => {
      if (e.target.checked) Review.selectAllShown();
      else Review.clearSelection();
    });

    // View Mode Switcher (Grid / Table / Split)
    document.querySelectorAll('.view-switch__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Views.setMode(btn.dataset.mode);
        Views.render(this.filteredLeads);
      });
    });

    // Header Search Input
    const searchInput = document.getElementById('search-input');
    let searchTimer;
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.applyFilters(), 200);
    });

    // Command + K Shortcut
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInput?.focus();
      }
    });

    // Discovery Run Trigger
    document.getElementById('btn-run-discovery')?.addEventListener('click', () => {
      this.triggerDiscoveryPipeline();
    });

    // Export CSV is handled by Review, which downloads it from the API so the
    // file covers every accepted lead rather than only the loaded page.
  },

  applyFilters() {
    let leads = [...this.allLeads];

    // Apply sidebar chips
    leads = Filters.applyTo(leads);

    // Apply text search
    const query = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
    if (query) {
      leads = leads.filter(l =>
        (l.company_name || '').toLowerCase().includes(query) ||
        (l.contact_name || '').toLowerCase().includes(query) ||
        (l.contact_title || '').toLowerCase().includes(query) ||
        (l.company_industry || '').toLowerCase().includes(query) ||
        (l.company_location || '').toLowerCase().includes(query)
      );
    }

    this.filteredLeads = leads;
    this.updateMetrics(leads);
    this.updateChannelMix(leads);
    Views.render(leads);

    if (window.Outreach) Outreach.updateTabCount();
  },

  updateChannelMix(leads) {
    const el = document.getElementById('channel-mix');
    if (!el) return;
    const labels = {
      web_scrape: 'Web',
      news: 'News',
      job_board: 'Jobs',
      linkedin: 'LinkedIn',
      social: 'Social',
    };
    const counts = {};
    for (const lead of leads) {
      const key = lead.source || 'other';
      counts[key] = (counts[key] || 0) + 1;
    }
    const parts = Object.keys(labels).map(key => {
      const n = counts[key] || 0;
      return `<span class="channel-mix__item"><strong>${n}</strong>${labels[key]}</span>`;
    });
    el.innerHTML = parts.join('');
  },

  updateMetrics(leads) {
    const total = leads.length;
    const hot = leads.filter(l => l.tier === 'hot').length;
    const warm = leads.filter(l => l.tier === 'warm').length;
    const avgScore = total > 0 ? Math.round(leads.reduce((s, l) => s + l.total_score, 0) / total) : 0;
    const hotPct = total > 0 ? Math.round((hot / total) * 100) : 0;

    const elTotal = document.getElementById('stat-total-count');
    const elHot = document.getElementById('stat-hot-count');
    const elWarm = document.getElementById('stat-warm-count');
    const elAvg = document.getElementById('stat-avg-score');
    const elHotPct = document.getElementById('stat-hot-pct');

    if (elTotal) elTotal.textContent = total;
    if (elHot) elHot.textContent = hot;
    if (elWarm) elWarm.textContent = warm;
    if (elAvg) elAvg.textContent = avgScore;
    if (elHotPct) elHotPct.textContent = `${hotPct}% of pipeline`;

    // Real source breakdown. This slot used to read "+24% this week", a figure
    // nothing computed.
    const elTrend = document.getElementById('leads-trend');
    if (elTrend) {
      const bySource = {};
      for (const lead of leads) {
        const key = (lead.source || 'unknown').replace(/_/g, ' ');
        bySource[key] = (bySource[key] || 0) + 1;
      }
      const parts = Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v} ${k}`);
      elTrend.textContent = parts.length ? parts.join(' · ') : 'no leads yet';
    }
  },

  /**
   * Live Discovery Stream Radar
   */
  SIGNAL_ICONS: {
    news: '📰',
    job_posting: '💼',
    social: '💬',
    web: '🔍',
    linkedin: '🔗'
  },

  /**
   * Live discovery stream, backed by the signals the collectors actually stored.
   *
   * This previously rendered a fixed list of invented events ("TechNova hiring
   * 3x DevOps Engineers"), so the panel looked live while showing nothing real.
   */
  initRadarStream() {
    const streamFeed = document.getElementById('stream-feed');
    if (!streamFeed) return;

    this.refreshRadarStream();

    // The panel is labelled LIVE, so keep it current while the tab is open.
    if (this.radarTimer) clearInterval(this.radarTimer);
    this.radarTimer = setInterval(() => {
      if (!document.hidden) this.refreshRadarStream();
    }, 15000);
  },

  async refreshRadarStream() {
    const streamFeed = document.getElementById('stream-feed');
    if (!streamFeed) return;

    const icpId = window.ACTIVE_ICP?.id;
    const url = `${this.API_BASE}/api/signals/recent?limit=15${icpId ? '&icpId=' + encodeURIComponent(icpId) : ''}`;

    let signals = [];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      const data = await res.json();
      signals = Array.isArray(data.signals) ? data.signals : [];
    } catch (err) {
      streamFeed.innerHTML =
        `<div class="stream-item"><span class="stream-item__icon">⚠️</span>
           <div class="stream-item__content"><strong>Signal stream unavailable</strong>
           <p>Backend not reachable — start it with "npm start" in the backend folder.</p></div></div>`;
      return;
    }

    if (signals.length === 0) {
      streamFeed.innerHTML =
        `<div class="stream-item"><span class="stream-item__icon">📡</span>
           <div class="stream-item__content"><strong>No signals yet</strong>
           <p>Run Discover Leads to start collecting buying signals for this ICP.</p></div></div>`;
      return;
    }

    streamFeed.innerHTML = '';
    for (const signal of signals) {
      const icon = this.SIGNAL_ICONS[signal.signal_type] || '📡';
      const company = signal.company_name || 'Unknown company';
      const title = signal.title || `${signal.signal_type} signal`;
      const scoreNote = signal.total_score != null
        ? ` · scored ${signal.total_score} (${signal.tier})`
        : '';

      const el = document.createElement('div');
      el.className = 'stream-item';
      el.innerHTML = `
        <span class="stream-item__icon">${icon}</span>
        <div class="stream-item__content">
          <strong></strong>
          <p></p>
        </div>
        <span class="stream-item__time">${this.formatRelativeTime(signal.detected_at)}</span>
      `;
      // Signal titles come from scraped pages, so set them as text rather than
      // HTML to avoid injecting scraped markup into the dashboard.
      el.querySelector('strong').textContent = `${company}: ${title}`.slice(0, 140);
      el.querySelector('p').textContent = `via ${signal.source || 'discovery'}${scoreNote}`;

      if (signal.source_url) {
        el.style.cursor = 'pointer';
        el.title = signal.source_url;
        el.addEventListener('click', () => window.open(signal.source_url, '_blank', 'noopener'));
      }

      streamFeed.appendChild(el);
    }
  },

  formatRelativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';

    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  },

  /**
   * Initialize Groq AI Assistant Chat (Powered by Llama-3.3-70B)
   */
  initCopilotChat() {
    const btnSend = document.getElementById('btn-send-chat');
    const chatInput = document.getElementById('chat-input');
    const chatMessages = document.getElementById('chat-messages');

    if (!btnSend || !chatInput || !chatMessages) return;

    const sendMessage = async () => {
      const text = chatInput.value.trim();
      if (!text) return;

      // User Message
      const userMsg = document.createElement('div');
      userMsg.className = 'chat-msg user';
      userMsg.textContent = text;
      chatMessages.appendChild(userMsg);

      chatInput.value = '';
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // Create loading indicator
      const botMsg = document.createElement('div');
      botMsg.className = 'chat-msg assistant';
      botMsg.textContent = '⚡ Thinking…';
      chatMessages.appendChild(botMsg);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // The request goes to our own backend, which holds the Groq key and
      // builds the lead context from the database. Calling Groq straight from
      // the browser required the key in localStorage and is blocked by the
      // app's Content-Security-Policy.
      try {
        const res = await fetch(`${this.API_BASE}/api/copilot/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, icpId: window.ACTIVE_ICP?.id || null })
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.error || `request failed (HTTP ${res.status})`);
        }
        if (!data.reply) throw new Error('the model returned an empty response');

        this.renderCopilotReply(botMsg, data.reply, data.leadsInContext);
      } catch (err) {
        // Report the real failure. This used to fall back to a canned message
        // naming an invented company and score, which read as a genuine answer.
        botMsg.innerHTML = '';
        const label = document.createElement('strong');
        label.textContent = 'Copilot unavailable';
        const detail = document.createElement('p');
        detail.style.margin = '6px 0 0';
        detail.textContent = err.message;
        botMsg.appendChild(label);
        botMsg.appendChild(detail);
      }
      chatMessages.scrollTop = chatMessages.scrollHeight;
    };

    btnSend.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  },

  /**
   * Render a copilot reply as clean assistant text (never raw HTML from the model).
   * Skips empty markdown-table leftovers and tightens spacing for readable chat.
   */
  renderCopilotReply(container, reply, leadsInContext) {
    container.innerHTML = '';

    const label = document.createElement('strong');
    label.textContent = `Sales Copilot${typeof leadsInContext === 'number' ? ` · ${leadsInContext} leads` : ''}`;
    container.appendChild(label);

    const lines = String(reply || '')
      .split(/\r?\n/)
      .map(l => l.trimEnd())
      .filter(l => {
        const t = l.trim();
        if (!t) return true;
        if (/^\|?\s*-{3,}/.test(t)) return false;
        if (/^\|(\s*-+\s*\|)+\s*$/.test(t)) return false;
        if (/^[\s|:-]+$/.test(t)) return false;
        return true;
      });

    let blankRun = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) {
        blankRun += 1;
        if (blankRun > 1) continue;
        continue;
      }
      blankRun = 0;

      const p = document.createElement('p');
      p.style.margin = '8px 0 0';
      p.style.whiteSpace = 'pre-wrap';
      p.style.lineHeight = '1.45';

      if (/^\d+\.\s+/.test(t)) {
        p.style.fontWeight = '600';
        p.style.marginTop = '12px';
      } else if (/^(Industry|Location|Buyer|Email|Website|LinkedIn|About|Next)\b/i.test(t) || t.includes(' · ')) {
        p.style.color = 'var(--text-secondary)';
        p.style.fontSize = '0.92em';
      }

      p.textContent = t;
      container.appendChild(p);
    }
  },


  /**
   * Real-time Multi-Source Discovery Pipeline Execution
   */
  async triggerDiscoveryPipeline() {
    const toast = document.getElementById('discovery-toast');
    const statusText = document.getElementById('discovery-status-text');
    const bar = document.getElementById('discovery-bar');
    const titleText = toast ? toast.querySelector('strong') : null;

    if (!toast) return;
    toast.classList.remove('hidden');
    if (bar) bar.style.width = '5%';
    if (titleText) titleText.textContent = 'Running Multi-Source AI Pipeline... (5%)';
    if (statusText) statusText.textContent = 'Triggering multi-source real-time discovery engine...';

    // Provider keys are server-side only (backend/.env). They were previously
    // read from localStorage and sent as X-*-Api-Key headers, which the backend
    // never read — that only exposed secrets to anything running in the page.
    const headers = { 'Content-Type': 'application/json' };

    const icpId = window.ACTIVE_ICP?.id;
    if (!icpId) {
      this.showDiscoveryConnectionError(toast, statusText, bar, 'no target ICP selected');
      return;
    }

    try {
      // Call backend discovery execution endpoint
      const response = await fetch(`${this.API_BASE}/api/discovery/run/${encodeURIComponent(icpId)}`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(window.ACTIVE_ICP || {})
      });

      const data = await response.json();

      // 409 means a run is already in flight for this ICP; attach to it rather
      // than reporting an error or starting a second Chromium-backed run.
      if (response.status === 409 && data.jobId) {
        if (statusText) statusText.textContent = 'Discovery already running — following the existing run...';
      } else if (!response.ok || !data.jobId) {
        throw new Error(data.error || `Failed to start discovery job (HTTP ${response.status})`);
      }

      const jobId = data.jobId;

      // Poll real job status
      let missingPolls = 0;
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`${this.API_BASE}/api/discovery/status/${encodeURIComponent(jobId)}`);

          // A job that stops existing means the server restarted mid-run and
          // took the job row with it. Without this the loop polled a 404 once a
          // second forever, leaving the progress bar frozen with no explanation.
          // Tolerate a couple of misses first so a blip does not end a live run.
          if (statusRes.status === 404) {
            if (++missingPolls < 3) return;
            clearInterval(pollInterval);
            if (titleText) titleText.textContent = 'Discovery interrupted';
            if (statusText) {
              statusText.textContent =
                'The server restarted mid-run, so this job was lost. Start it again.';
            }
            await this.refreshLeadsFromBackend();
            setTimeout(() => {
              toast.classList.add('hidden');
              if (bar) bar.style.width = '0%';
              if (titleText) titleText.textContent = 'Running Multi-Source AI Pipeline...';
            }, 5000);
            return;
          }
          missingPolls = 0;

          const statusData = await statusRes.json();

          if (statusData && statusData.progress !== undefined) {
            const pct = Math.max(statusData.progress, 0);
            if (bar) bar.style.width = `${pct}%`;
            if (titleText) titleText.textContent = `Running Multi-Source AI Pipeline... (${pct}%)`;
            if (statusText && statusData.statusText) statusText.textContent = statusData.statusText;
          }

          if (statusData.state === 'completed' || statusData.progress >= 100) {
            clearInterval(pollInterval);
            if (bar) bar.style.width = '100%';
            if (titleText) titleText.textContent = 'Discovery completed!';

            // Refresh leads and the signal stream from the backend
            await this.refreshLeadsFromBackend();
            await this.refreshRadarStream();

            // Report the real outcome: "completed" with zero leads is a
            // meaningful result the user needs to see, not a silent success.
            const found = Array.isArray(this.allLeads) ? this.allLeads.length : 0;
            if (statusText) {
              statusText.textContent = found > 0
                ? `Finished scoring prospects — ${found} lead${found === 1 ? '' : 's'} in your pipeline.`
                : 'Run finished but no prospects matched. Check the backend logs — a source may be rate-limited or missing credentials.';
            }

            setTimeout(() => {
              toast.classList.add('hidden');
              if (bar) bar.style.width = '0%';
              if (titleText) titleText.textContent = 'Running Multi-Source AI Pipeline...';
            }, 1500);
          } else if (statusData.state === 'failed') {
            clearInterval(pollInterval);
            if (titleText) titleText.textContent = 'Discovery failed';
            if (statusText) statusText.textContent = `Error: ${statusData.failedReason || 'Job execution failed.'}`;
            setTimeout(() => {
              toast.classList.add('hidden');
              if (titleText) titleText.textContent = 'Running Multi-Source AI Pipeline...';
            }, 4000);
          }
        } catch {
          // Keep polling until timeout
        }
      }, 1000);

    } catch (err) {
      console.warn('Real-time API connection notice:', err.message);
      this.showDiscoveryConnectionError(toast, statusText, bar, err.message);
    }
  },

  async refreshLeadsFromBackend(icpId = null) {
    const targetIcp = icpId || window.ACTIVE_ICP?.id || null;

    // Always scope to the active ICP. Requesting without a filter returns every
    // lead from every ICP, which is why switching targets appeared to do
    // nothing — the same combined list came back each time.
    if (!targetIcp) {
      this.allLeads = [];
      if (window.Filters) Filters.init(this.allLeads);
      this.applyFilters();
      return;
    }

    try {
      const url = `${this.API_BASE}/api/leads?icpId=${encodeURIComponent(targetIcp)}&limit=1000`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && Array.isArray(data.leads)) {
        this.allLeads = data.leads;
      } else {
        this.allLeads = [];
      }
      // Server-side review counts cover the whole ICP, not just this page, so
      // the sidebar totals stay right even when the list is truncated.
      if (window.Review && data?.counts) Review.renderCounts(data.counts);
    } catch (err) {
      console.warn('Backend leads fetch notice:', err.message);
      this.allLeads = [];
    }
    if (window.Filters) Filters.init(this.allLeads);
    this.applyFilters();

    // Charts are only drawn on tab click, so a refresh while the analytics tab
    // is open would otherwise leave stale numbers on screen.
    if (window.Charts && document.getElementById('panel-analytics')?.classList.contains('active')) {
      Charts.renderAll(this.filteredLeads);
    }
  },




  /**
   * Shown when the discovery API can't be reached at all.
   *
   * This used to animate a fake 0->100% progress bar with invented status
   * lines, which made an unreachable backend look like a successful run that
   * simply found nothing. Report the real problem instead.
   */
  showDiscoveryConnectionError(toast, statusText, bar, message) {
    const titleText = toast ? toast.querySelector('strong') : null;

    if (bar) bar.style.width = '0%';
    if (titleText) titleText.textContent = 'Discovery could not start';
    if (statusText) {
      statusText.textContent =
        `Discovery API not reachable${this.API_BASE ? ` at ${this.API_BASE}` : ''} — check the backend is running. (${message})`;
    }

    setTimeout(() => {
      toast.classList.add('hidden');
      if (titleText) titleText.textContent = 'Running Multi-Source AI Pipeline...';
    }, 8000);
  },


  /**
   * Brief confirmation for actions that succeeded.
   *
   * Review and outreach actions are frequent and mostly uneventful — an alert()
   * for each one would make the dashboard unusable, but silence leaves the user
   * unsure whether an accept registered. Failures still use alert(), because
   * those must not be missed.
   */
  toast(message) {
    let el = document.getElementById('app-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-toast';
      el.className = 'app-toast';
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.classList.add('app-toast--visible');

    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('app-toast--visible'), 3200);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

window.App = App;
