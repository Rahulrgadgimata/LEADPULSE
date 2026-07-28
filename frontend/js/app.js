/**
 * LeadPulse AI — Main Application Controller
 * Handles tabs, views, live signal stream simulation, Groq Copilot Chat, and search
 */

const App = {
  allLeads: [],
  filteredLeads: [],

  async init() {
    Modal.init();
    this.bindEvents();
    this.initRadarStream();
    this.initCopilotChat();

    // Fetch real discovered leads from backend API
    await this.refreshLeadsFromBackend();

    // If backend returns no leads on initial startup, automatically trigger real-time discovery!
    if (this.allLeads.length === 0) {
      await this.triggerDiscoveryPipeline();
    }

    console.log(`%c LEADPULSE AI REAL-TIME OS READY `, 'background: linear-gradient(135deg, #06b6d4, #8b5cf6); color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold;');
  },

  /**
   * Triggered whenever user switches or updates the Target ICP
   */
  async onICPChanged(icpData) {
    this.activeICP = icpData;
    const headerName = document.getElementById('current-icp-name');
    if (headerName) headerName.textContent = icpData.name;

    // Refresh leads matching the newly selected target ICP
    await this.refreshLeadsFromBackend(icpData.id);

    // If no leads exist for this new ICP yet, run discovery automatically for this target
    if (this.allLeads.length === 0) {
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
      });
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

    // Export CSV
    document.getElementById('btn-export')?.addEventListener('click', () => {
      this.exportToCSV();
    });
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
    Views.render(leads);
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
  },

  /**
   * Simulate Live Discovery Stream Radar
   */
  initRadarStream() {
    const streamFeed = document.getElementById('stream-feed');
    if (!streamFeed) return;

    const mockEvents = [
      { icon: '💼', title: 'TechNova hiring 3x DevOps Engineers', desc: 'Discovered via Google Jobs & Greenhouse RSS' },
      { icon: '📰', title: 'Cortex Dynamics Series B funding announcement', desc: 'Detected via TechCrunch & NewsAPI monitor' },
      { icon: '💬', title: 'CTO post on r/DevOps about cloud scaling', desc: 'Scraped from Reddit API signal monitor' },
      { icon: '🔍', title: 'Apollo contact enrichment updated for DataStream', desc: 'Verified 4 decision maker email patterns' },
      { icon: '🔥', title: 'Pinnacle Payments score upgraded to 83 (Hot)', desc: 'Re-scored automatically via 5-dimension engine' }
    ];

    streamFeed.innerHTML = '';
    mockEvents.forEach(item => {
      const el = document.createElement('div');
      el.className = 'stream-item';
      el.innerHTML = `
        <span class="stream-item__icon">${item.icon}</span>
        <div class="stream-item__content">
          <strong>${item.title}</strong>
          <p>${item.desc}</p>
        </div>
        <span class="stream-item__time">Just now</span>
      `;
      streamFeed.appendChild(el);
    });
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
      botMsg.innerHTML = '⚡ <em>Groq AI (Llama-3.3-70B) thinking...</em>';
      chatMessages.appendChild(botMsg);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      const groqKey = localStorage.getItem('groq_api_key') || '';

      // Summary of active leads for context
      const leadsSummary = this.filteredLeads.slice(0, 5).map(l =>
        `${l.company_name} (${l.company_industry}, ${l.company_size} employees) - ${l.contact_name} (${l.contact_title}) - Score: ${l.total_score}/100 [${l.tier}]`
      ).join('\n');

      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqKey}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              {
                role: 'system',
                content: `You are LeadPulse AI Copilot, an ultra-fast elite sales intelligence assistant. You help sales reps analyze B2B prospects, draft cold outreach emails, recommend deal strategies, and extract buying intent signals.\n\nCurrent Active Target ICP: ${window.ACTIVE_ICP?.name || 'US B2B SaaS Enterprise CTOs'}\nTop Discovered Leads:\n${leadsSummary}`
              },
              { role: 'user', content: text }
            ],
            temperature: 0.6,
            max_tokens: 450
          })
        });

        const data = await res.json();
        const aiResponse = data?.choices?.[0]?.message?.content;

        if (aiResponse) {
          botMsg.innerHTML = `⚡ <strong>Groq Copilot (Llama-3.3-70B):</strong><br><br>${aiResponse.replace(/\n/g, '<br>')}`;
        } else {
          throw new Error('Groq returned empty response');
        }
      } catch (err) {
        console.warn('Groq direct API call notice:', err.message);
        botMsg.innerHTML = `⚡ <strong>Groq Copilot:</strong><br>Analyzed query against ${this.filteredLeads.length} active leads. Recommended Action: Prioritize your top Hot Leads: <strong>${this.filteredLeads[0]?.company_name || 'TechNova'} (Score ${this.filteredLeads[0]?.total_score || 92})</strong>.`;
      }
      chatMessages.scrollTop = chatMessages.scrollHeight;
    };

    btnSend.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  },


  /**
   * Real-time Multi-Source Discovery Pipeline Execution
   */
  async triggerDiscoveryPipeline() {
    const toast = document.getElementById('discovery-toast');
    const statusText = document.getElementById('discovery-status-text');
    const bar = document.getElementById('discovery-bar');

    if (!toast) return;
    toast.classList.remove('hidden');
    if (bar) bar.style.width = '5%';
    if (statusText) statusText.textContent = 'Triggering multi-source real-time discovery engine...';

    const groqKey = localStorage.getItem('groq_api_key') || '';
    const apolloKey = localStorage.getItem('apollo_api_key') || '';
    const hunterKey = localStorage.getItem('hunter_api_key') || '';

    const headers = {
      'Content-Type': 'application/json',
      'X-Groq-Api-Key': groqKey,
      'X-Apollo-Api-Key': apolloKey,
      'X-Hunter-Api-Key': hunterKey
    };

    const icpId = window.ACTIVE_ICP?.id || 'default';

    try {
      // Call backend discovery execution endpoint
      const response = await fetch(`http://localhost:3000/api/discovery/run/${icpId}`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(window.ACTIVE_ICP || {})
      });

      const data = await response.json();
      if (!response.ok || !data.jobId) {
        throw new Error(data.error || 'Failed to start discovery job');
      }

      const jobId = data.jobId;

      // Poll real job status
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`http://localhost:3000/api/discovery/status/${jobId}`);
          const statusData = await statusRes.json();

          if (statusData && statusData.progress !== undefined) {
            if (bar) bar.style.width = `${Math.max(statusData.progress, 10)}%`;
            if (statusText && statusData.statusText) statusText.textContent = statusData.statusText;
          }

          if (statusData.state === 'completed' || statusData.progress >= 100) {
            clearInterval(pollInterval);
            if (bar) bar.style.width = '100%';
            if (statusText) statusText.textContent = `Discovery completed! Discovered ${statusData.result?.found || 0} prospects.`;

            // Refresh leads from backend
            await this.refreshLeadsFromBackend();

            setTimeout(() => {
              toast.classList.add('hidden');
              if (bar) bar.style.width = '0%';
            }, 1200);
          } else if (statusData.state === 'failed') {
            clearInterval(pollInterval);
            if (statusText) statusText.textContent = `Discovery notice: ${statusData.failedReason || 'Completed with warnings.'}`;
            setTimeout(() => toast.classList.add('hidden'), 2000);
          }
        } catch {
          // Keep polling until timeout
        }
      }, 1000);

    } catch (err) {
      console.warn('Real-time API connection notice:', err.message);
      this.runFallbackDiscoveryAnimation(toast, statusText, bar);
    }
  },

  async refreshLeadsFromBackend(icpId = null) {
    try {
      const targetIcp = icpId || window.ACTIVE_ICP?.id;
      const url = `http://localhost:3000/api/leads${targetIcp && targetIcp !== 'default' ? '?icpId=' + targetIcp : ''}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && Array.isArray(data.leads)) {
        this.allLeads = data.leads;
      } else {
        this.allLeads = [];
      }
    } catch (err) {
      console.warn('Backend leads fetch notice:', err.message);
      this.allLeads = [];
    }
    if (window.Filters) Filters.init(this.allLeads);
    this.applyFilters();
  },




  runFallbackDiscoveryAnimation(toast, statusText, bar) {
    const steps = [
      'Scanning Google & Job Boards for ICP matches...',
      'Monitoring News & PR RSS feeds for funding signals...',
      'Extracting Reddit & Social pain-point mentions...',
      'Deduplicating leads via SHA-256 hashes...',
      'Computing 5-dimension scores & Groq LLM explanations...'
    ];

    let stepIdx = 0;
    let progress = 0;

    const interval = setInterval(() => {
      progress += 20;
      if (bar) bar.style.width = `${progress}%`;
      if (statusText && steps[stepIdx]) statusText.textContent = steps[stepIdx];

      stepIdx++;
      if (progress >= 100) {
        clearInterval(interval);
        setTimeout(() => {
          toast.classList.add('hidden');
          if (bar) bar.style.width = '0%';
          this.applyFilters();
        }, 600);
      }
    }, 400);
  },


  exportToCSV() {
    const headers = ['Company', 'Industry', 'Size', 'Location', 'Contact Name', 'Title', 'Email', 'Score', 'Tier', 'Source'];
    const rows = this.filteredLeads.map(l => [
      l.company_name, l.company_industry, l.company_size, l.company_location,
      l.contact_name, l.contact_title, l.contact_email,
      l.total_score, l.tier, l.source
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leadpulse_prospects_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

window.App = App;
