/**
 * LeadPulse AI — Analytics Charts Module
 * 5-Dimension Radar + Tier Funnel Donut + Score Distribution
 */

const Charts = {
  instances: {},

  renderAll(leads) {
    this.destroyAll();
    this.renderDimensionRadar(leads);
    this.renderTierDonut(leads);
    this.renderScoreBar(leads);
  },

  destroyAll() {
    Object.values(this.instances).forEach(chart => {
      if (chart) chart.destroy();
    });
    this.instances = {};
  },

  renderDimensionRadar(leads) {
    const ctx = document.getElementById('chart-radar-dimensions');
    if (!ctx || leads.length === 0) return;

    const avgIntent = Math.round(leads.reduce((s, l) => s + (l.intent_score || 0), 0) / leads.length);
    const avgProfile = Math.round(leads.reduce((s, l) => s + (l.profile_fit_score || 0), 0) / leads.length);
    const avgCompany = Math.round(leads.reduce((s, l) => s + (l.company_fit_score || 0), 0) / leads.length);
    const avgRecency = Math.round(leads.reduce((s, l) => s + (l.recency_score || 0), 0) / leads.length);
    const avgEngagement = Math.round(leads.reduce((s, l) => s + (l.engagement_score || 0), 0) / leads.length);

    this.instances.radar = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: ['Intent (30%)', 'Profile Fit (25%)', 'Company Fit (20%)', 'Recency (15%)', 'Engagement (10%)'],
        datasets: [{
          label: 'Current Pipeline Avg',
          data: [avgIntent, avgProfile, avgCompany, avgRecency, avgEngagement],
          borderColor: '#0d9488',
          backgroundColor: 'rgba(13, 148, 136, 0.2)',
          pointBackgroundColor: '#0d9488',
          pointBorderColor: '#ffffff',
          pointHoverRadius: 6,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: '#0f172a', titleColor: '#fff', bodyColor: '#cbd5e1' }
        },
        scales: {
          r: {
            angleLines: { color: 'rgba(15, 23, 42, 0.08)' },
            grid: { color: 'rgba(15, 23, 42, 0.08)' },
            pointLabels: { color: '#64748b', font: { family: 'Outfit', size: 11, weight: 600 } },
            ticks: { display: false, min: 0, max: 100 }
          }
        }
      }
    });
  },

  renderTierDonut(leads) {
    const ctx = document.getElementById('chart-tier-donut');
    if (!ctx) return;

    const hot = leads.filter(l => l.tier === 'hot').length;
    const warm = leads.filter(l => l.tier === 'warm').length;
    const cold = leads.filter(l => l.tier === 'cold').length;

    this.instances.donut = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Hot (70-100)', 'Warm (40-69)', 'Cold (0-39)'],
        datasets: [{
          data: [hot, warm, cold],
          backgroundColor: ['#059669', '#d97706', '#e11d48'],
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        cutout: '65%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#64748b', font: { family: 'Outfit', size: 11 } }
          }
        }
      }
    });
  },

  renderScoreBar(leads) {
    const ctx = document.getElementById('chart-score-bar');
    if (!ctx) return;

    const ranges = [
      { label: '0-19', min: 0, max: 19 },
      { label: '20-39', min: 20, max: 39 },
      { label: '40-59', min: 40, max: 59 },
      { label: '60-69', min: 60, max: 69 },
      { label: '70-79', min: 70, max: 79 },
      { label: '80-89', min: 80, max: 89 },
      { label: '90-100', min: 90, max: 100 }
    ];

    const data = ranges.map(r => leads.filter(l => l.total_score >= r.min && l.total_score <= r.max).length);

    this.instances.bar = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ranges.map(r => r.label),
        datasets: [{
          label: 'Prospect Count',
          data: data,
          backgroundColor: '#0284c7',
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#64748b' } },
          y: { grid: { color: 'rgba(15, 23, 42, 0.06)' }, ticks: { color: '#64748b' } }
        }
      }
    });
  }
};

window.Charts = Charts;
