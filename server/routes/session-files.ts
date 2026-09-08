import fs from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { listSessionFiles, resolveSessionFile, sessionIdForPath } from "../../lib/session-files.js";

export function createSessionFilesRoute(engine: { listSessions(): Promise<{ path: string }[]> | { path: string }[] }) {
  const route = new Hono();
  async function resolveSession(id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) return null;
    return (await engine.listSessions()).find(session => { try { return sessionIdForPath(session.path) === id; } catch { return false; } }) || null;
  }
  route.get('/session-files/:sessionId', async c => {
    const session = await resolveSession(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({ files: listSessionFiles(session.path) });
  });
  route.get('/session-files/:sessionId/:fileId', async c => {
    const session = await resolveSession(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    try {
      const { file, localPath } = resolveSessionFile(session.path, c.req.param('fileId'));
      const fd = fs.openSync(localPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stream = fs.createReadStream(localPath, { fd, autoClose: true });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox",
      } });
    } catch { return c.json({ error: 'Session attachment unavailable' }, 404); }
  });
  return route;
}
