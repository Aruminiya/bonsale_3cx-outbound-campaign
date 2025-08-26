import express, { Router } from 'express';

const router: Router = express.Router();

// API 路由
router.get('/status', (req, res) => {
  res.json({
    success: true,
    message: 'Project Outbound API is running'
  });
});

export default router;