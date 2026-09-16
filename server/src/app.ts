import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { coursesRouter } from './routes/courses.js';
import { jobsRouter } from './routes/jobs.js';
import { questionsRouter } from './routes/questions.js';
import { exportRouter } from './routes/exports.js';
import { formatsRouter } from './routes/formats.js';
import { errorHandler } from './middleware/errorHandler.js';
import { resumeStrandedJobs } from './services/pipeline/orchestrator.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/courses', coursesRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/questions', questionsRouter);
app.use('/api/export', exportRouter);
app.use('/api/formats', formatsRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Resume any job left in a non-terminal state by a prior disconnect/crash so it
  // runs to completion server-side instead of sitting stranded.
  resumeStrandedJobs();
});

export default app;
