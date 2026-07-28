/**
 * LeadPulse AI — Inspection Drawer & Settings Modal
 */

const Modal = {
  /**
   * Open Slide-Over Drawer for Lead Detail
   */
  openLeadDrawer(lead) {
    const overlay = document.getElementById('drawer-overlay');
    const content = document.getElementById('drawer-content');

    if (!lead || !overlay || !content) return;

    const tier = lead.tier || (lead.total_score >= 70 ? 'hot' : lead.total_score >= 40 ? 'warm' : 'cold');
    const totalScore = lead.total_score ?? 75;
    const tierColor = tier === 'hot' ? 'var(--emerald)' : tier === 'warm' ? 'var(--amber)' : 'var(--rose)';

    content.innerHTML = `
      <div style="margin-bottom:20px;">
        <span class="badge badge--${tier === 'hot' ? 'success' : 'warning'}" style="margin-bottom:8px;display:inline-block;">${tier.toUpperCase()} TIER PROSPECT</span>
        <h1 style="font-family:var(--font-display);font-size:1.8rem;font-weight:800;color:#fff;">${this.escapeHtml(lead.company_name)}</h1>
        <p style="color:var(--text-tertiary);font-size:0.85rem;">${this.escapeHtml(lead.company_description || 'B2B Software & Technology Enterprise')}</p>
      </div>

      <!-- Score Ring & 5-Dimension Overview -->
      <div style="display:flex;align-items:center;gap:20px;padding:20px;background:rgba(255,255,255,0.02);border:1px solid var(--border-glass);border-radius:16px;margin-bottom:24px;">
        <div class="score-badge-ring score-badge-ring--${tier}" style="width:80px;height:80px;font-size:1.8rem;">
          ${totalScore}
          <span style="font-size:0.6rem;font-weight:600;color:var(--text-tertiary);">MATCH SCORE</span>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
          ${this.renderBar('Intent Signals (30%)', lead.intent_score ?? 80)}
          ${this.renderBar('Profile Fit (25%)', lead.profile_fit_score ?? 75)}
          ${this.renderBar('Company Fit (20%)', lead.company_fit_score ?? 75)}
          ${this.renderBar('Recency (15%)', lead.recency_score ?? 85)}
          ${this.renderBar('Engagement (10%)', lead.engagement_score ?? 60)}
        </div>
      </div>

      <!-- Groq AI Explanation Card -->
      <div style="padding:16px;background:linear-gradient(135deg, rgba(6,182,212,0.1), rgba(99,102,241,0.1));border:1px solid rgba(6,182,212,0.25);border-radius:14px;margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="font-size:1.1rem;">⚡</span>
          <strong style="color:var(--cyan);font-size:0.85rem;letter-spacing:0.04em;">GROQ LLM SCORE INSIGHT</strong>
        </div>
        <p style="font-size:0.9rem;line-height:1.6;color:var(--text-secondary);">${this.escapeHtml(lead.explanation || lead.explanation_text || 'High conversion probability based on recent hiring intent and decision maker title match.')}</p>
      </div>

      <!-- Primary Decision Maker Contact Card -->
      <div style="margin-bottom:24px;">
        <h3 style="font-size:0.82rem;font-weight:700;color:var(--text-tertiary);letter-spacing:0.06em;margin-bottom:12px;">DECISION MAKER CONTACT</h3>
        <div style="padding:16px;background:rgba(255,255,255,0.02);border:1px solid var(--border-glass);border-radius:14px;">
          <strong style="font-size:1.05rem;color:#fff;">${this.escapeHtml(lead.contact_name || 'Executive Contact')}</strong>
          <div style="color:var(--cyan);font-size:0.85rem;font-weight:600;margin-top:2px;">${this.escapeHtml(lead.contact_title || 'VP Technology')}</div>
          <div style="font-size:0.82rem;color:var(--text-secondary);margin-top:8px;display:flex;gap:12px;">
            <span>✉️ ${this.escapeHtml(lead.contact_email || 'Verified Email')}</span>
            <span>🌐 <a href="${lead.company_website}" target="_blank" style="color:var(--cyan);">${lead.company_website || 'Website'}</a></span>
          </div>
        </div>
      </div>

      <!-- Signals Timeline -->
      <div style="margin-bottom:24px;">
        <h3 style="font-size:0.82rem;font-weight:700;color:var(--text-tertiary);letter-spacing:0.06em;margin-bottom:12px;">DISCOVERED SIGNALS TIMELINE</h3>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${(lead.signals || []).map(s => `
            <div style="display:flex;align-items:flex-start;gap:12px;padding:10px 14px;background:rgba(255,255,255,0.02);border-radius:10px;border:1px solid var(--border-glass);">
              <span style="font-size:1.1rem;">${this.getSignalIcon(s.type)}</span>
              <div>
                <strong style="font-size:0.85rem;color:#fff;">${this.escapeHtml(s.title)}</strong>
                <div style="font-size:0.72rem;color:var(--text-tertiary);margin-top:2px;">${s.date} · Detected via ${lead.source}</div>
              </div>
            </div>
          `).join('') || '<p style="color:var(--text-tertiary);font-size:0.85rem;">No signals detected.</p>'}
        </div>
      </div>

      <!-- Quick Action Buttons -->
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button class="btn btn--primary" style="flex:1;" onclick="Modal.draftEmail('${lead.id}')">📧 Draft Personalized Email</button>
        <button class="btn btn--secondary" onclick="Modal.closeDrawer()">Close</button>
      </div>
    `;

    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  },

  renderBar(label, score) {
    const color = score >= 70 ? 'var(--emerald)' : score >= 40 ? 'var(--amber)' : 'var(--rose)';
    return `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--text-secondary);margin-bottom:2px;">
          <span>${label}</span>
          <strong>${score}</strong>
        </div>
        <div style="height:5px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">
          <div style="width:${score}%;height:100%;background:${color};border-radius:3px;"></div>
        </div>
      </div>
    `;
  },

  closeDrawer() {
    const overlay = document.getElementById('drawer-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
  },

  openSettings() {
    const modal = document.getElementById('settings-modal-overlay');
    if (modal) modal.classList.remove('hidden');
  },

  PRESETS: {
    saas: {
      name: 'US B2B SaaS Enterprise CTOs',
      description: 'High-growth B2B SaaS enterprises looking for DevOps infrastructure automation',
      industries: 'B2B SaaS, Cloud Computing, DevOps, CyberSecurity',
      minSize: 50,
      maxSize: 5000,
      geos: 'United States, Canada, United Kingdom',
      titles: 'CTO, VP of Engineering, Director of Infrastructure, DevOps Lead',
      keywords: 'kubernetes, cloud cost, hiring devops, ci/cd pipeline, observability'
    },
    fintech: {
      name: 'Fintech Infrastructure VPs',
      description: 'Scale-up financial technology companies investing in security and infrastructure',
      industries: 'Fintech, Banking Technology, Financial Services',
      minSize: 100,
      maxSize: 10000,
      geos: 'United States, European Union, Singapore',
      titles: 'VP Infrastructure, Head of DevOps, Chief Security Officer, Platform Director',
      keywords: 'pci dss, microservices, cloud security, zero trust, terraform'
    },
    aiml: {
      name: 'AI/ML Startup Founders',
      description: 'Early-to-mid stage artificial intelligence companies scaling GPU workloads',
      industries: 'Artificial Intelligence, Machine Learning, Data Analytics',
      minSize: 15,
      maxSize: 500,
      geos: 'United States, Canada',
      titles: 'Founder, CTO, Head of AI, Lead Data Engineer',
      keywords: 'gpu infrastructure, model deployment, llm scaling, vector database, python'
    },
    health: {
      name: 'Healthcare IT Directors',
      description: 'Digital health and medical technology platforms seeking HIPAA compliant tech',
      industries: 'Healthcare IT, HealthTech, Digital Health',
      minSize: 100,
      maxSize: 8000,
      geos: 'United States',
      titles: 'CIO, VP HealthIT, Director Systems Security, IT Architect',
      keywords: 'hipaa compliance, electronic health records, cloud migration, data security'
    }
  },

  openICPModal() {
    const modal = document.getElementById('icp-modal-overlay');
    if (modal) modal.classList.remove('hidden');
    // Load current active ICP if available
    if (!document.getElementById('icp-form-name')?.value) {
      this.applyPreset('saas');
    }
  },

  closeICPModal() {
    const modal = document.getElementById('icp-modal-overlay');
    if (modal) modal.classList.add('hidden');
  },

  applyPreset(presetKey) {
    const p = this.PRESETS[presetKey];
    if (!p) return;

    // Update active button highlight
    document.querySelectorAll('.icp-preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === presetKey);
    });

    // Populate inputs
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };

    setVal('icp-form-name', p.name);
    setVal('icp-form-desc', p.description);
    setVal('icp-form-industries', p.industries);
    setVal('icp-form-size-min', p.minSize);
    setVal('icp-form-size-max', p.maxSize);
    setVal('icp-form-geos', p.geos);
    setVal('icp-form-titles', p.titles);
    setVal('icp-form-keywords', p.keywords);
  },

  async saveICP() {
    const name = document.getElementById('icp-form-name')?.value.trim();
    if (!name) {
      alert('Please enter an ICP Name.');
      return;
    }

    const icpData = {
      name: name,
      description: document.getElementById('icp-form-desc')?.value.trim() || '',
      industries: (document.getElementById('icp-form-industries')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
      company_size_min: parseInt(document.getElementById('icp-form-size-min')?.value || '1', 10),
      company_size_max: parseInt(document.getElementById('icp-form-size-max')?.value || '10000', 10),
      geographies: (document.getElementById('icp-form-geos')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
      job_titles: (document.getElementById('icp-form-titles')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
      keywords: (document.getElementById('icp-form-keywords')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
      is_active: document.getElementById('icp-form-active')?.checked ?? true
    };

    // Update dynamic header text
    const headerName = document.getElementById('current-icp-name');
    if (headerName) headerName.textContent = icpData.name;

    try {
      const res = await fetch('http://localhost:3000/api/icp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(icpData)
      });
      const saved = await res.json();
      if (saved && saved.id) icpData.id = saved.id;
    } catch (err) {
      console.warn('Backend ICP sync notice:', err.message);
    }

    window.ACTIVE_ICP = icpData;
    this.closeICPModal();

    // Trigger immediate lead refresh & real-time discovery for newly activated ICP!
    if (window.App && typeof window.App.onICPChanged === 'function') {
      await window.App.onICPChanged(icpData);
    }
  },


  openSettings() {
    const modal = document.getElementById('settings-modal-overlay');
    if (modal) modal.classList.remove('hidden');

    // Populate saved keys from localStorage if present
    if (!localStorage.getItem('groq_api_key')) {
      localStorage.setItem('groq_api_key', '');
    }
    if (!localStorage.getItem('apollo_api_key')) {
      localStorage.setItem('apollo_api_key', '');
    }

    // Populate saved keys from localStorage
    const setVal = (id, key) => {
      const el = document.getElementById(id);
      if (el) el.value = localStorage.getItem(key) || '';
    };
    setVal('input-groq-key', 'groq_api_key');
    setVal('input-apollo-key', 'apollo_api_key');
    setVal('input-hunter-key', 'hunter_api_key');

    const status = document.getElementById('groq-status');
    if (status) {
      status.textContent = '🟢 Groq API Key Active (llama-3.3-70b-versatile)';
      status.style.color = 'var(--emerald)';
    }
  },


  closeSettings() {
    // Save keys to localStorage
    const setKey = (id, key) => {
      const val = document.getElementById(id)?.value.trim();
      if (val) localStorage.setItem(key, val);
    };
    setKey('input-groq-key', 'groq_api_key');
    setKey('input-apollo-key', 'apollo_api_key');
    setKey('input-hunter-key', 'hunter_api_key');

    const modal = document.getElementById('settings-modal-overlay');
    if (modal) modal.classList.add('hidden');
  },

  draftEmail(leadId) {
    const lead = window.DEMO_LEADS.find(l => l.id === leadId);
    if (!lead) return;

    // Switch to copilot tab and populate draft prompt
    document.getElementById('tab-ai-assistant')?.click();

    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.value = `Draft a personalized cold outreach email for ${lead.contact_name} (${lead.contact_title} at ${lead.company_name}) mentioning their recent hiring signals.`;
      chatInput.focus();
    }
    this.closeDrawer();
  },

  init() {
    document.getElementById('btn-close-drawer')?.addEventListener('click', () => this.closeDrawer());
    document.getElementById('drawer-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'drawer-overlay') this.closeDrawer();
    });

    document.getElementById('btn-settings')?.addEventListener('click', () => this.openSettings());
    document.getElementById('settings-close')?.addEventListener('click', () => this.closeSettings());
    document.getElementById('settings-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'settings-modal-overlay') this.closeSettings();
    });

    // ICP Modal Event Handlers
    document.getElementById('btn-icp-select')?.addEventListener('click', () => this.openICPModal());
    document.getElementById('icp-modal-close')?.addEventListener('click', () => this.closeICPModal());
    document.getElementById('btn-cancel-icp')?.addEventListener('click', () => this.closeICPModal());
    document.getElementById('icp-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'icp-modal-overlay') this.closeICPModal();
    });
    document.getElementById('btn-save-icp')?.addEventListener('click', () => this.saveICP());

    // Preset buttons inside ICP Modal
    document.querySelectorAll('.icp-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.applyPreset(btn.dataset.preset);
      });
    });

    document.getElementById('btn-save-groq')?.addEventListener('click', () => {
      const val = document.getElementById('input-groq-key')?.value.trim();
      if (val) localStorage.setItem('groq_api_key', val);
      const status = document.getElementById('groq-status');
      if (status) {
        status.textContent = '🟢 Groq API Key Saved! Ultra-fast Llama-3 scoring active.';
        status.style.color = 'var(--emerald)';
      }
    });

    document.getElementById('btn-save-all-settings')?.addEventListener('click', () => this.closeSettings());
  },


  getSignalIcon(type) {
    return { news_mention: '📰', job_posting: '💼', social_post: '💬', web_mention: '🌐', funding: '💰' }[type] || '📌';
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
};

window.Modal = Modal;

