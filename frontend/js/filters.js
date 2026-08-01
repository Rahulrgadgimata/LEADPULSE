/**
 * LeadPulse AI — Sidebar Filters Module
 * Manages filter chips, active states, and real-time filtering
 */

const Filters = {
  activeFilters: {
    industry: [],
    tier: [],
    source: [],
    size: [],
    geo: [],
  },

  /**
   * Initialize all filter groups from the data
   */
  init(leads) {
    this.buildIndustryFilters(leads);
    this.buildTierFilters(leads);
    this.buildSourceFilters(leads);
    this.buildSizeFilters(leads);
    this.buildGeoFilters(leads);
    this.bindClearAll();
  },

  /**
   * Build industry filter chips
   */
  buildIndustryFilters(leads) {
    const industries = [...new Set(leads.map(l => l.company_industry).filter(Boolean))].sort();
    const container = document.getElementById('filter-industries') || document.getElementById('industry-filters');
    if (!container) return;
    container.innerHTML = '';

    industries.forEach(industry => {
      const chip = this.createChip(industry, 'industry');
      container.appendChild(chip);
    });
  },

  /**
   * Build tier filter chips with color coding
   */
  buildTierFilters(leads) {
    const container = document.getElementById('filter-tiers') || document.getElementById('tier-filters');
    if (!container) return;
    container.innerHTML = '';

    const tiers = [
      { value: 'hot', label: '🔥 Hot', cssClass: 'chip--hot' },
      { value: 'warm', label: '🌤️ Warm', cssClass: 'chip--warm' },
      { value: 'cold', label: '❄️ Cold', cssClass: 'chip--cold' },
    ];

    tiers.forEach(t => {
      const count = leads.filter(l => l.tier === t.value).length;
      const chip = this.createChip(`${t.label} (${count})`, 'tier', t.value, t.cssClass);
      container.appendChild(chip);
    });
  },

  /**
   * Build source filter chips
   */
  buildSourceFilters(leads) {
    const sourceLabels = {
      web_scrape: 'Web',
      linkedin: 'LinkedIn',
      news: 'News',
      job_board: 'Jobs',
      social: 'Social',
      enrichment: 'Enrichment',
    };
    const container = document.getElementById('filter-sources') || document.getElementById('source-filters');
    if (!container) return;
    container.innerHTML = '';

    Object.entries(sourceLabels).forEach(([key, label]) => {
      const count = leads.filter(l => l.source === key).length;
      if (count > 0) {
        const chip = this.createChip(`${label} (${count})`, 'source', key);
        container.appendChild(chip);
      }
    });
  },

  /**
   * Build company size filter chips
   */
  buildSizeFilters(leads) {
    const container = document.getElementById('filter-sizes') || document.getElementById('size-filters');
    if (!container) return;
    container.innerHTML = '';

    const sizeRanges = [
      { label: '1–50', min: 1, max: 50 },
      { label: '51–200', min: 51, max: 200 },
      { label: '201–500', min: 201, max: 500 },
      { label: '500+', min: 501, max: Infinity },
    ];

    sizeRanges.forEach(range => {
      const count = leads.filter(l => l.company_size >= range.min && l.company_size <= range.max).length;
      if (count > 0) {
        const chip = this.createChip(`${range.label} (${count})`, 'size', `${range.min}-${range.max}`);
        container.appendChild(chip);
      }
    });
  },

  /**
   * Build geography filter chips
   */
  buildGeoFilters(leads) {
    const container = document.getElementById('filter-geos') || document.getElementById('geo-filters');
    if (!container) return;
    container.innerHTML = '';

    // Extract unique regions/countries
    const locations = leads.map(l => {
      const parts = (l.company_location || '').split(',').map(p => p.trim());
      return parts[parts.length - 1] || 'Unknown';
    });
    const uniqueLocations = [...new Set(locations.filter(Boolean))].sort();

    uniqueLocations.forEach(loc => {
      if (loc && loc !== 'Unknown') {
        const chip = this.createChip(loc, 'geo');
        container.appendChild(chip);
      }
    });
  },

  /**
   * Create a filter chip element
   */
  createChip(label, group, value = null, extraClass = '') {
    const chip = document.createElement('button');
    chip.className = `chip ${extraClass}`.trim();
    chip.textContent = label;
    chip.dataset.group = group;
    chip.dataset.value = value || label;

    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      this.updateActiveFilters();
      // Trigger re-render
      if (window.App) window.App.applyFilters();
    });

    return chip;
  },

  /**
   * Read all active chips and update the activeFilters object
   */
  updateActiveFilters() {
    const groups = ['industry', 'tier', 'source', 'size', 'geo'];
    groups.forEach(group => {
      const activeChips = document.querySelectorAll(`.chip[data-group="${group}"].active`);
      this.activeFilters[group] = Array.from(activeChips).map(c => c.dataset.value);
    });
  },

  /**
   * Apply filters to a list of leads
   */
  applyTo(leads) {
    return leads.filter(lead => {
      // Industry filter
      if (this.activeFilters.industry.length > 0) {
        if (!this.activeFilters.industry.includes(lead.company_industry)) return false;
      }

      // Tier filter
      if (this.activeFilters.tier.length > 0) {
        if (!this.activeFilters.tier.includes(lead.tier)) return false;
      }

      // Source filter
      if (this.activeFilters.source.length > 0) {
        if (!this.activeFilters.source.includes(lead.source)) return false;
      }

      // Size filter
      if (this.activeFilters.size.length > 0) {
        const sizeMatch = this.activeFilters.size.some(range => {
          const [min, max] = range.split('-').map(Number);
          return lead.company_size >= min && lead.company_size <= (max || Infinity);
        });
        if (!sizeMatch) return false;
      }

      // Geography filter
      if (this.activeFilters.geo.length > 0) {
        const location = lead.company_location || '';
        const geoMatch = this.activeFilters.geo.some(geo => location.includes(geo));
        if (!geoMatch) return false;
      }

      return true;
    });
  },

  /**
   * Clear all active filters
   */
  clearAll() {
    document.querySelectorAll('.chip.active').forEach(chip => {
      chip.classList.remove('active');
    });
    this.activeFilters = { industry: [], tier: [], source: [], size: [], geo: [] };
    if (window.App) window.App.applyFilters();
  },

  /**
   * Bind clear all button
   */
  bindClearAll() {
    const btn = document.getElementById('btn-clear-filters');
    if (btn) {
      btn.addEventListener('click', () => this.clearAll());
    }
  },

  /**
   * Check if any filters are active
   */
  hasActiveFilters() {
    return Object.values(this.activeFilters).some(arr => arr.length > 0);
  }
};

window.Filters = Filters;

