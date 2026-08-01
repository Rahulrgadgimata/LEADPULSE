/**
 * LeadPulse AI — deployment configuration.
 *
 * API_BASE is empty by default, which means "same origin". The backend serves
 * this UI (backend/server.js does express.static on ../frontend), so relative
 * URLs work unchanged in local development and in production behind any domain.
 *
 * Only set this if the UI is hosted separately from the API, e.g.
 *   window.LEADPULSE_API_BASE = 'https://api.yourdomain.com';
 * (the API's CORS_ORIGIN must then include the UI's origin).
 */
window.LEADPULSE_API_BASE = '';
