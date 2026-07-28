/**
 * LeadPulse AI — Next-Gen Views Module
 * Renders Grid Cards, Table Rows, Split Inspector, and Discovery Stream Radar
 */

const Views = {
  currentMode: 'grid', // 'grid' | 'table' | 'split'
  sortColumn: 'total_score',
  sortDirection: 'desc',

  /**
   * Render the current active view mode with provided leads
   */
  render(leads) {
    const sorted = this.sortLeads(leads);

    switch (this.currentMode) {
      case 'grid':
        this.renderGrid(sorted);
        break;
      case 'table':
        this.renderTable(sorted);
        break;
      case 'split':
        this.renderSplit(sorted);
        break;
    }
  },

  /**
   * Switch View Mode (Grid / Table / Split)
   */
  setMode(mode) {
    this.currentMode = mode;

    document.querySelectorAll('.view-switch__btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    document.getElementById('view-grid-container').classList.toggle('hidden', mode !== 'grid');
    document.getElementById('view-table-container').classList.toggle('hidden', mode !== 'table');
    document.getElementById('view-split-container').classList.toggle('hidden', mode !== 'split');
  },

  /**
   * Sort leads list
   */
  sortLeads(leads) {
    return [...leads].sort((a, b) => {
      let valA = a[this.sortColumn];
      let valB = b[this.sortColumn];

      if (typeof valA === 'string') valA = valA.toLowerCase();
      if (typeof valB === 'string') valB = valB.toLowerCase();

      if (valA < valB) return this.sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return this.sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  },

  /**
   * Render Grid Cards Mode
   */
  renderGrid(leads) {
    const container = document.getElementById('leads-grid');
    container.innerHTML = '';

    leads.forEach(lead => {
      const tier = lead.tier || (lead.total_score >= 70 ? 'hot' : lead.total_score >= 40 ? 'warm' : 'cold');
      const totalScore = lead.total_score ?? 75;

      const card = document.createElement('div');
      card.className = `lead-card-new lead-card-new--${tier}`;
      card.dataset.leadId = lead.id;

      const signals = (lead.signals || []).slice(0, 3);
      const sourceLabel = this.getSourceLabel(lead.source);

      card.innerHTML = `
        <div>
          <div class="lead-card-new__top">
            <div>
              <div class="lead-card-new__company">${this.escapeHtml(lead.company_name)}</div>
              <div class="lead-card-new__industry">${this.escapeHtml(lead.company_industry || 'SaaS')} · ${lead.company_size || '—'} employees</div>
            </div>
            <div class="score-badge-ring score-badge-ring--${tier}">
              ${totalScore}
            </div>
          </div>

          <div class="lead-card-new__contact">
            <div class="contact-name">${this.escapeHtml(lead.contact_name || 'Decision Maker')}</div>
            <div class="contact-title">${this.escapeHtml(lead.contact_title || '—')}</div>
          </div>

          <div class="lead-card-new__signals">
            ${signals.map(s => `<span class="signal-pill">${this.getSignalIcon(s.type)} ${this.escapeHtml(s.title || s.type)}</span>`).join('')}
          </div>
        </div>

        <div class="lead-card-new__bottom">
          <span>📍 ${this.escapeHtml(lead.company_location || 'US')}</span>
          <span class="badge badge--${tier === 'hot' ? 'success' : 'warning'}">${sourceLabel.toUpperCase()}</span>
        </div>
      `;

      card.addEventListener('click', () => Modal.openLeadDrawer(lead));
      container.appendChild(card);
    });
  },

  /**
   * Render Table Mode
   */
  renderTable(leads) {
    const tbody = document.getElementById('leads-table-body');
    tbody.innerHTML = '';

    leads.forEach((lead, idx) => {
      const tier = lead.tier || (lead.total_score >= 70 ? 'hot' : lead.total_score >= 40 ? 'warm' : 'cold');
      const totalScore = lead.total_score ?? 75;

      const tr = document.createElement('tr');
      tr.addEventListener('click', () => Modal.openLeadDrawer(lead));

      tr.innerHTML = `
        <td><strong>#${idx + 1}</strong></td>
        <td>
          <strong style="color:#fff;">${this.escapeHtml(lead.company_name)}</strong><br>
          <span style="font-size:0.75rem;color:var(--text-tertiary);">${this.escapeHtml(lead.company_location || '—')}</span>
        </td>
        <td>
          <strong style="color:var(--cyan);">${this.escapeHtml(lead.contact_name || '—')}</strong><br>
          <span style="font-size:0.75rem;color:var(--text-tertiary);">${this.escapeHtml(lead.contact_title || '—')}</span>
        </td>
        <td>
          <span class="score-badge-ring score-badge-ring--${tier}" style="width:36px;height:36px;font-size:0.85rem;">${totalScore}</span>
        </td>
        <td><span class="badge badge--${tier === 'hot' ? 'success' : 'warning'}">${tier.toUpperCase()}</span></td>
        <td><span style="font-size:0.78rem;color:var(--text-secondary);">${this.getSourceLabel(lead.source)}</span></td>
        <td>
          <div style="display:flex;gap:4px;">
            ${(lead.signals || []).slice(0, 2).map(s => `<span class="signal-pill">${this.getSignalIcon(s.type)}</span>`).join('')}
          </div>
        </td>
        <td>
          <button class="btn btn--secondary" style="padding:4px 10px;font-size:0.75rem;">Inspect</button>
        </td>
      `;

      tbody.appendChild(tr);
    });
  },

  /**
   * Render Split Inspection Mode
   */
  renderSplit(leads) {
    const listContainer = document.getElementById('split-list');
    const inspector = document.getElementById('split-inspector');

    listContainer.innerHTML = '';
    if (leads.length === 0) return;

    leads.forEach((lead, i) => {
      const tier = lead.tier || (lead.total_score >= 70 ? 'hot' : lead.total_score >= 40 ? 'warm' : 'cold');
      const totalScore = lead.total_score ?? 75;

      const item = document.createElement('div');
      item.className = `stream-item ${i === 0 ? 'active' : ''}`;
      item.style.cursor = 'pointer';
      item.innerHTML = `
        <div class="score-badge-ring score-badge-ring--${tier}" style="width:38px;height:38px;font-size:0.85rem;">${totalScore}</div>
        <div class="stream-item__content">
          <strong>${this.escapeHtml(lead.company_name)}</strong>
          <p>${this.escapeHtml(lead.contact_name || '')} (${this.escapeHtml(lead.contact_title || '')})</p>
        </div>
      `;

      item.addEventListener('click', () => {
        document.querySelectorAll('#split-list .stream-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        this.renderInspectorContent(inspector, lead);
      });

      listContainer.appendChild(item);
    });

    // Render first lead by default
    this.renderInspectorContent(inspector, leads[0]);
  },

  /**
   * Render details inside split inspector panel
   */
  renderInspectorContent(container, lead) {
    const tier = lead.tier || (lead.total_score >= 70 ? 'hot' : lead.total_score >= 40 ? 'warm' : 'cold');
    const totalScore = lead.total_score ?? 75;

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
        <div>
          <h2 style="font-family:var(--font-display);font-size:1.4rem;">${this.escapeHtml(lead.company_name)}</h2>
          <span style="font-size:0.8rem;color:var(--text-tertiary);">${this.escapeHtml(lead.company_industry)} · ${lead.company_size || '—'} employees · ${this.escapeHtml(lead.company_location)}</span>
        </div>
        <div class="score-badge-ring score-badge-ring--${tier}" style="width:56px;height:56px;font-size:1.2rem;">
          ${totalScore}
        </div>
      </div>

      <div style="padding:14px;background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.2);border-radius:12px;margin-bottom:20px;">
        <h4 style="color:var(--cyan);font-size:0.82rem;margin-bottom:6px;">⚡ GROQ LLM SCORE EXPLANATION</h4>
        <p style="font-size:0.88rem;line-height:1.6;color:var(--text-secondary);">${this.escapeHtml(lead.explanation || lead.explanation_text || 'High conversion probability based on hiring signals and title match.')}</p>
      </div>

      <h4 style="font-size:0.8rem;color:var(--text-tertiary);margin-bottom:10px;">5-DIMENSION SCORE BREAKDOWN</h4>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:24px;">
        ${this.renderProgressBar('Intent Signals (30%)', lead.intent_score ?? 80)}
        ${this.renderProgressBar('Profile Fit (25%)', lead.profile_fit_score ?? 75)}
        ${this.renderProgressBar('Company Fit (20%)', lead.company_fit_score ?? 75)}
        ${this.renderProgressBar('Recency Decay (15%)', lead.recency_score ?? 85)}
        ${this.renderProgressBar('Engagement History (10%)', lead.engagement_score ?? 60)}
      </div>

      <h4 style="font-size:0.8rem;color:var(--text-tertiary);margin-bottom:10px;">PRIMARY CONTACT</h4>
      <div style="padding:12px;background:rgba(255,255,255,0.02);border:1px solid var(--border-glass);border-radius:10px;margin-bottom:20px;">
        <strong style="font-size:0.95rem;">${this.escapeHtml(lead.contact_name)}</strong><br>
        <span style="color:var(--cyan);font-size:0.82rem;">${this.escapeHtml(lead.contact_title)}</span><br>
        <span style="color:var(--text-tertiary);font-size:0.8rem;">✉️ ${this.escapeHtml(lead.contact_email || 'Verified via Apollo')}</span>
      </div>

      <button class="btn btn--primary" style="width:100%;" onclick="Modal.openLeadDrawer(window.App.allLeads.find(l=>l.id==='${lead.id}') || window.DEMO_LEADS.find(l=>l.id==='${lead.id}'))">Open Full Inspection Drawer</button>
    `;
  },

  renderProgressBar(label, score) {
    const color = score >= 70 ? 'var(--emerald)' : score >= 40 ? 'var(--amber)' : 'var(--rose)';
    return `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-bottom:3px;">
          <span style="color:var(--text-secondary);">${label}</span>
          <strong>${score}/100</strong>
        </div>
        <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">
          <div style="width:${score}%;height:100%;background:${color};border-radius:3px;transition:width 0.6s ease;"></div>
        </div>
      </div>
    `;
  },

  getSourceLabel(src) {
    return { web_scrape: 'Web Scrape', news: 'News Mention', job_board: 'Job Posting', social: 'Social Signals', enrichment: 'Apollo' }[src] || src;
  },

  getSignalIcon(type) {
    return { news_mention: '📰', job_posting: '💼', social_post: '💬', web_mention: '🌐', funding: '💰' }[type] || '📌';
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
};

window.Views = Views;
