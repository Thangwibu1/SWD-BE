import type { Request, Response } from 'express';
import { loadRegistry } from '../../evaluator/registry/index.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export function listArchitecturesController(_req: Request, res: Response): void {
  try {
    const registry = loadRegistry();
    const architectures = Array.from(registry.entries()).map(([id, profile]) => ({
      id,
      family: profile.family,
      cache: profile.cache,
      messaging: profile.messaging,
      scalingProfile: profile.scalingProfile,
      communication: profile.communication,
      resourceProfile: profile.resourceProfile,
      allowedRoles: profile.allowedRoles,
    }));
    res.json({ architectures });
  } catch (err: unknown) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error' });
  }
}

export function getArchitectureController(req: Request, res: Response): void {
  const { id } = req.params as { id: string };
  try {
    const registry = loadRegistry();
    const profile = registry.get(id);
    if (!profile) {
      res.status(404).json({ code: 'NOT_FOUND', message: `Architecture ${id} not found` });
      return;
    }
    res.json({
      architectureId: id,
      family: profile.family,
      cache: profile.cache,
      messaging: profile.messaging,
      scalingProfile: profile.scalingProfile,
      communication: profile.communication,
      resourceProfile: profile.resourceProfile,
      allowedRoles: profile.allowedRoles,
    });
  } catch (err: unknown) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error' });
  }
}

export function listWorkloadsController(_req: Request, res: Response): void {
  const workloads = [
    { id: 'BROWSING_V1', name: 'Browsing V1', description: 'List 45%, detail 30%, search 15%, inventory 10%', purpose: 'Cache/read path' },
    { id: 'MIXED_V1', name: 'Mixed V1', description: 'Browse 60%, cart 20%, checkout 15%, order read 5%', purpose: 'Normal traffic' },
    { id: 'CHECKOUT_V1', name: 'Checkout V1', description: 'Cart 20%, checkout 60%, order read 20%', purpose: 'Transactions' },
    { id: 'FLASH_SALE_V1', name: 'Flash Sale V1', description: 'Checkout 80% on 20 hot SKUs, order read 20%', purpose: 'Race/oversell' },
  ];
  res.json({ workloads });
}

export function listCostCatalogsController(_req: Request, res: Response): void {
  try {
    const catalogDir = path.resolve('cost-catalogs');
    if (!existsSync(catalogDir)) {
      res.json({ catalogs: [] });
      return;
    }
    const files = readdirSync(catalogDir).filter(f => f.endsWith('.json'));
    const catalogs = files.map(f => {
      const data = JSON.parse(readFileSync(path.join(catalogDir, f), 'utf8'));
      return {
        version: data.version,
        currency: data.currency,
        filename: f,
      };
    });
    res.json({ catalogs });
  } catch (err: unknown) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error' });
  }
}
