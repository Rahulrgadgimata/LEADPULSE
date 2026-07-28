const { TIERS, TIER_THRESHOLDS } = require('../../utils/constants');

/**
 * Maps a numeric score (0–100) to a tier label
 *   Hot: 70–100
 *   Warm: 40–69
 *   Cold: 0–39
 */
class TierMapper {
  /**
   * Get tier for a score
   * @param {number} score - 0–100
   * @returns {string} 'hot' | 'warm' | 'cold'
   */
  getTier(score) {
    if (score >= TIER_THRESHOLDS.HOT_MIN) return TIERS.HOT;
    if (score >= TIER_THRESHOLDS.WARM_MIN) return TIERS.WARM;
    return TIERS.COLD;
  }

  /**
   * Get tier label for display
   */
  getTierLabel(score) {
    const tier = this.getTier(score);
    return tier.charAt(0).toUpperCase() + tier.slice(1);
  }

  /**
   * Get tier color for UI (hex)
   */
  getTierColor(score) {
    const tier = this.getTier(score);
    const colors = {
      hot: '#10b981',   // Emerald green
      warm: '#f59e0b',  // Amber
      cold: '#ef4444',  // Red
    };
    return colors[tier] || '#6b7280';
  }

  /**
   * Get tier emoji
   */
  getTierEmoji(score) {
    const tier = this.getTier(score);
    const emojis = { hot: '🔥', warm: '🌤️', cold: '❄️' };
    return emojis[tier] || '❓';
  }

  /**
   * Get tier description
   */
  getTierDescription(score) {
    const tier = this.getTier(score);
    const descriptions = {
      hot: 'High priority — contact immediately',
      warm: 'Worth pursuing — needs nurturing',
      cold: 'Low priority — monitor for changes',
    };
    return descriptions[tier];
  }

  /**
   * Get all tier definitions
   */
  getTierDefinitions() {
    return [
      { tier: TIERS.HOT, min: TIER_THRESHOLDS.HOT_MIN, max: 100, label: 'Hot', color: '#10b981', emoji: '🔥', description: 'High priority — contact immediately' },
      { tier: TIERS.WARM, min: TIER_THRESHOLDS.WARM_MIN, max: TIER_THRESHOLDS.HOT_MIN - 1, label: 'Warm', color: '#f59e0b', emoji: '🌤️', description: 'Worth pursuing — needs nurturing' },
      { tier: TIERS.COLD, min: 0, max: TIER_THRESHOLDS.WARM_MIN - 1, label: 'Cold', color: '#ef4444', emoji: '❄️', description: 'Low priority — monitor for changes' },
    ];
  }
}

module.exports = new TierMapper();
