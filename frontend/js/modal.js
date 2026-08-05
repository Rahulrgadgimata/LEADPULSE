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
        ${Review.badgeHtml(lead)}
        <h1 style="font-family:var(--font-display);font-size:1.8rem;font-weight:800;color:var(--text-primary);">${this.escapeHtml(lead.company_name)}</h1>
        <p style="color:var(--text-tertiary);font-size:0.85rem;">${lead.company_description ? this.escapeHtml(lead.company_description) : '<em style="opacity:.6">No description captured for this company.</em>'}</p>
      </div>

      <!-- Score Ring & 5-Dimension Overview -->
      <div style="display:flex;align-items:center;gap:20px;padding:20px;background:var(--bg-surface);border:1px solid var(--border-glass);border-radius:16px;margin-bottom:24px;">
        <div class="score-badge-ring score-badge-ring--${tier}" style="width:80px;height:80px;font-size:1.8rem;">
          ${totalScore}
          <span style="font-size:0.6rem;font-weight:600;color:var(--text-tertiary);">MATCH SCORE</span>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
          ${this.renderBar('Intent Signals (30%)', lead.intent_score ?? 0)}
          ${this.renderBar('Profile Fit (25%)', lead.profile_fit_score ?? 0)}
          ${this.renderBar('Company Fit (20%)', lead.company_fit_score ?? 0)}
          ${this.renderBar('Recency (15%)', lead.recency_score ?? 0)}
          ${this.renderBar('Engagement (10%)', lead.engagement_score ?? 0)}
        </div>
      </div>

      <!-- Groq AI Explanation Card -->
      <div style="padding:16px;background:linear-gradient(135deg, rgba(13,148,136,0.08), rgba(2,132,199,0.08));border:1px solid rgba(13,148,136,0.2);border-radius:14px;margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <strong style="color:var(--cyan);font-size:0.85rem;letter-spacing:0.04em;">AI SCORE INSIGHT</strong>
        </div>
        <p style="font-size:0.9rem;line-height:1.6;color:var(--text-secondary);">${(lead.explanation || lead.explanation_text) ? this.escapeHtml(lead.explanation || lead.explanation_text) : '<em style="opacity:.6">No AI explanation was generated for this lead.</em>'}</p>
      </div>

      <!-- Primary Decision Maker Contact Card -->
      <div style="margin-bottom:24px;">
        <h3 style="font-size:0.82rem;font-weight:700;color:var(--text-tertiary);letter-spacing:0.06em;margin-bottom:12px;">DECISION MAKER CONTACT</h3>
        <div style="padding:16px;background:var(--bg-surface);border:1px solid var(--border-glass);border-radius:14px;">
          <strong style="font-size:1.05rem;color:var(--text-primary);">${lead.contact_name ? this.escapeHtml(lead.contact_name) : '<em style="opacity:.5;font-weight:400;">No contact discovered</em>'}</strong>
          <div style="color:var(--cyan);font-size:0.85rem;font-weight:600;margin-top:2px;">${this.escapeHtml(lead.contact_title || '')}</div>
          <div style="font-size:0.82rem;color:var(--text-secondary);margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;">
            <span>✉️ ${lead.contact_email ? this.escapeHtml(lead.contact_email) : '<span style="opacity:.5">no email found</span>'}</span>
            ${lead.company_website
              ? `<span>🌐 <a href="https://${this.escapeHtml(String(lead.company_website).replace(/^https?:\/\//, ''))}" target="_blank" rel="noopener noreferrer" style="color:var(--cyan);">${this.escapeHtml(lead.company_website)}</a></span>`
              : '<span style="opacity:.5">🌐 no website</span>'}
            ${lead.contact_linkedin
              ? `<span><a href="${this.escapeHtml(lead.contact_linkedin)}" target="_blank" rel="noopener noreferrer" style="color:var(--cyan);">LinkedIn →</a></span>`
              : ''}
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
                <strong style="font-size:0.85rem;color:var(--text-primary);">${this.escapeHtml(s.title)}</strong>
                <div style="font-size:0.72rem;color:var(--text-tertiary);margin-top:2px;">${s.date} · Detected via ${lead.source}</div>
              </div>
            </div>
          `).join('') || '<p style="color:var(--text-tertiary);font-size:0.85rem;">No signals detected.</p>'}
        </div>
      </div>

      <!-- The decision this dashboard exists to capture -->
      <div class="drawer-review">
        <h3 style="font-size:0.82rem;font-weight:700;color:var(--text-tertiary);letter-spacing:0.06em;margin-bottom:10px;">YOUR DECISION</h3>
        ${Review.actionsHtml(lead.id, lead, 'lg')}
      </div>

      <!-- Quick Action Buttons -->
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button class="btn btn--primary" style="flex:1;" data-compose-lead="${this.escapeHtml(lead.id)}">📧 Write first message</button>
        <button class="btn btn--secondary" id="drawer-close-btn">Close</button>
      </div>
    `;

    // Listeners rather than inline onclick: the app's CSP sets
    // script-src-attr 'none', which blocks inline handlers outright.
    content.querySelector('#drawer-close-btn')?.addEventListener('click', () => this.closeDrawer());

    // One delegated handler covers the review buttons and the compose button.
    Review.bindDelegatedActions(content);

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
        <div style="height:5px;background:rgba(15,23,42,0.08);border-radius:3px;overflow:hidden;">
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

  // Same-origin by default; see js/config.js for split-host deployments.
  API_BASE: (window.LEADPULSE_API_BASE || '').replace(/\/$/, ''),

  async openICPModal() {
    const modal = document.getElementById('icp-modal-overlay');
    if (modal) modal.classList.remove('hidden');

    // Load saved ICPs so the user can switch target instead of creating a new
    // one every time (which used to leave a trail of empty duplicate ICPs).
    await this.loadSavedICPs();

    if (window.ACTIVE_ICP?.id) {
      this.populateFormFromICP(window.ACTIVE_ICP);
      const select = document.getElementById('icp-saved-select');
      if (select) select.value = window.ACTIVE_ICP.id;
    } else if (!document.getElementById('icp-form-name')?.value) {
      this.applyPreset('saas');
    }
  },

  /**
   * Fetch saved ICPs into the selector, showing how many leads each already has.
   */
  async loadSavedICPs() {
    const select = document.getElementById('icp-saved-select');
    if (!select) return;

    try {
      const res = await fetch(`${this.API_BASE}/api/icp`);
      const icps = await res.json();
      this.savedICPs = Array.isArray(icps) ? icps : [];
    } catch (err) {
      console.warn('Could not load saved ICPs:', err.message);
      this.savedICPs = [];
      return;
    }

    const current = select.value;
    select.innerHTML = '<option value="">— New ICP —</option>';
    for (const icp of this.savedICPs) {
      const option = document.createElement('option');
      option.value = icp.id;
      option.textContent = icp.is_active ? icp.name : `${icp.name} (inactive)`;
      select.appendChild(option);
    }
    if (current) select.value = current;
  },

  /**
   * Fill the form from a stored ICP. Stored list fields arrive as JSON strings.
   */
  populateFormFromICP(icp) {
    const asList = value => {
      if (Array.isArray(value)) return value.join(', ');
      if (typeof value !== 'string') return '';
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.join(', ') : value;
      } catch (e) {
        return value;
      }
    };

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val ?? '';
    };

    setVal('icp-form-name', icp.name);
    setVal('icp-form-desc', icp.description || '');
    setVal('icp-form-industries', asList(icp.industries));
    setVal('icp-form-size-min', icp.company_size_min);
    setVal('icp-form-size-max', icp.company_size_max);
    setVal('icp-form-geos', asList(icp.geographies));
    setVal('icp-form-titles', asList(icp.job_titles));
    setVal('icp-form-keywords', asList(icp.keywords));
    this.syncSizeRangeSelect(icp.company_size_min, icp.company_size_max);

    document.querySelectorAll('.icp-preset-btn[data-preset]').forEach(btn => btn.classList.remove('active'));
  },

  /** Map min/max employee counts onto the closest size dropdown option. */
  syncSizeRangeSelect(min, max) {
    const select = document.getElementById('icp-form-size-range');
    if (!select) return;
    const lo = parseInt(min, 10) || 1;
    const hi = parseInt(max, 10) || 100000;
    const options = [...select.options].map(o => o.value);
    let best = options[0];
    let bestDist = Infinity;
    for (const value of options) {
      const [a, b] = value.split('-').map(Number);
      const dist = Math.abs(a - lo) + Math.abs(b - hi);
      if (dist < bestDist) {
        bestDist = dist;
        best = value;
      }
    }
    select.value = best;
    this.applySizeRange(best);
  },

  /** Push the size dropdown value into the hidden min/max fields. */
  applySizeRange(value) {
    const raw = value || document.getElementById('icp-form-size-range')?.value || '50-1000';
    const [min, max] = raw.split('-').map(n => parseInt(n, 10));
    const minEl = document.getElementById('icp-form-size-min');
    const maxEl = document.getElementById('icp-form-size-max');
    if (minEl) minEl.value = Number.isFinite(min) ? min : 1;
    if (maxEl) maxEl.value = Number.isFinite(max) ? max : 10000;
  },

  /**
   * Switch the active target to an already-saved ICP.
   *
   * Selecting activates immediately rather than only filling the form — the
   * dropdown reads as "which ICP am I working on", so leaving the header and
   * the lead list pointing at the previous target is the behaviour that looked
   * like ICP switching was broken.
   */
  async selectSavedICP(icpId) {
    if (!icpId) {
      this.editingIcpId = null;
      this.applyPreset('saas');
      return;
    }

    const icp = (this.savedICPs || []).find(i => i.id === icpId);
    if (!icp) return;

    this.editingIcpId = icp.id;
    this.populateFormFromICP(icp);

    if (window.App && typeof window.App.setActiveICP === 'function') {
      window.App.setActiveICP(icp);
      await window.App.refreshLeadsFromBackend(icp.id);
      await window.App.refreshRadarStream();
    }
  },

  async deleteSelectedICP() {
    const select = document.getElementById('icp-saved-select');
    const icpId = select?.value;
    if (!icpId) {
      alert('Select a saved ICP to delete.');
      return;
    }

    const icp = (this.savedICPs || []).find(i => i.id === icpId);
    if (!confirm(`Delete ICP "${icp?.name || icpId}"? Its discovered leads stay in the database.`)) return;

    try {
      const res = await fetch(`${this.API_BASE}/api/icp/${icpId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`server responded ${res.status}`);
    } catch (err) {
      alert(`Could not delete ICP: ${err.message}`);
      return;
    }

    this.editingIcpId = null;
    await this.loadSavedICPs();

    // If the deleted ICP was the active target, fall back to another saved one
    // so the dashboard is never left pointing at something that no longer exists.
    if (window.ACTIVE_ICP?.id === icpId && window.App) {
      const next = (this.savedICPs || []).find(i => i.is_active) || (this.savedICPs || [])[0] || null;
      window.App.setActiveICP(next);
      await window.App.refreshLeadsFromBackend(next?.id);
      await window.App.refreshRadarStream();
      const select = document.getElementById('icp-saved-select');
      if (select) select.value = next?.id || '';
      if (next) this.populateFormFromICP(next);
      else this.applyPreset('saas');
      return;
    }

    this.applyPreset('saas');
  },

  closeICPModal() {
    const modal = document.getElementById('icp-modal-overlay');
    if (modal) modal.classList.add('hidden');
  },

  applyPreset(presetKey) {
    const p = this.PRESETS[presetKey];
    if (!p) return;

    // A preset describes a new profile, so leave "edit saved ICP" mode. Without
    // this, picking a preset while a saved ICP is selected would overwrite it.
    this.editingIcpId = null;
    const select = document.getElementById('icp-saved-select');
    if (select) select.value = '';

    // Update active button highlight
    document.querySelectorAll('.icp-preset-btn[data-preset]').forEach(btn => {
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
    this.syncSizeRangeSelect(p.minSize, p.maxSize);
  },

  async saveICP() {
    this.applySizeRange();

    const name = document.getElementById('icp-form-name')?.value.trim();
    if (!name) {
      alert('Please enter a profile name.');
      return;
    }

    const industries = (document.getElementById('icp-form-industries')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const keywords = (document.getElementById('icp-form-keywords')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const geographies = (document.getElementById('icp-form-geos')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const job_titles = (document.getElementById('icp-form-titles')?.value || '').split(',').map(s => s.trim()).filter(Boolean);

    const icpData = {
      name,
      description: document.getElementById('icp-form-desc')?.value.trim() ||
        `${industries[0] || 'B2B'} companies${geographies[0] ? ' in ' + geographies[0] : ''}`,
      industries,
      company_size_min: parseInt(document.getElementById('icp-form-size-min')?.value || '1', 10),
      company_size_max: parseInt(document.getElementById('icp-form-size-max')?.value || '10000', 10),
      geographies,
      job_titles,
      keywords,
      is_active: true
    };

    // Update an existing ICP rather than always creating one. Creating on every
    // save produced a new empty ICP each time the target "changed", so the
    // dashboard switched to a profile that had no leads.
    const selectedId = document.getElementById('icp-saved-select')?.value || this.editingIcpId || null;

    let saved;
    try {
      const res = await fetch(
        selectedId ? `${this.API_BASE}/api/icp/${selectedId}` : `${this.API_BASE}/api/icp`,
        {
          method: selectedId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(icpData)
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `server responded ${res.status}`);
      }
      saved = await res.json();
    } catch (err) {
      // Without a real id the backend cannot target this ICP, so stop here
      // instead of silently running discovery against a different profile.
      alert(
        `Could not save the ICP: ${err.message}\n\n` +
        `Check that the backend is running at ${this.API_BASE} (npm start in the backend folder).`
      );
      return;
    }

    if (!saved || !saved.id) {
      alert('The server saved the ICP but returned no id. Reload and try again.');
      return;
    }

    // Prefer the server's copy so the active ICP matches what was stored.
    const activeIcp = { ...icpData, ...saved, id: saved.id };
    this.editingIcpId = saved.id;

    await this.loadSavedICPs();
    const select = document.getElementById('icp-saved-select');
    if (select) select.value = saved.id;

    this.closeICPModal();

    // Refresh leads for the newly activated ICP (and discover if it has none).
    if (window.App && typeof window.App.onICPChanged === 'function') {
      await window.App.onICPChanged(activeIcp);
    }
  },


  /**
   * Settings shows which integrations the *server* has configured.
   *
   * API keys are no longer entered or stored here. They previously lived in
   * localStorage, readable by any script on the page, and the status line was
   * hardcoded to "Active" whether or not a key existed.
   */
  async openSettings() {
    const modal = document.getElementById('settings-modal-overlay');
    if (modal) modal.classList.remove('hidden');

    // Any leftover keys from the old build are a liability; clear them.
    ['groq_api_key', 'apollo_api_key', 'hunter_api_key'].forEach(k => localStorage.removeItem(k));

    const status = document.getElementById('groq-status');
    if (status) {
      status.textContent = 'Checking integration status…';
      status.style.color = 'var(--text-muted)';
    }

    let data;
    try {
      const res = await fetch(`${this.API_BASE}/api/status`);
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      data = await res.json();
    } catch (err) {
      if (status) {
        status.textContent = `Could not reach the API: ${err.message}`;
        status.style.color = 'var(--rose, #f43f5e)';
      }
      return;
    }

    if (status) {
      const groqOn = data.providers?.groq?.configured;
      status.textContent = groqOn
        ? `🟢 Groq connected (${data.model})`
        : '🔴 Groq not configured — set GROQ_API_KEY in backend .env';
      status.style.color = groqOn ? 'var(--emerald)' : 'var(--rose, #f43f5e)';
    }

    const list = document.getElementById('provider-status-list');
    if (list) {
      list.innerHTML = '';
      for (const [name, info] of Object.entries(data.providers || {})) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:baseline;padding:4px 0;';
        const dot = document.createElement('span');
        dot.textContent = info.configured ? '🟢' : '⚪';
        const label = document.createElement('strong');
        label.textContent = name;
        label.style.minWidth = '80px';
        const purpose = document.createElement('span');
        purpose.style.cssText = 'color:var(--text-muted);font-size:12px;';
        purpose.textContent = info.configured ? info.purpose : `${info.purpose} — not configured`;
        row.append(dot, label, purpose);
        list.appendChild(row);
      }
    }
  },

  closeSettings() {
    const modal = document.getElementById('settings-modal-overlay');
    if (modal) modal.classList.add('hidden');
  },

  /**
   * Open the message composer for a lead.
   *
   * This used to type a prompt into the copilot chat box and leave the user to
   * copy the reply out by hand. It now opens the real composer, where the draft
   * is saved against the lead and can be edited, scheduled and sent.
   */
  draftEmail(leadId) {
    window.Outreach?.openComposer(leadId);
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
    document.getElementById('icp-form-size-range')?.addEventListener('change', (e) => {
      this.applySizeRange(e.target.value);
    });

    // Saved-ICP selector: switching loads that profile as the edit target.
    document.getElementById('icp-saved-select')?.addEventListener('change', (e) => {
      this.selectSavedICP(e.target.value);
    });
    document.getElementById('btn-icp-delete')?.addEventListener('click', () => this.deleteSelectedICP());

    // Preset buttons inside ICP Modal
    document.querySelectorAll('.icp-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.applyPreset(btn.dataset.preset);
      });
    });

    // The "save Groq key" handler is gone: keys live in backend/.env, and the
    // old handler reported success without ever validating the key.
    document.getElementById('btn-save-all-settings')?.addEventListener('click', () => this.closeSettings());
  },


  getSignalIcon(type) {
    return { news_mention: '📰', job_posting: '💼', social_post: '💬', web_mention: '🌐', linkedin: '🔗', funding: '💰' }[type] || '📌';
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
};

window.Modal = Modal;

