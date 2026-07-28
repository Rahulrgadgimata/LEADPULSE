/**
 * LeadPulse AI — Next-Gen Analytics Charts Module
 * 5-Dimension Radar Chart + Tier Funnel Donut + Score Distribution Histogram
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

  /**
   * 5-Dimension Radar Chart
   */
  renderDimensionRadar(leads) {
    const ctx = document.getElementById('chart-radar-dimensions');
    if (!ctx || leads.length === 0) return;

    // Calculate average scores per dimension across all current leads
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
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.25)',
          pointBackgroundColor: '#06b6d4',
          pointBorderColor: '#030712',
          pointHoverRadius: 6,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: '#111827', titleColor: '#fff', bodyColor: '#9ca3af' }
        },
        scales: {
          r: {
            angleLines: { color: 'rgba(255, 255, 255, 0.08)' },
            grid: { color: 'rgba(255, 255, 255, 0.08)' },
            pointLabels: { color: '#9ca3af', font: { family: 'Inter', size: 11, weight: 600 } },
            ticks: { display: false, min: 0, max: 100 }
          }
        }
      }
    });
  },

  /**
   * Tier Breakdown Donut Chart
   */
  renderTierDonut(leads) {
    const ctx = document.getElementById('chart-tier-donut');
    if (!ctx) return;

    const hot = leads.filter(l => l.tier === 'hot').length;
    const warm = leads.filter(l => l.tier === 'warm').length;
    const cold = leads.filter(l => l.tier === 'cold').length;

    this.instances.donut = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['🔥 Hot (70-100)', '🌤️ Warm (40-69)', '❄️ Cold (0-39)'],
        datasets: [{
          data: [hot, warm, cold],
          backgroundColor: ['#10b981', '#f59e0b', '#f43f5e'],
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
            labels: { color: '#9ca3af', font: { family: 'Inter', size: 11 } }
          }
        }
      }
    });
  },

  /**
   * Score Histogram Bar Chart
   */
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
          backgroundColor: '#3b82f6',
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#6b7280' } },
          y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#6b7280' } }
        }
      }
    });
  }
};

window.Charts = Charts;
