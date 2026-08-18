/**
 * LeadPulse AI — spreadsheet import.
 *
 * Upload a list of companies you already have and let the enrichment pipeline
 * fill in what it is missing: email, phone, LinkedIn and a named decision
 * maker. The rows land under their own ICP, so they filter and score like any
 * other leads and a later discovery run can extend the same list.
 */

const Import = {
  API_BASE: (window.LEADPULSE_API_BASE || '').replace(/\/$/, ''),

  init() {
    document.getElementById('btn-upload-sheet')?.addEventListener('click', () => this.open());
    document.getElementById('import-modal-close')?.addEventListener('click', () => this.close());
    document.getElementById('btn-cancel-import')?.addEventListener('click', () => this.close());
    document.getElementById('import-modal-overlay')?.addEventListener('click', e => {
      if (e.target.id === 'import-modal-overlay') this.close();
    });
    document.getElementById('btn-start-import')?.addEventListener('click', () => this.start());

    // The ICP name only applies when a new ICP is being created.
    document.querySelectorAll('input[name="import-target"]').forEach(radio => {
      radio.addEventListener('change', () => this.syncTargetChoice());
    });

    // Default the ICP name to the file name, which is what most people would
    // type anyway.
    document.getElementById('import-file')?.addEventListener('change', e => {
      const nameField = document.getElementById('import-icp-name');
      const file = e.target.files?.[0];
      if (file && nameField && !nameField.value.trim()) {
        nameField.value = file.name.replace(/\.(xlsx|xls|csv)$/i, '').slice(0, 60);
      }
      this.setStatus('');
    });
  },

  open() {
    document.getElementById('import-modal-overlay')?.classList.remove('hidden');
    this.setStatus('');
    this.syncTargetChoice();
  },

  close() {
    document.getElementById('import-modal-overlay')?.classList.add('hidden');
  },

  /** Adding to the current ICP needs one to exist and hides the name field. */
  syncTargetChoice() {
    const mode = document.querySelector('input[name="import-target"]:checked')?.value || 'new';
    const nameGroup = document.getElementById('import-name-group');
    if (nameGroup) nameGroup.style.display = mode === 'new' ? '' : 'none';

    const currentRadio = document.querySelector('input[name="import-target"][value="current"]');
    if (currentRadio && !window.ACTIVE_ICP?.id) {
      currentRadio.disabled = true;
      currentRadio.parentElement.style.opacity = '0.5';
      currentRadio.parentElement.title = 'No target ICP is selected yet.';
    }
  },

  setStatus(message, isError = false) {
    const el = document.getElementById('import-status');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--rose, #f43f5e)' : 'var(--text-tertiary)';
  },

  async start() {
    const fileInput = document.getElementById('import-file');
    const file = fileInput?.files?.[0];
    if (!file) {
      this.setStatus('Choose a spreadsheet first.', true);
      return;
    }

    const mode = document.querySelector('input[name="import-target"]:checked')?.value || 'new';
    const button = document.getElementById('btn-start-import');

    const form = new FormData();
    form.append('file', file);
    if (mode === 'current' && window.ACTIVE_ICP?.id) {
      form.append('icpId', window.ACTIVE_ICP.id);
    } else {
      const name = document.getElementById('import-icp-name')?.value.trim();
      if (name) form.append('icpName', name);
    }

    if (button) { button.disabled = true; button.textContent = 'Reading sheet...'; }
    this.setStatus('Uploading and reading the sheet...');

    let data;
    try {
      const res = await fetch(`${this.API_BASE}/api/import/leads`, { method: 'POST', body: form });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);
    } catch (err) {
      this.setStatus(err.message, true);
      if (button) { button.disabled = false; button.textContent = 'Find contact details'; }
      return;
    }

    if (button) { button.disabled = false; button.textContent = 'Find contact details'; }

    // Say which column became which field: a wrong guess is obvious here and
    // invisible once the leads are in the pipeline.
    const mapped = Object.entries(data.parsed?.columns || {})
      .map(([field, header]) => `${field.replace(/_/g, ' ')} ← "${header}"`)
      .join(', ');
    const truncated = data.parsed?.truncated
      ? ` (first ${data.parsed.rows} of ${data.parsed.totalRows} rows)`
      : '';

    this.setStatus(`Reading ${data.parsed?.rows} companies${truncated}. Columns: ${mapped}`);

    // Switch the dashboard to the ICP the rows landed in, so the leads appear
    // as they are enriched rather than in a profile the user has to go find.
    if (data.icp?.id && window.App) {
      window.App.setActiveICP({ id: data.icp.id, name: data.icp.name, is_active: 1 });
      await window.App.refreshLeadsFromBackend(data.icp.id);
    }

    setTimeout(() => this.close(), 1200);
    this.followJob(data.jobId, data.parsed?.rows || 0);
  },

  /**
   * Follow the import on the same toast discovery uses, so both kinds of run
   * report progress in one familiar place.
   */
  followJob(jobId, rowCount) {
    const toast = document.getElementById('discovery-toast');
    const statusText = document.getElementById('discovery-status-text');
    const bar = document.getElementById('discovery-bar');
    const title = toast?.querySelector('strong');

    if (!toast) return;
    toast.classList.remove('hidden');
    if (bar) bar.style.width = '5%';
    if (title) title.textContent = `Importing ${rowCount} companies...`;
    if (statusText) statusText.textContent = 'Looking up contact details for each row...';

    const poll = setInterval(async () => {
      let job;
      try {
        const res = await fetch(`${this.API_BASE}/api/discovery/status/${encodeURIComponent(jobId)}`);
        if (!res.ok) return;
        job = await res.json();
      } catch (err) {
        return; // Transient; keep polling.
      }

      const pct = Math.max(job.progress || 0, 0);
      if (bar) bar.style.width = `${pct}%`;
      if (title) title.textContent = `Importing ${rowCount} companies... (${pct}%)`;
      if (statusText && job.statusText) statusText.textContent = job.statusText;

      if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
        clearInterval(poll);
        if (title) {
          title.textContent = job.state === 'completed' ? 'Import finished' : 'Import stopped';
        }
        if (statusText) {
          statusText.textContent = job.statusText || job.failedReason || '';
        }

        await window.App?.refreshLeadsFromBackend();
        await window.App?.refreshRadarStream();

        setTimeout(() => {
          toast.classList.add('hidden');
          if (bar) bar.style.width = '0%';
          if (title) title.textContent = 'Running Multi-Source AI Pipeline...';
        }, 4000);
      }
    }, 2000);
  }
};

document.addEventListener('DOMContentLoaded', () => Import.init());
window.Import = Import;
