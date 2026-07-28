/**
 * LeadPulse AI — Micro-Animations Module
 * Handles number counters, score bars, card entrances, and shimmer effects
 */

const Animations = {
  /**
   * Animate a number counter from 0 to target value
   */
  countUp(element, target, duration = 800) {
    const start = 0;
    const startTime = performance.now();

    const update = (currentTime) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + (target - start) * eased);
      element.textContent = current;

      if (progress < 1) {
        requestAnimationFrame(update);
      }
    };

    requestAnimationFrame(update);
  },

  /**
   * Animate score bar fill width
   */
  fillScoreBar(barElement, percentage, delay = 0) {
    barElement.style.width = '0%';
    setTimeout(() => {
      barElement.style.width = `${percentage}%`;
    }, delay + 100);
  },

  /**
   * Animate multiple score bars in sequence
   */
  fillScoreBars(container, delay = 0) {
    const bars = container.querySelectorAll('.score-bar__fill, .modal-dimension__fill');
    bars.forEach((bar, index) => {
      const width = bar.dataset.width || bar.style.width;
      bar.style.width = '0%';
      setTimeout(() => {
        bar.style.width = width;
      }, delay + (index * 100) + 200);
    });
  },

  /**
   * Fade in element with upward motion
   */
  fadeInUp(element, delay = 0) {
    element.style.opacity = '0';
    element.style.transform = 'translateY(12px)';
    element.style.transition = 'opacity 0.4s ease, transform 0.4s ease';

    setTimeout(() => {
      element.style.opacity = '1';
      element.style.transform = 'translateY(0)';
    }, delay);
  },

  /**
   * Staggered entrance for a group of elements
   */
  staggerEntrance(elements, baseDelay = 0, stagger = 50) {
    elements.forEach((el, index) => {
      this.fadeInUp(el, baseDelay + (index * stagger));
    });
  },

  /**
   * Pulse animation on an element
   */
  pulse(element) {
    element.style.animation = 'none';
    element.offsetHeight; // Trigger reflow
    element.style.animation = 'pulse-hot 0.6s ease';
  },

  /**
   * Shimmer loading placeholder
   */
  showShimmer(container, count = 5) {
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const shimmer = document.createElement('div');
      shimmer.className = 'shimmer-row';
      shimmer.style.cssText = `
        height: 48px; margin-bottom: 4px; border-radius: 8px;
        background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-elevated) 50%, var(--bg-card) 75%);
        background-size: 200% 100%;
        animation: shimmer 1.5s infinite;
        opacity: ${1 - (i * 0.15)};
      `;
      container.appendChild(shimmer);
    }
  },

  /**
   * Remove shimmer and show content
   */
  hideShimmer(container) {
    const shimmers = container.querySelectorAll('.shimmer-row');
    shimmers.forEach(s => s.remove());
  }
};

window.Animations = Animations;
