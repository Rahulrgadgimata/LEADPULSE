/**
 * LeadPulse AI — AI Outreach & Message Engine (UI)
 *
 * Turns an accepted lead into a personalised first message: generate, edit,
 * send or schedule. Two ways to generate —
 *
 *   "Generate with AI"  the server calls the configured engine and fills the
 *                       editor in one click.
 *   "Open in Gemini"    no API key: the server builds the prompt, this page
 *                       copies it and opens Gemini under the user's own Google
 *                       login, and the user pastes the answer back. A server
 *                       cannot borrow a browser session, so the human is the
 *                       bridge — that step is manual by necessity, not by
 *                       oversight.
 */

const Outreach = {
  API_BASE: (window.LEADPULSE_API_BASE || '').replace(/\/$/, ''),

  status: null,
  templates: [],
  messages: [],
  activeSub: 'queue',
  composerLeadId: null,
  composerMessage: null,
  selectedDrafts: new Set(),

  async init() {
    this.bindSubtabs();
    this.bindComposer();
    this.bindGeminiModal();
    this.bindOptOut();

    await this.refreshStatus();
    await this.refreshTemplates();
  },

  // ─── Status ───────────────────────────────────────────────────────────────

  async refreshStatus() {
    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/status`);
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      this.status = await res.json();
    } catch (err) {
      this.status = null;
      console.warn('Outreach status unavailable:', err.message);
    }
    this.renderStatusLine();
  },

  /**
   * One honest line about what this module can currently do.
   *
   * Both halves matter and they fail independently: an engine can be ready to
   * write while SMTP cannot send a thing. Saying so up front beats letting the
   * user find out at the moment they press Send.
   */
  renderStatusLine() {
    const el = document.getElementById('outreach-engine-line');
    if (!el) return;

    if (!this.status) {
      el.textContent = 'Outreach API unreachable — is the backend running?';
      el.className = 'outreach-engine outreach-engine--bad';
      return;
    }

    const { ai, smtp } = this.status;
    const engine = ai.active === 'template'
      ? 'built-in template writer (no AI key configured)'
      : `${ai.active}${ai.models[ai.active] ? ` · ${ai.models[ai.active]}` : ''}`;

    let sending;
    let tone = 'ok';
    if (smtp.dryRun) {
      sending = 'Dry run — messages are logged but not delivered. Set OUTREACH_DRY_RUN=false to send for real.';
      tone = 'warn';
    } else if (!smtp.configured) {
      sending = 'SMTP not configured — you can still draft and open messages in Gmail or your mail client.';
      tone = 'warn';
    } else {
      sending = `Sending as ${smtp.from}`;
    }

    el.className = `outreach-engine outreach-engine--${tone}`;
    el.innerHTML = `<strong>Drafting with:</strong> ${this.escape(engine)} &nbsp;·&nbsp; <strong>Delivery:</strong> ${this.escape(sending)}`;
  },

  // ─── Sub-tabs ─────────────────────────────────────────────────────────────

  bindSubtabs() {
    document.querySelectorAll('.outreach-subtab').forEach(btn => {
      btn.addEventListener('click', () => this.showSub(btn.dataset.sub));
    });

    document.getElementById('btn-send-selected-drafts')
      ?.addEventListener('click', () => this.sendSelectedDrafts());
  },

  showSub(sub) {
    this.activeSub = sub;

    document.querySelectorAll('.outreach-subtab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sub === sub);
    });
    document.querySelectorAll('.outreach-pane').forEach(pane => {
      pane.classList.toggle('hidden', pane.id !== `outreach-pane-${sub}`);
    });

    if (sub === 'queue') this.renderQueue();
    if (sub === 'drafts') this.refreshMessages('draft,scheduled,failed');
    if (sub === 'sent') this.refreshMessages('sent,cancelled');
    if (sub === 'templates') this.refreshTemplates();
    if (sub === 'optout') this.refreshSuppressions();
  },

  /** Called when the review dashboard changes what is accepted. */
  onReviewChanged() {
    this.renderQueue();
    this.updateTabCount();
  },

  updateTabCount() {
    const pill = document.getElementById('outreach-tab-count');
    if (!pill) return;
    const ready = this.acceptedLeads().length;
    pill.textContent = ready;
    pill.hidden = ready === 0;
  },

  acceptedLeads() {
    return (window.App?.allLeads || []).filter(l => (l.review_status || 'pending') === 'accepted');
  },

  // ─── Queue: accepted leads awaiting a message ─────────────────────────────

  renderQueue() {
    const container = document.getElementById('outreach-queue-list');
    if (!container) return;

    const leads = this.acceptedLeads();

    if (leads.length === 0) {
      container.innerHTML = `<div class="empty-state">
        No accepted leads yet. Go to the Lead Intelligence Feed and accept the ones worth contacting —
        they appear here ready for a first message.
      </div>`;
      return;
    }

    // Which leads already have something drafted or sent, so the queue can say
    // so rather than inviting the user to draft a second copy.
    const byLead = {};
    for (const m of this.messages) {
      if (!m.lead_id) continue;
      if (!byLead[m.lead_id] || m.status === 'sent') byLead[m.lead_id] = m;
    }

    container.innerHTML = '';
    for (const lead of leads) {
      const existing = byLead[lead.id];
      const tier = lead.tier || 'cold';

      const row = document.createElement('div');
      row.className = 'outreach-row';
      row.innerHTML = `
        <div class="outreach-row__score score-badge-ring score-badge-ring--${tier}">${lead.total_score ?? '—'}</div>
        <div class="outreach-row__main">
          <strong class="outreach-row__title"></strong>
          <span class="outreach-row__sub"></span>
          <span class="outreach-row__meta"></span>
        </div>
        <div class="outreach-row__actions">
          ${existing && existing.status === 'sent'
            ? `<span class="review-badge review-badge--accepted">✓ Sent</span>`
            : ''}
          <button class="btn btn--primary" data-compose-lead="${this.escape(lead.id)}">
            ${existing ? 'Open draft' : 'Generate message'}
          </button>
        </div>`;

      // Scraped values are set as text, never HTML.
      row.querySelector('.outreach-row__title').textContent = lead.company_name || 'Unknown company';
      row.querySelector('.outreach-row__sub').textContent =
        [lead.contact_name, lead.contact_title].filter(Boolean).join(' · ') || 'No contact captured';
      row.querySelector('.outreach-row__meta').textContent =
        lead.contact_email || 'no email yet — add one on the lead to send';

      container.appendChild(row);
    }

    Review.bindDelegatedActions(container);
  },

  // ─── Messages: drafts, scheduled, sent ────────────────────────────────────

  async refreshMessages(status = null) {
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (status) params.set('status', status);
      if (window.ACTIVE_ICP?.id) params.set('icpId', window.ACTIVE_ICP.id);

      const res = await fetch(`${this.API_BASE}/api/outreach/messages?${params}`);
      if (!res.ok) throw new Error(`server responded ${res.status}`);

      const data = await res.json();
      this.messages = Array.isArray(data.messages) ? data.messages : [];
    } catch (err) {
      this.messages = [];
      console.warn('Could not load messages:', err.message);
    }

    if (this.activeSub === 'drafts') this.renderMessageList('outreach-drafts-list', true);
    if (this.activeSub === 'sent') this.renderMessageList('outreach-sent-list', false);
  },

  renderMessageList(containerId, selectable) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (this.messages.length === 0) {
      container.innerHTML = `<div class="empty-state">${
        selectable
          ? 'No drafts yet. Generate a message from an accepted lead to get started.'
          : 'Nothing sent yet. Sent messages appear here with the time they went out.'
      }</div>`;
      return;
    }

    container.innerHTML = '';
    for (const message of this.messages) {
      const row = document.createElement('div');
      row.className = `outreach-row outreach-row--${message.status}`;

      const when = message.sent_at || message.scheduled_at || message.created_at;
      const statusLabel = {
        draft: 'Draft', scheduled: 'Scheduled', sent: 'Sent',
        failed: 'Failed', cancelled: 'Cancelled', sending: 'Sending…',
      }[message.status] || message.status;

      row.innerHTML = `
        ${selectable && message.status === 'draft'
          ? `<input type="checkbox" class="draft-select" data-message-id="${this.escape(message.id)}">`
          : '<span class="outreach-row__spacer"></span>'}
        <div class="outreach-row__main">
          <strong class="outreach-row__title"></strong>
          <span class="outreach-row__sub"></span>
          <span class="outreach-row__meta"></span>
        </div>
        <div class="outreach-row__actions">
          <span class="msg-status msg-status--${message.status}">${statusLabel}</span>
          ${message.status !== 'sent'
            ? `<button class="btn btn--secondary" data-open-message="${this.escape(message.id)}">Edit</button>`
            : `<button class="btn btn--secondary" data-view-message="${this.escape(message.id)}">View</button>`}
        </div>`;

      row.querySelector('.outreach-row__title').textContent =
        message.subject || '(no subject)';
      row.querySelector('.outreach-row__sub').textContent =
        `${message.company_name || 'Unknown company'} · ${message.to_email || 'no recipient'}`;
      row.querySelector('.outreach-row__meta').textContent = [
        message.status === 'sent' ? `Sent ${App.formatRelativeTime(when)}` : null,
        message.status === 'scheduled' ? `Scheduled for ${new Date(when).toLocaleString()}` : null,
        message.generated_by ? `written by ${message.generated_by}` : null,
        message.error_message || null,
      ].filter(Boolean).join(' · ');

      container.appendChild(row);
    }

    this.bindMessageList(container);
  },

  bindMessageList(container) {
    if (container.dataset.msgBound === 'true') return;
    container.dataset.msgBound = 'true';

    container.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open-message], [data-view-message]');
      if (!open) return;
      const id = open.dataset.openMessage || open.dataset.viewMessage;
      const message = this.messages.find(m => m.id === id);
      if (message) this.openComposerForMessage(message);
    });

    container.addEventListener('change', (e) => {
      const box = e.target.closest('.draft-select');
      if (!box) return;
      if (box.checked) this.selectedDrafts.add(box.dataset.messageId);
      else this.selectedDrafts.delete(box.dataset.messageId);

      const hint = document.getElementById('drafts-hint');
      if (hint) hint.textContent = this.selectedDrafts.size
        ? `${this.selectedDrafts.size} draft${this.selectedDrafts.size === 1 ? '' : 's'} selected`
        : '';
    });
  },

  async sendSelectedDrafts() {
    const ids = [...this.selectedDrafts];
    if (ids.length === 0) {
      alert('Tick the drafts you want to send first.');
      return;
    }
    if (!confirm(`Send ${ids.length} message${ids.length === 1 ? '' : 's'} now? This cannot be undone.`)) return;

    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/messages/send-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      this.selectedDrafts.clear();
      await this.refreshMessages('draft,scheduled,failed');

      const failures = (data.results || []).filter(r => !r.ok);
      let summary = `${data.sent} sent${data.dryRun ? ' (dry run — nothing actually delivered)' : ''}.`;
      if (failures.length > 0) {
        summary += `\n\n${failures.length} did not go out:\n` +
          failures.slice(0, 8).map(f => `· ${f.reason}`).join('\n');
      }
      alert(summary);
    } catch (err) {
      alert(`Bulk send failed: ${err.message}`);
    }
  },

  // ─── Composer ─────────────────────────────────────────────────────────────

  bindComposer() {
    const overlay = document.getElementById('composer-overlay');
    const close = () => overlay?.classList.add('hidden');

    document.getElementById('composer-close')?.addEventListener('click', close);
    overlay?.addEventListener('click', (e) => {
      if (e.target.id === 'composer-overlay') close();
    });

    document.getElementById('btn-composer-generate')?.addEventListener('click', () => this.generate());
    document.getElementById('btn-composer-gemini')?.addEventListener('click', () => this.openGeminiHandoff());
    document.getElementById('btn-composer-send')?.addEventListener('click', () => this.send());
    document.getElementById('btn-composer-schedule')?.addEventListener('click', () => this.schedule());
    document.getElementById('btn-composer-save-template')?.addEventListener('click', () => this.saveAsTemplate());

    document.getElementById('composer-template')?.addEventListener('change', (e) => {
      if (e.target.value) this.applyTemplate(e.target.value);
    });

    // Cold emails live or die on length, so show the count while typing.
    document.getElementById('composer-body')?.addEventListener('input', () => this.updateWordCount());
  },

  updateWordCount() {
    const body = document.getElementById('composer-body')?.value || '';
    const words = body.trim() ? body.trim().split(/\s+/).length : 0;
    const el = document.getElementById('composer-wordcount');
    if (!el) return;

    el.textContent = `${words} words`;
    el.className = words > 160 ? 'form-hint form-hint--warn' : 'form-hint';
    if (words > 160) el.textContent += ' — long for a first touch; under 120 reads better.';
  },

  /** Open the composer for a lead, loading any existing draft. */
  async openComposer(leadId) {
    this.composerLeadId = leadId;
    this.composerMessage = null;

    const lead = (window.App?.allLeads || []).find(l => l.id === leadId);

    // The composer is often opened from the lead drawer; leaving that open
    // behind it stacks two overlays and traps the page scroll.
    window.Modal?.closeDrawer();

    document.getElementById('composer-overlay')?.classList.remove('hidden');
    this.renderComposerMeta(lead);
    this.setNotice('');

    // Reuse the lead's existing draft rather than starting a blank one, so
    // reopening the composer does not silently discard earlier edits.
    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/messages?leadId=${encodeURIComponent(leadId)}&limit=10`);
      const data = await res.json().catch(() => ({}));
      const list = data.messages || [];
      const draft = list.find(m => m.status === 'draft') ||
                    list.find(m => ['scheduled', 'failed'].includes(m.status));
      if (draft) {
        this.fillComposer(draft);
        return;
      }
    } catch (err) { /* no draft yet — start empty */ }

    this.fillComposer({
      to_email: lead?.contact_email || '',
      to_name: lead?.contact_name || '',
      subject: '',
      body: '',
      status: 'draft',
    });
  },

  openComposerForMessage(message) {
    this.composerLeadId = message.lead_id;
    this.composerMessage = message;

    const lead = (window.App?.allLeads || []).find(l => l.id === message.lead_id);
    document.getElementById('composer-overlay')?.classList.remove('hidden');
    this.renderComposerMeta(lead, message);
    this.fillComposer(message);

    if (message.status === 'sent') {
      this.setNotice('This message was already sent. It is shown read-only — the log records what was actually delivered.', 'info');
    } else {
      this.setNotice('');
    }
  },

  fillComposer(message) {
    this.composerMessage = message.id ? message : null;

    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value || '';
    };
    set('composer-to', message.to_email);
    set('composer-subject', message.subject);
    set('composer-body', message.body);

    const readOnly = message.status === 'sent';
    ['composer-to', 'composer-subject', 'composer-body'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.readOnly = readOnly;
    });
    ['btn-composer-send', 'btn-composer-schedule', 'btn-composer-generate', 'btn-composer-gemini']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = readOnly;
      });

    this.updateWordCount();
    this.renderAltLinks(message);
  },

  renderComposerMeta(lead, message = null) {
    const el = document.getElementById('composer-meta');
    const title = document.getElementById('composer-title');
    if (!el) return;

    if (title) {
      title.textContent = lead?.company_name
        ? `Message to ${lead.company_name}`
        : 'Draft message';
    }

    el.innerHTML = '';
    const parts = [
      lead?.contact_name && lead?.contact_title ? `${lead.contact_name} · ${lead.contact_title}` : lead?.contact_name,
      lead?.company_industry,
      lead?.company_location,
      lead?.total_score != null ? `Score ${lead.total_score} (${lead.tier || 'unscored'})` : null,
      message?.generated_by ? `draft written by ${message.generated_by}` : null,
    ].filter(Boolean);

    for (const part of parts) {
      const span = document.createElement('span');
      span.className = 'composer-meta__item';
      span.textContent = part;
      el.appendChild(span);
    }
  },

  /**
   * Compose links for sending from the user's own mailbox.
   *
   * Always offered, not only as a fallback: for a first touch, an email that
   * genuinely comes from the rep's own address often lands better than one from
   * a relay, and it needs no SMTP configuration at all.
   */
  renderAltLinks(message) {
    const el = document.getElementById('composer-alt-links');
    if (!el) return;

    const to = document.getElementById('composer-to')?.value || '';
    if (!to) {
      el.innerHTML = '<span class="outreach-hint">Add an email address above to enable sending.</span>';
      return;
    }

    const subject = encodeURIComponent(document.getElementById('composer-subject')?.value || '');
    const body = encodeURIComponent(document.getElementById('composer-body')?.value || '');
    const target = encodeURIComponent(to);

    el.innerHTML = `
      <span class="outreach-hint">Or send it yourself:</span>
      <a class="composer-alt__link" target="_blank" rel="noopener"
         href="https://mail.google.com/mail/?view=cm&fs=1&to=${target}&su=${subject}&body=${body}">Gmail</a>
      <a class="composer-alt__link" href="mailto:${target}?subject=${subject}&body=${body}">Mail app</a>`;
  },

  setNotice(text, tone = 'warn') {
    const el = document.getElementById('composer-notice');
    if (!el) return;
    el.textContent = text || '';
    el.className = text ? `composer-notice composer-notice--${tone}` : 'composer-notice';
  },

  // ─── Generation ───────────────────────────────────────────────────────────

  async generate() {
    if (!this.composerLeadId) return;

    const btn = document.getElementById('btn-composer-generate');
    const label = document.getElementById('composer-generate-label');
    const previous = label?.textContent;

    if (btn) btn.disabled = true;
    if (label) label.textContent = 'Writing…';
    this.setNotice('');

    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/generate/${encodeURIComponent(this.composerLeadId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'generate' }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      this.fillComposer(data.message);
      this.composerMessage = data.message;

      if (data.warning) this.setNotice(data.warning, 'warn');
      else if (data.signal?.origin === 'none') {
        this.setNotice('No trigger signal was captured for this lead, so the draft is general rather than specific. Worth adding a personal line before sending.', 'info');
      } else if (data.signal?.summary) {
        this.setNotice(`Personalised around: "${data.signal.summary}"`, 'info');
      }
    } catch (err) {
      this.setNotice(`Could not generate a draft: ${err.message}`, 'bad');
    } finally {
      if (btn) btn.disabled = false;
      if (label) label.textContent = previous || 'Generate with AI';
    }
  },

  // ─── Gemini handoff ───────────────────────────────────────────────────────

  bindGeminiModal() {
    const overlay = document.getElementById('gemini-overlay');
    const close = () => overlay?.classList.add('hidden');

    document.getElementById('gemini-close')?.addEventListener('click', close);
    overlay?.addEventListener('click', (e) => {
      if (e.target.id === 'gemini-overlay') close();
    });

    document.getElementById('btn-gemini-open')?.addEventListener('click', () => {
      this.copyPrompt();
      window.open(this.geminiUrl || 'https://gemini.google.com/app', '_blank', 'noopener');
    });
    document.getElementById('btn-gemini-copy')?.addEventListener('click', () => this.copyPrompt());
    document.getElementById('btn-gemini-apply')?.addEventListener('click', () => this.applyGeminiPaste());
  },

  async openGeminiHandoff() {
    if (!this.composerLeadId) return;

    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/generate/${encodeURIComponent(this.composerLeadId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'handoff' }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      this.geminiPrompt = data.prompt;
      this.geminiUrl = data.geminiUrl;

      const preview = document.getElementById('gemini-prompt-preview');
      if (preview) preview.textContent = data.prompt;

      const paste = document.getElementById('gemini-paste');
      if (paste) paste.value = '';

      document.getElementById('gemini-overlay')?.classList.remove('hidden');
      this.copyPrompt();
    } catch (err) {
      alert(`Could not build the Gemini prompt: ${err.message}`);
    }
  },

  /**
   * Copy the prompt to the clipboard.
   *
   * Three attempts, because this is the step the whole keyless Gemini flow
   * hangs on and each method fails in a different situation:
   *
   *   1. navigator.clipboard — the modern API, but it needs a secure context
   *      (a plain-http deployment is not one) and can still be refused by
   *      permission policy.
   *   2. execCommand('copy') — deprecated, but it works over plain http and
   *      without a permission grant.
   *   3. Select the text and say so, so the user can press Ctrl+C themselves
   *      rather than hitting a dead end.
   */
  async copyPrompt() {
    if (!this.geminiPrompt) return;

    // Step 1 of the instructions states what just happened, so it has to be set
    // from the actual outcome — telling the user the prompt is on their
    // clipboard when the copy was refused sends them to Gemini to paste nothing.
    const setStep = (html) => {
      const el = document.getElementById('gemini-step-copy');
      if (el) el.innerHTML = html;
    };

    try {
      await navigator.clipboard.writeText(this.geminiPrompt);
      setStep('<strong>The prompt is on your clipboard.</strong> Gemini opens in a new tab, signed in as you.');
      App.toast('Prompt copied — paste it into Gemini.');
      return;
    } catch (err) { /* fall through */ }

    // The textarea must be in the document and focusable for execCommand to
    // read from it, but it should never be visible.
    const scratch = document.createElement('textarea');
    scratch.value = this.geminiPrompt;
    scratch.setAttribute('readonly', '');
    scratch.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
    document.body.appendChild(scratch);

    let copied = false;
    try {
      scratch.select();
      scratch.setSelectionRange(0, this.geminiPrompt.length);
      copied = document.execCommand('copy');
    } catch (err) {
      copied = false;
    } finally {
      document.body.removeChild(scratch);
    }

    if (copied) {
      setStep('<strong>The prompt is on your clipboard.</strong> Gemini opens in a new tab, signed in as you.');
      App.toast('Prompt copied — paste it into Gemini.');
      return;
    }

    setStep('<strong>Your browser blocked the clipboard.</strong> The prompt is selected below — press Ctrl+C / ⌘C to copy it, then open Gemini.');

    const preview = document.getElementById('gemini-prompt-preview');
    const details = preview?.closest('details');
    if (details) details.open = true;
    if (preview) {
      const range = document.createRange();
      range.selectNodeContents(preview);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      preview.scrollIntoView({ block: 'nearest' });
    }
    App.toast('Could not reach the clipboard — the prompt is selected below, press Ctrl+C.');
  },

  /** Take what Gemini wrote and make it the draft. */
  async applyGeminiPaste() {
    const pasted = document.getElementById('gemini-paste')?.value.trim();
    if (!pasted) {
      alert('Paste Gemini\'s answer into the box first.');
      return;
    }

    // A message row has to exist before it can be updated. If the user went
    // straight to Gemini without generating, create an empty draft to hold it.
    if (!this.composerMessage?.id) {
      const created = await this.ensureDraft();
      if (!created) return;
    }

    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/messages/${encodeURIComponent(this.composerMessage.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pastedText: pasted }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      this.fillComposer(data.message);
      this.composerMessage = data.message;
      document.getElementById('gemini-overlay')?.classList.add('hidden');
      this.setNotice('Draft taken from Gemini. Read it once more before sending.', 'info');
    } catch (err) {
      alert(`Could not apply that: ${err.message}`);
    }
  },

  /** Create an empty draft row for this lead so edits have something to save to. */
  async ensureDraft() {
    const lead = (window.App?.allLeads || []).find(l => l.id === this.composerLeadId);

    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/generate/${encodeURIComponent(this.composerLeadId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'generate', provider: 'template' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      this.composerMessage = data.message;
      return true;
    } catch (err) {
      alert(`Could not create a draft for ${lead?.company_name || 'this lead'}: ${err.message}`);
      return false;
    }
  },

  // ─── Saving, sending, scheduling ──────────────────────────────────────────

  /** Persist what is in the editor. Every send path goes through this first. */
  async saveComposer() {
    if (!this.composerMessage?.id) {
      const created = await this.ensureDraft();
      if (!created) return null;
    }

    const payload = {
      to_email: document.getElementById('composer-to')?.value.trim() || '',
      subject: document.getElementById('composer-subject')?.value.trim() || '',
      body: document.getElementById('composer-body')?.value || '',
    };

    const res = await fetch(`${this.API_BASE}/api/outreach/messages/${encodeURIComponent(this.composerMessage.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

    this.composerMessage = data.message;
    return data.message;
  },

  async send() {
    const body = document.getElementById('composer-body')?.value.trim();
    if (!body) {
      alert('The message is empty. Generate a draft or write one first.');
      return;
    }

    const to = document.getElementById('composer-to')?.value.trim();
    if (!to) {
      alert('Add a recipient email address first.');
      return;
    }

    const dryRun = this.status?.smtp?.dryRun;
    const question = dryRun
      ? `Dry run is on, so nothing will actually be delivered to ${to}. Record it as sent?`
      : `Send this message to ${to} now? This cannot be undone.`;
    if (!confirm(question)) return;

    try {
      await this.saveComposer();

      const res = await fetch(`${this.API_BASE}/api/outreach/messages/${encodeURIComponent(this.composerMessage.id)}/send`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      document.getElementById('composer-overlay')?.classList.add('hidden');
      App.toast(data.dryRun ? 'Recorded as sent (dry run — nothing delivered).' : `Sent to ${to}.`);

      await this.refreshMessages(this.activeSub === 'sent' ? 'sent,cancelled' : 'draft,scheduled,failed');
      this.renderQueue();
    } catch (err) {
      this.setNotice(`Could not send: ${err.message}`, 'bad');
    }
  },

  async schedule() {
    const when = document.getElementById('composer-when')?.value;
    if (!when) {
      alert('Pick a date and time first.');
      return;
    }

    const at = new Date(when);
    if (Number.isNaN(at.getTime())) {
      alert('That date and time could not be read.');
      return;
    }

    try {
      await this.saveComposer();

      const res = await fetch(`${this.API_BASE}/api/outreach/messages/${encodeURIComponent(this.composerMessage.id)}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Sent as UTC so the server stores an unambiguous instant; the input is
        // in the user's local timezone.
        body: JSON.stringify({ scheduledAt: at.toISOString() }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      document.getElementById('composer-overlay')?.classList.add('hidden');
      App.toast(`Scheduled for ${at.toLocaleString()}.`);
      await this.refreshMessages('draft,scheduled,failed');
    } catch (err) {
      this.setNotice(`Could not schedule: ${err.message}`, 'bad');
    }
  },

  // ─── Templates ────────────────────────────────────────────────────────────

  async refreshTemplates() {
    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/templates`);
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      const data = await res.json();
      this.templates = data.templates || [];
      this.placeholders = data.placeholders || [];
    } catch (err) {
      this.templates = [];
      console.warn('Could not load templates:', err.message);
    }

    this.renderTemplateSelect();
    if (this.activeSub === 'templates') this.renderTemplates();
  },

  renderTemplateSelect() {
    const select = document.getElementById('composer-template');
    if (!select) return;

    select.innerHTML = '<option value="">Apply a template…</option>';
    for (const template of this.templates) {
      const option = document.createElement('option');
      option.value = template.id;
      option.textContent = template.name;
      select.appendChild(option);
    }
  },

  renderTemplates() {
    const container = document.getElementById('outreach-templates-list');
    const help = document.getElementById('template-placeholder-help');
    if (help && this.placeholders) {
      help.textContent = this.placeholders.map(p => `{{${p}}}`).join(' ');
    }
    if (!container) return;

    if (this.templates.length === 0) {
      container.innerHTML = `<div class="empty-state">
        No templates yet. Open any draft you are happy with and press "Save as template" —
        the lead's details are swapped for placeholders so it re-personalises for the next prospect.
      </div>`;
      return;
    }

    container.innerHTML = '';
    for (const template of this.templates) {
      const row = document.createElement('div');
      row.className = 'outreach-row';
      row.innerHTML = `
        <div class="outreach-row__main">
          <strong class="outreach-row__title"></strong>
          <span class="outreach-row__sub"></span>
          <span class="outreach-row__meta"></span>
        </div>
        <div class="outreach-row__actions">
          <button class="btn btn--secondary" data-delete-template="${this.escape(template.id)}">Delete</button>
        </div>`;

      row.querySelector('.outreach-row__title').textContent = template.name;
      row.querySelector('.outreach-row__sub').textContent = template.subject || '(no subject)';
      row.querySelector('.outreach-row__meta').textContent =
        `${String(template.body || '').slice(0, 120)}… · used ${template.times_used || 0}×`;

      container.appendChild(row);
    }

    if (container.dataset.tplBound !== 'true') {
      container.dataset.tplBound = 'true';
      container.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-delete-template]');
        if (!btn) return;
        if (!confirm('Delete this template?')) return;

        await fetch(`${this.API_BASE}/api/outreach/templates/${encodeURIComponent(btn.dataset.deleteTemplate)}`,
          { method: 'DELETE' });
        this.refreshTemplates();
      });
    }
  },

  async applyTemplate(templateId) {
    if (!this.composerLeadId) return;

    try {
      const res = await fetch(
        `${this.API_BASE}/api/outreach/templates/${encodeURIComponent(templateId)}/apply/${encodeURIComponent(this.composerLeadId)}`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      this.fillComposer(data.message);
      this.composerMessage = data.message;
      this.setNotice('Template applied and personalised for this lead.', 'info');
    } catch (err) {
      this.setNotice(`Could not apply that template: ${err.message}`, 'bad');
    } finally {
      const select = document.getElementById('composer-template');
      if (select) select.value = '';
    }
  },

  /**
   * Save the current draft as a template.
   *
   * The lead's own details are swapped back out for placeholders before saving,
   * so applying it to the next prospect re-personalises rather than mailing
   * them the previous person's name.
   */
  async saveAsTemplate() {
    const subject = document.getElementById('composer-subject')?.value || '';
    const body = document.getElementById('composer-body')?.value || '';

    if (!body.trim()) {
      alert('There is nothing to save yet.');
      return;
    }

    const name = prompt('Name this template:', subject.slice(0, 60) || 'First-touch email');
    if (!name) return;

    const lead = (window.App?.allLeads || []).find(l => l.id === this.composerLeadId);
    const placeholderise = text => {
      if (!lead) return text;
      let out = text;
      const swaps = [
        [lead.contact_name, '{{contact_name}}'],
        [String(lead.contact_name || '').trim().split(/\s+/)[0], '{{contact_first_name}}'],
        [lead.company_name, '{{company_name}}'],
        [lead.contact_title, '{{contact_title}}'],
        [lead.company_industry, '{{company_industry}}'],
      ];
      for (const [value, token] of swaps) {
        if (!value || String(value).length < 2) continue;
        // Escape the value: company names legitimately contain regex
        // metacharacters ("Fintech®", "C++ Ltd"), and an unescaped one would
        // either throw or match the wrong thing.
        const safe = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(safe, 'g'), token);
      }
      return out;
    };

    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          subject: placeholderise(subject),
          body: placeholderise(body),
          fromMessageId: this.composerMessage?.id || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      await this.refreshTemplates();
      App.toast(`Saved "${name}" as a template.`);
    } catch (err) {
      alert(`Could not save that template: ${err.message}`);
    }
  },

  // ─── Opt-outs ─────────────────────────────────────────────────────────────

  bindOptOut() {
    document.getElementById('btn-scan-reply')?.addEventListener('click', () => this.scanReply());
    document.getElementById('btn-add-suppression')?.addEventListener('click', () => this.addSuppression());
  },

  async scanReply() {
    const text = document.getElementById('reply-scan-text')?.value.trim();
    const result = document.getElementById('reply-scan-result');
    if (!text) {
      alert('Paste a reply to scan.');
      return;
    }

    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/replies/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyText: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      if (!result) return;

      if (data.suppressed) {
        result.className = 'scan-result scan-result--acted';
        result.textContent =
          `Opt-out detected (${data.matchedPhrases.join(', ')}). ${data.email} is now blocked` +
          `${data.cancelledMessages ? ` and ${data.cancelledMessages} queued message(s) were cancelled` : ''}.`;
      } else if (data.needsReview) {
        result.className = 'scan-result scan-result--review';
        result.textContent =
          `Possibly negative ("${data.matchedPhrases.join(', ')}"), but not a clear opt-out — ` +
          'nothing was blocked. Block them manually on the right if you read it that way.';
      } else if (data.error) {
        result.className = 'scan-result scan-result--review';
        result.textContent = data.error;
      } else {
        result.className = 'scan-result scan-result--clear';
        result.textContent = 'No opt-out language found. Nothing was changed.';
      }

      this.refreshSuppressions();
    } catch (err) {
      if (result) {
        result.className = 'scan-result scan-result--bad';
        result.textContent = `Scan failed: ${err.message}`;
      }
    }
  },

  async addSuppression() {
    const input = document.getElementById('suppress-email');
    const value = input?.value.trim();
    if (!value) return;

    // A bare domain blocks everyone there; an address blocks one person.
    const payload = value.includes('@')
      ? { email: value, reason: 'Blocked manually' }
      : { domain: value.replace(/^@/, ''), reason: 'Domain blocked manually' };

    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/suppressions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);

      if (input) input.value = '';
      this.refreshSuppressions();
    } catch (err) {
      alert(`Could not add that: ${err.message}`);
    }
  },

  async refreshSuppressions() {
    const container = document.getElementById('suppression-list');
    if (!container) return;

    let list = [];
    try {
      const res = await fetch(`${this.API_BASE}/api/outreach/suppressions`);
      const data = await res.json();
      list = data.suppressions || [];
    } catch (err) {
      container.innerHTML = '<div class="empty-state">Could not load the list.</div>';
      return;
    }

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Nobody blocked yet.</div>';
      return;
    }

    container.innerHTML = '';
    for (const entry of list) {
      const row = document.createElement('div');
      row.className = 'suppress-row';
      row.innerHTML = `
        <div class="suppress-row__main">
          <strong></strong><span></span>
        </div>
        <button class="btn btn--secondary" data-unsuppress="${this.escape(entry.id)}">Unblock</button>`;

      row.querySelector('strong').textContent = entry.email || `@${entry.domain}`;
      row.querySelector('span').textContent = `${entry.reason || entry.source} · ${App.formatRelativeTime(entry.created_at)}`;
      container.appendChild(row);
    }

    if (container.dataset.supBound !== 'true') {
      container.dataset.supBound = 'true';
      container.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-unsuppress]');
        if (!btn) return;
        await fetch(`${this.API_BASE}/api/outreach/suppressions/${encodeURIComponent(btn.dataset.unsuppress)}`,
          { method: 'DELETE' });
        this.refreshSuppressions();
      });
    }
  },

  escape(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

window.Outreach = Outreach;
