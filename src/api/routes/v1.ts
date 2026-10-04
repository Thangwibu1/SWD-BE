import { Router } from 'express';
import { validateCandidateController, getCandidateController, listCandidatesController } from '../controllers/candidates.js';
import { createArchitectureExperimentController, createExperimentController, getExperimentController, listExperimentsController, getExperimentResultsController, cancelExperimentController } from '../controllers/experiments.js';
import { listArchitecturesController, getArchitectureController, listWorkloadsController, listCostCatalogsController } from '../controllers/architectures.js';
import { sseEventsHandler } from '../sse/events.js';
import { downloadArtifactController, listExperimentArtifactsController } from '../controllers/artifacts.js';
import { compareExperimentsController } from '../controllers/comparisons.js';

export function createV1Router(): Router {
  const router = Router();

  // Candidates
  router.post('/candidates/validate', validateCandidateController);
  router.get('/candidates/:id', getCandidateController);
  router.get('/candidates', listCandidatesController);

  // Experiments
  router.post('/experiments', createExperimentController);
  router.get('/experiments', listExperimentsController);
  router.get('/experiments/:id', getExperimentController);
  router.get('/experiments/:id/results', getExperimentResultsController);
  router.get('/experiments/:id/events', sseEventsHandler);
  router.get('/experiments/:id/artifacts', listExperimentArtifactsController);
  router.post('/experiments/:id/cancel', cancelExperimentController);
  router.get('/experiments/:experimentId/artifacts/:artifactId/download', downloadArtifactController);
  router.post('/comparisons', compareExperimentsController);

  // Architectures
  router.get('/architectures', listArchitecturesController);
  router.get('/architectures/:id', getArchitectureController);
  router.post('/architectures/:id/experiments', createArchitectureExperimentController);

  // Workloads
  router.get('/workloads', listWorkloadsController);

  // Cost catalogs
  router.get('/cost-catalogs', listCostCatalogsController);

  return router;
}
