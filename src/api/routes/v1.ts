import { Router } from 'express';
import {
  validateCandidateController,
  getCandidateController,
  listCandidatesController,
} from '../controllers/candidates.js';
import {
  createArchitectureExperimentController,
  createExperimentController,
  getExperimentController,
  listExperimentsController,
  getExperimentResultsController,
  cancelExperimentController,
} from '../controllers/experiments.js';
import {
  aiContractController,
  listArchitecturesController,
  getArchitectureController,
  listWorkloadsController,
  listCostCatalogsController,
} from '../controllers/architectures.js';
import { sseEventsHandler } from '../sse/events.js';
import {
  downloadArtifactController,
  listExperimentArtifactsController,
} from '../controllers/artifacts.js';
import { compareExperimentsController } from '../controllers/comparisons.js';
import {
  getAiBatchStudyController,
  listAiBatchStudiesController,
  publishAiBatchStudyController,
} from '../controllers/ai-batch-results.js';

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
  router.get(
    '/experiments/:experimentId/artifacts/:artifactId/download',
    downloadArtifactController,
  );
  router.post('/comparisons', compareExperimentsController);

  // AI model campaigns (read-only evidence views)
  router.get('/ai-batch/studies', listAiBatchStudiesController);
  router.post('/ai-batch/studies/:studyId/snapshot', publishAiBatchStudyController);
  router.get('/ai-batch/studies/:studyId', getAiBatchStudyController);

  // Architectures
  router.get('/architectures', listArchitecturesController);
  router.get('/architectures/ai-contract', aiContractController);
  router.get('/architectures/:id', getArchitectureController);
  router.post('/architectures/:id/experiments', createArchitectureExperimentController);

  // Workloads
  router.get('/workloads', listWorkloadsController);

  // Cost catalogs
  router.get('/cost-catalogs', listCostCatalogsController);

  return router;
}
