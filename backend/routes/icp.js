const express = require('express');
const ICP = require('../models/ICP');
const config = require('../config/env');

const router = express.Router();

/** Attach the protection window so the UI can show and respect it. */
function withProtection(icp) {
  return icp && { ...icp, protected_until: ICP.protectedUntil(icp) };
}

// GET all ICPs for current user
router.get('/', async (req, res) => {
  try {
    // Most recently saved first, matching the order everything else uses to
    // pick a target — a freshly saved ICP is the one the user is working on.
    const icps = await ICP.listAll();
    res.json(icps.map(withProtection));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single ICP
router.get('/:id', async (req, res) => {
  try {
    const icp = await ICP.getById(req.params.id);
    if (!icp) return res.status(404).json({ error: 'ICP not found' });
    res.json(withProtection(icp));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST new ICP
//
// Accepts an `id`, which makes the call idempotent: the dashboard replays the
// profile it holds locally when the server no longer has it (a restart on a
// deployment without a durable disk wipes the database), and an ICP that is
// already present is returned untouched rather than duplicated.
router.post('/', async (req, res) => {
  try {
    if (req.body.id) {
      const existing = await ICP.getById(req.body.id);
      if (existing) return res.status(200).json(withProtection(existing));
    }

    const icpData = { ...req.body, user_id: req.user ? req.user.id : null };
    const icp = await ICP.create(icpData);
    res.status(201).json(withProtection(icp));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update ICP
//
// Updating an ICP that the server has lost re-creates it under the same id
// rather than 404-ing, so an edit made after a restart is not thrown away.
router.put('/:id', async (req, res) => {
  try {
    const existing = await ICP.getById(req.params.id);
    if (!existing) {
      const restored = await ICP.create({
        ...req.body,
        id: req.params.id,
        user_id: req.user ? req.user.id : null
      });
      return res.status(201).json(withProtection(restored));
    }

    const icp = await ICP.update(req.params.id, req.body);
    res.json(withProtection(icp));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE ICP
//
// A profile saved in the last hour is protected: deleting it needs ?force=true.
// Accidental deletion is unrecoverable, and the window covers exactly the
// period where the user is still setting the target up.
router.delete('/:id', async (req, res) => {
  try {
    const icp = await ICP.getById(req.params.id);
    if (!icp) return res.status(404).json({ error: 'ICP not found' });

    const force = String(req.query.force || '') === 'true';
    if (!force && ICP.isProtected(icp)) {
      return res.status(409).json({
        error:
          `"${icp.name}" was saved less than ${config.ICP_PROTECTION_MINUTES} minutes ago and is protected ` +
          `until ${ICP.protectedUntil(icp)}. Retry with ?force=true to delete it anyway.`,
        protected_until: ICP.protectedUntil(icp)
      });
    }

    await ICP.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
