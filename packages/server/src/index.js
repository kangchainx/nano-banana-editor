import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDualTrackGeneration } from "../../engine/src/index.js";
import {
  ContractValidationError,
  createStatusResponse,
  serializeError,
  validateGenerationContract
} from "../../shared/src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const WEB_PUBLIC_DIR = path.resolve(REPO_ROOT, "packages/web/public");
const OUTPUT_DIR = path.resolve(REPO_ROOT, "packages/server/public/outputs");
const MAX_BODY_BYTES = 40 * 1024 * 1024;

function loadDotEnvFile() {
  const envFilePath = path.resolve(REPO_ROOT, ".env");
  if (!fs.existsSync(envFilePath)) {
    return;
  }

  const content = fs.readFileSync(envFilePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || key in process.env) {
      continue;
    }

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnvFile();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const tasks = new Map();
const sseClients = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function isPathInside(baseDir, candidatePath) {
  const relative = path.relative(baseDir, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

class HttpError extends Error {
  constructor(statusCode, message, code = "HTTP_ERROR") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function toTaskView(task) {
  return {
    ...createStatusResponse(task),
    workflowGraph: task.workflowGraph ?? null,
    progress: task.progress ?? null
  };
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store"
  });
  res.end(text);
}

async function parseJsonBody(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "request body is too large", "REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    throw new HttpError(400, "request body is empty", "EMPTY_BODY");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid JSON body", "INVALID_JSON");
  }
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastTaskEvent(taskId, event, payload) {
  const clients = sseClients.get(taskId);
  if (!clients || clients.size === 0) {
    return;
  }

  for (const client of clients) {
    writeSseEvent(client.res, event, payload);
  }
}

function updateTask(taskId, patch) {
  const prev = tasks.get(taskId);
  if (!prev) {
    return null;
  }

  const next = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  tasks.set(taskId, next);
  broadcastTaskEvent(taskId, "status", toTaskView(next));
  return next;
}

async function runTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) {
    return;
  }

  updateTask(taskId, {
    status: "PROCESSING",
    errorCode: null,
    message: null,
    outputUrl: null,
    progress: {
      stage: "QUEUED",
      progress: 0
    }
  });

  try {
    const result = await runDualTrackGeneration(task.contract, {
      onStage(stage) {
        updateTask(taskId, { progress: stage });
      }
    });

    const filename = `${taskId}.${result.outputExtension}`;
    const outputPath = path.join(OUTPUT_DIR, filename);
    await writeFile(outputPath, result.outputBuffer);

    updateTask(taskId, {
      status: "SUCCESS",
      outputUrl: `/outputs/${filename}`,
      errorCode: null,
      message: result.warnings.length > 0 ? "completed_with_warnings" : null,
      warnings: result.warnings,
      workflowGraph: result.workflowGraph,
      progress: {
        stage: "DONE",
        progress: 1
      }
    });
  } catch (error) {
    const details = serializeError(error);
    updateTask(taskId, {
      status: "FAILED",
      outputUrl: null,
      errorCode: details.code,
      message: details.message
    });
  }
}

async function serveFile(res, filePath) {
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": data.length,
      "cache-control": ext === ".svg" ? "no-cache" : "public, max-age=300"
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function handleStatic(req, res, pathname) {
  if (pathname.startsWith("/outputs/")) {
    const relative = pathname.slice("/outputs/".length);
    const fullPath = path.resolve(OUTPUT_DIR, relative);
    if (!isPathInside(OUTPUT_DIR, fullPath)) {
      return false;
    }
    return serveFile(res, fullPath);
  }

  const cleaned = pathname === "/" ? "/index.html" : pathname;
  const relative = cleaned.replace(/^\/+/, "");
  const fullPath = path.resolve(WEB_PUBLIC_DIR, relative);
  if (!isPathInside(WEB_PUBLIC_DIR, fullPath)) {
    return false;
  }

  const served = await serveFile(res, fullPath);
  if (served) {
    return true;
  }

  if (cleaned !== "/index.html") {
    return serveFile(res, path.resolve(WEB_PUBLIC_DIR, "index.html"));
  }

  return false;
}

function createTaskRecord(contract) {
  return {
    taskId: contract.taskId,
    contract,
    status: "QUEUED",
    outputUrl: null,
    errorCode: null,
    message: null,
    warnings: [],
    workflowGraph: null,
    progress: null,
    updatedAt: new Date().toISOString()
  };
}

function extractTaskId(pathname, suffix = "") {
  const escapedSuffix = suffix ? suffix.replaceAll("/", "\\/") : "";
  const pattern = new RegExp(`^\\/api\\/tasks\\/([^/]+)${escapedSuffix}$`);
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

async function requestHandler(req, res) {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, {
        service: "meie-server",
        status: "ok",
        now: new Date().toISOString()
      });
    }

    if (req.method === "GET" && pathname === "/api/tasks") {
      const allTasks = [...tasks.values()].map((task) => toTaskView(task));
      return sendJson(res, 200, { tasks: allTasks });
    }

    if (req.method === "POST" && pathname === "/api/tasks") {
      const body = await parseJsonBody(req);
      const contract = validateGenerationContract(body);

      if (tasks.has(contract.taskId)) {
        throw new HttpError(409, `taskId ${contract.taskId} already exists`, "TASK_EXISTS");
      }

      const record = createTaskRecord(contract);
      tasks.set(contract.taskId, record);

      setTimeout(() => {
        tasks.delete(contract.taskId);
      }, 60 * 60 * 1000).unref();

      sendJson(res, 202, {
        ...toTaskView(record),
        statusUrl: `/api/tasks/${encodeURIComponent(contract.taskId)}`,
        streamUrl: `/api/tasks/${encodeURIComponent(contract.taskId)}/events`
      });

      void runTask(contract.taskId);
      return;
    }

    if (req.method === "GET") {
      const streamTaskId = extractTaskId(pathname, "/events");
      if (streamTaskId) {
        const task = tasks.get(streamTaskId);
        if (!task) {
          throw new HttpError(404, "task not found", "TASK_NOT_FOUND");
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "cache-control": "no-store"
        });

        res.write("retry: 2500\n\n");
        writeSseEvent(res, "status", toTaskView(task));

        const record = {
          res,
          keepAlive: setInterval(() => {
            res.write(": keep-alive\n\n");
          }, 15000)
        };

        const clients = sseClients.get(streamTaskId) ?? new Set();
        clients.add(record);
        sseClients.set(streamTaskId, clients);

        req.on("close", () => {
          clearInterval(record.keepAlive);
          const entries = sseClients.get(streamTaskId);
          if (!entries) {
            return;
          }
          entries.delete(record);
          if (entries.size === 0) {
            sseClients.delete(streamTaskId);
          }
        });
        return;
      }

      const taskId = extractTaskId(pathname);
      if (taskId) {
        const task = tasks.get(taskId);
        if (!task) {
          throw new HttpError(404, "task not found", "TASK_NOT_FOUND");
        }
        return sendJson(res, 200, toTaskView(task));
      }
    }

    const served = await handleStatic(req, res, pathname);
    if (served) {
      return;
    }

    throw new HttpError(404, "Not Found", "NOT_FOUND");
  } catch (error) {
    if (error instanceof HttpError) {
      return sendJson(res, error.statusCode, {
        error: {
          code: error.code,
          message: error.message
        }
      });
    }

    if (error instanceof ContractValidationError) {
      return sendJson(res, 400, {
        error: serializeError(error)
      });
    }

    const details = serializeError(error);
    return sendJson(res, 500, {
      error: details
    });
  }
}

await mkdir(OUTPUT_DIR, { recursive: true });

const server = createServer((req, res) => {
  void requestHandler(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Nano Banana Editor server listening on http://${HOST}:${PORT}`);
});
