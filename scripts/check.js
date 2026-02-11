import assert from "node:assert/strict";

import {
  createStatusResponse,
  validateGenerationContract
} from "../packages/shared/src/index.js";
import { runDualTrackGeneration } from "../packages/engine/src/index.js";

const contract = validateGenerationContract({
  taskId: "demo_check_task",
  prompt: "Use [Reference] pose with [Source 0] texture and [Source 1] accessories",
  negativePrompt: "blurry, low quality",
  reference: {
    imageRef: "https://example.com/reference.png",
    weight: 0.9
  },
  sources: [
    {
      imageRef: "https://example.com/source-style.png",
      featureType: "STYLE",
      weight: 0.75
    },
    {
      imageRef: "https://example.com/source-component.png",
      featureType: "COMPONENT",
      weight: 0.65
    }
  ]
});

assert.equal(contract.sources.length, 2);
assert.equal(contract.reference.weight, 0.9);

const status = createStatusResponse({
  taskId: contract.taskId,
  status: "QUEUED"
});

assert.equal(status.status, "QUEUED");
assert.equal(status.errorCode, null);

if (process.env.CHECK_REMOTE === "1") {
  const result = await runDualTrackGeneration(contract);
  assert.ok(result.outputBuffer.length > 0);
  assert.ok(typeof result.outputExtension === "string" && result.outputExtension.length > 0);
  assert.ok(typeof result.outputMimeType === "string" && result.outputMimeType.length > 0);
}

console.log("check passed");
