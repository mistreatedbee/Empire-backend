import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';

const router = Router();

const INSFORGE_URL = process.env.INSFORGE_URL ?? 'https://mnf8bzhv.us-east.insforge.app';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY ?? '';
const BUCKET = 'application-documents';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new Error('UNSUPPORTED_FILE_TYPE'));
      return;
    }
    cb(null, true);
  },
});

// POST /uploads — proxy a file to InsForge Storage and return its public URL
router.post('/', requireAuth, upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      fail(res, 400, 'VALIDATION_ERROR', 'No file provided.');
      return;
    }

    const folder = (req.body.folder as string | undefined)?.trim() || 'misc';
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${folder}/${req.userId}/${uuidv4()}-${safeName}`;

    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), safeName);

    const insforgeRes = await fetch(
      `${INSFORGE_URL}/api/storage/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${INSFORGE_API_KEY}` },
        body: form,
      }
    );

    if (!insforgeRes.ok) {
      logger.error({ status: insforgeRes.status }, 'uploads: InsForge storage rejected upload');
      fail(res, 502, 'UPLOAD_FAILED', 'Could not store the file. Please try again.');
      return;
    }

    const url = `${INSFORGE_URL}/api/storage/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`;
    ok(res, { url });
  } catch (err) {
    if (err instanceof Error && err.message === 'UNSUPPORTED_FILE_TYPE') {
      fail(res, 400, 'UNSUPPORTED_FILE_TYPE', 'Please upload a photo, PDF, or Word document.');
      return;
    }
    logger.error({ err }, 'POST /uploads');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

export default router;
