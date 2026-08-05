/**
 * LeadPulse AI — Lead Review
 *
 * The human half of "the AI surfaces, the human decides": accept / reject /
 * hold, bulk actions, manual entry, and the CSV export of what survived review.
 */

const Review = {
  API_BASE: (window.LEADPULSE_API_BASE || '').replace(/\/$/, ''),

  // Ids the user has ticked. Held here rather than read off the DOM at action
  // time so a selection survives a re-render — switching view mode or letting
  // the list refresh should not silently drop what you had selected.
  selected: new Set(),

  STATUS_META: {
    pending: { label: 'Pending', icon: '·', className: 'review-badge--pending' },
    accepted: { label: 'Accepted', icon: '✓', className: 'review-badge--accepted' },
    rejected: { label: 'Rejected', icon: '✕', className: 'review-badge--rejected' },
    hold: { label: 'On hold', icon: '⏸', className: 'review-badge--hold' },
  },

  init() {
    this.bindBulkBar();
    this.bindManualEntry();

    document.getElementById('btn-export')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.exportCSV();
    });
  },

  statusOf(lead) {
    return lead?.review_status || 'pending';
  },

  // ─── Single-lead decisions ────────────────────────────────────────────────

  /**
   * Record one decision.
   *
   * The lead in App's in-memory list is updated from the server's response
   * rather than from what we optimistically assumed, so a rejected write can
   * never leave the UI showing a decision the database does not have.
   */
  async setStatus(leadId, reviewStatus, note = null) {
    try {
      const res = await fetch(`${this.API_BASE}/api/leads/${encodeURIComponent(leadId)}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewStatus, note }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      this.applyServerLead(data.lead);
      this.renderCounts(data.counts);
      App.applyFilters();

      if (window.Outreach) Outreach.onReviewChanged();
      return data.lead;
    } catch (err) {
      alert(`Could not save that decision: ${err.message}`);
      return null;
    }
  },

  /** Copy a server-returned lead over the cached copy, preserving joined score fields. */
  applyServerLead(updated) {
    if (!updated) return;
    const list = window.App?.allLeads || [];
    const index = list.findIndex(l => l.id === updated.id);
    // The review endpoint returns the leads row only; the cached copy carries
    // the joined score columns, so merge rather than replace or the card loses
    // its score and tier.
    if (index !== -1) list[index] = { ...list[index], ...updated };
  },

  // ─── Bulk ─────────────────────────────────────────────────────────────────

  toggleSelected(leadId, isSelected) {
    if (isSelected) this.selected.add(leadId);
    else this.selected.delete(leadId);
    this.renderBulkBar();
  },

  isSelected(leadId) {
    return this.selected.has(leadId);
  },

  clearSelection() {
    this.selected.clear();
    document.querySelectorAll('.lead-select').forEach(box => { box.checked = false; });
    this.renderBulkBar();
  },

  selectAllShown() {
    for (const lead of window.App?.filteredLeads || []) this.selected.add(lead.id);
    document.querySelectorAll('.lead-select').forEach(box => { box.checked = true; });
    this.renderBulkBar();
  },

  /** "Accept all Hot leads in one click" — select the tier, then act. */
  selectTier(tier) {
    for (const lead of window.App?.filteredLeads || []) {
      if (lead.tier === tier) this.selected.add(lead.id);
    }
    document.querySelectorAll('.lead-select').forEach(box => {
      if (this.selected.has(box.dataset.leadId)) box.checked = true;
    });
    this.renderBulkBar();
  },

  renderBulkBar() {
    const bar = document.getElementById('bulk-bar');
    const count = document.getElementById('bulk-count');
    if (!bar || !count) return;

    count.textContent = this.selected.size;
    bar.classList.toggle('hidden', this.selected.size === 0);
  },

  async bulkSetStatus(reviewStatus) {
    const ids = [...this.selected];
    if (ids.length === 0) return;

    const meta = this.STATUS_META[reviewStatus];
    // Rejecting in bulk is the one that stings if it was a misclick, and the
    // count is the part people get wrong, so put it in the question.
    if (reviewStatus === 'rejected' && ids.length > 5 &&
        !confirm(`Reject ${ids.length} leads? They stay in the database but drop out of your outreach queue.`)) {
      return;
    }

    try {
      const res = await fetch(`${this.API_BASE}/api/leads/bulk-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, reviewStatus, icpId: window.ACTIVE_ICP?.id || null }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      // Reflect the change locally instead of refetching: the list can be
      // hundreds of rows and the server already told us it applied cleanly.
      const now = new Date().toISOString();
      for (const lead of window.App?.allLeads || []) {
        if (this.selected.has(lead.id)) {
          lead.review_status = reviewStatus;
          lead.reviewed_at = reviewStatus === 'pending' ? null : now;
        }
      }

      this.clearSelection();
      this.renderCounts(data.counts);
      App.applyFilters();
      if (window.Outreach) Outreach.onReviewChanged();

      App.toast(`${data.updated} lead${data.updated === 1 ? '' : 's'} marked ${meta.label.toLowerCase()}.`);
    } catch (err) {
      alert(`Bulk action failed: ${err.message}`);
    }
  },

  bindBulkBar() {
    document.querySelectorAll('[data-bulk]').forEach(btn => {
      btn.addEventListener('click', () => this.bulkSetStatus(btn.dataset.bulk));
    });

    document.getElementById('btn-bulk-clear')?.addEventListener('click', () => this.clearSelection());
    document.getElementById('btn-bulk-select-all')?.addEventListener('click', () => this.selectAllShown());
    document.getElementById('btn-bulk-select-hot')?.addEventListener('click', () => this.selectTier('hot'));
  },

  /** Review counts shown on the sidebar chips. */
  renderCounts(counts) {
    if (!counts) return;
    this.counts = counts;
    if (window.Filters) Filters.updateReviewCounts(counts);
  },

  // ─── Manual entry ─────────────────────────────────────────────────────────

  bindManualEntry() {
    const overlay = document.getElementById('manual-lead-overlay');

    document.getElementById('btn-add-lead')?.addEventListener('click', () => {
      overlay?.classList.remove('hidden');
      document.getElementById('ml-company')?.focus();
    });

    const close = () => overlay?.classList.add('hidden');
    document.getElementById('manual-lead-close')?.addEventListener('click', close);
    document.getElementById('btn-cancel-manual-lead')?.addEventListener('click', close);
    overlay?.addEventListener('click', (e) => {
      if (e.target.id === 'manual-lead-overlay') close();
    });

    document.getElementById('btn-save-manual-lead')?.addEventListener('click', () => this.saveManualLead());
  },

  async saveManualLead() {
    const value = id => document.getElementById(id)?.value.trim() || '';

    const company = value('ml-company');
    if (!company) {
      alert('A company name is required.');
      document.getElementById('ml-company')?.focus();
      return;
    }

    const payload = {
      company_name: company,
      company_website: value('ml-website'),
      company_industry: value('ml-industry'),
      company_location: value('ml-location'),
      contact_name: value('ml-contact'),
      contact_title: value('ml-title'),
      contact_email: value('ml-email'),
      contact_linkedin: value('ml-linkedin'),
      signal_note: value('ml-signal'),
      icp_id: window.ACTIVE_ICP?.id || null,
    };

    try {
      const res = await fetch(`${this.API_BASE}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      document.getElementById('manual-lead-overlay')?.classList.add('hidden');
      document.getElementById('manual-lead-form')?.reset();

      await App.refreshLeadsFromBackend();
      if (window.Outreach) Outreach.onReviewChanged();

      App.toast(data.message || 'Lead added.');
    } catch (err) {
      alert(`Could not add that lead: ${err.message}`);
    }
  },

  // ─── Export ───────────────────────────────────────────────────────────────

  /**
   * Export accepted leads.
   *
   * Downloaded from the API rather than serialised from the loaded page, so the
   * file covers every accepted lead and every field — not just the rows and
   * columns the dashboard happens to be showing.
   */
  exportCSV() {
    const params = new URLSearchParams();
    if (window.ACTIVE_ICP?.id) params.set('icpId', window.ACTIVE_ICP.id);

    const statuses = window.Filters?.activeFilters?.review || [];
    // Default to accepted only — the export exists to hand a reviewed list on.
    params.set('reviewStatus', statuses.length > 0 ? statuses.join(',') : 'accepted');

    const accepted = (window.App?.allLeads || []).filter(l => this.statusOf(l) === 'accepted').length;
    if (statuses.length === 0 && accepted === 0 &&
        !confirm('No leads are accepted yet, so the export will be empty. Accept some leads first — download anyway?')) {
      return;
    }

    window.location.href = `${this.API_BASE}/api/leads/export.csv?${params.toString()}`;
  },

  // ─── Rendering helpers used by views.js and modal.js ──────────────────────

  /** The small status pill shown on cards, rows and the drawer. */
  badgeHtml(lead) {
    const status = this.statusOf(lead);
    const meta = this.STATUS_META[status] || this.STATUS_META.pending;
    return `<span class="review-badge ${meta.className}">${meta.icon} ${meta.label}</span>`;
  },

  /**
   * The Accept / Hold / Reject button row.
   *
   * The lead's current decision is rendered as the active button, and pressing
   * it again returns the lead to pending — an accept made by mistake needs an
   * undo that does not require hunting for a separate control.
   */
  actionsHtml(leadId, lead, size = 'sm') {
    const current = this.statusOf(lead);
    const button = (status, icon, label, cls) => `
      <button class="review-btn review-btn--${cls} ${current === status ? 'is-active' : ''} review-btn--${size}"
              data-review-action="${status}" data-lead-id="${leadId}"
              title="${current === status ? 'Undo — back to pending' : label}">
        ${icon}<span>${label}</span>
      </button>`;

    return `<div class="review-actions">
      ${button('accepted', '✓', 'Accept', 'accept')}
      ${button('hold', '⏸', 'Hold', 'hold')}
      ${button('rejected', '✕', 'Reject', 'reject')}
    </div>`;
  },

  /**
   * One delegated handler for every review control on the page.
   *
   * Bound once on a container rather than per button, so the freshly rendered
   * buttons after each list re-render are live without rebinding anything.
   */
  bindDelegatedActions(container) {
    if (!container || container.dataset.reviewBound === 'true') return;
    container.dataset.reviewBound = 'true';

    container.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-review-action]');
      if (actionBtn) {
        e.preventDefault();
        e.stopPropagation();
        const { reviewAction, leadId } = actionBtn.dataset;
        const lead = (window.App?.allLeads || []).find(l => l.id === leadId);
        // Pressing the active decision again clears it.
        const next = this.statusOf(lead) === reviewAction ? 'pending' : reviewAction;
        this.setStatus(leadId, next);
        return;
      }

      const composeBtn = e.target.closest('[data-compose-lead]');
      if (composeBtn) {
        e.preventDefault();
        e.stopPropagation();
        window.Outreach?.openComposer(composeBtn.dataset.composeLead);
      }
    });

    container.addEventListener('change', (e) => {
      const box = e.target.closest('.lead-select');
      if (!box) return;
      this.toggleSelected(box.dataset.leadId, box.checked);
    });
  },
};

window.Review = Review;
