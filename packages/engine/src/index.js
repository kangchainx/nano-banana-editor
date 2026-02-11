import { extractPromptIndexing } from "../../shared/src/index.js";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3-pro-image-preview";
const DEFAULT_BASE_URL =
  process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";

const FEATURE_HINTS = Object.freeze({
  FACE: "Preserve identity and facial consistency.",
  STYLE: "Transfer visual style, color language, and rendering tone.",
  MATERIAL: "Transfer material and texture fidelity.",
  COMPONENT: "Transfer specific components or accessories."
});

function summarizeText(text, maxLength = 420) {
  if (typeof text !== "string") {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid data URL imageRef. Expected data:<mime>;base64,<data>.");
  }
  return {
    mimeType: match[1],
    data: match[2]
  };
}

async function imageRefToInlineData(imageRef) {
  if (imageRef.startsWith("data:")) {
    return parseDataUrl(imageRef);
  }

  if (/^https?:\/\//i.test(imageRef)) {
    const response = await fetch(imageRef);
    if (!response.ok) {
      throw new Error(`Failed to download imageRef: ${imageRef} (${response.status})`);
    }
    const mimeType = response.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      mimeType: mimeType.split(";")[0],
      data: buffer.toString("base64")
    };
  }

  throw new Error("Unsupported imageRef format. Use data URL or http(s) URL.");
}

function createSystemPrompt(contract) {
  const sourceHints = contract.sources
    .map(
      (source, index) =>
        `Source ${index}: type=${source.featureType}, weight=${source.weight.toFixed(2)}. ${FEATURE_HINTS[source.featureType]}`
    )
    .join("\n");

  return [
    "You are a multi-reference image editing and generation engine.",
    "Apply strong composition constraints from Reference image.",
    "Apply weighted multi-source feature fusion from Source images.",
    "Keep scene physically coherent with minimal artifacts.",
    "If conflicts happen, prioritize higher weight source features.",
    "",
    "Feature plan:",
    sourceHints
  ].join("\n");
}

function extractOutputImage(resultJson) {
  const parts = resultJson?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Gemini returned no candidates/content parts.");
  }

  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  if (!imagePart) {
    const textPart = parts.find((part) => typeof part.text === "string");
    if (textPart?.text) {
      throw new Error(`Gemini returned text only: ${textPart.text.slice(0, 220)}`);
    }
    throw new Error("Gemini returned no image part.");
  }

  const inlineData = imagePart.inlineData || imagePart.inline_data;
  const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
  const base64Data = inlineData.data;
  if (!base64Data) {
    throw new Error("Gemini image part missing base64 data.");
  }

  let outputExtension = "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    outputExtension = "jpg";
  } else if (mimeType.includes("webp")) {
    outputExtension = "webp";
  }

  return {
    outputBuffer: Buffer.from(base64Data, "base64"),
    outputMimeType: mimeType,
    outputExtension
  };
}

function buildWorkflowGraph(contract) {
  const promptIndexing = extractPromptIndexing(contract.prompt, contract.sources.length);
  return {
    name: "MEIE-DualTrack-Gemini",
    version: "0.2.0",
    model: contract.model || DEFAULT_MODEL,
    promptIndexing,
    nodes: [
      {
        id: "reference",
        role: "REFERENCE",
        engineNode: "composition_constraint",
        weight: contract.reference.weight
      },
      {
        id: "feature-track",
        role: "TRACK_B",
        engineNode: "multi_source_feature_fusion",
        sources: contract.sources.map((source, index) => ({
          id: `source-${index}`,
          featureType: source.featureType,
          weight: source.weight
        }))
      },
      {
        id: "gemini-generate",
        role: "MERGE",
        engineNode: "generateContent",
        prompt: contract.prompt
      }
    ]
  };
}

export async function runDualTrackGeneration(contract, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  const targetModel = contract.model || DEFAULT_MODEL;
  const workflowGraph = buildWorkflowGraph({
    ...contract,
    model: targetModel
  });
  const warnings = [];
  if (workflowGraph.promptIndexing.outOfRange.length > 0) {
    warnings.push(
      `Prompt references out-of-range source indexes: ${workflowGraph.promptIndexing.outOfRange.join(", ")}`
    );
  }

  if (typeof options.onStage === "function") {
    options.onStage({ stage: "REFERENCE_PREPROCESS", progress: 0.2 });
  }

  const referenceInlineData = await imageRefToInlineData(contract.reference.imageRef);

  if (typeof options.onStage === "function") {
    options.onStage({ stage: "SOURCE_FEATURE_EXTRACTION", progress: 0.45 });
  }

  const sourceInlineDataList = [];
  for (const source of contract.sources) {
    sourceInlineDataList.push(await imageRefToInlineData(source.imageRef));
  }

  if (typeof options.onStage === "function") {
    options.onStage({ stage: "DIFFUSION_SAMPLING", progress: 0.75 });
  }

  const userPrompt = [
    `Task ID: ${contract.taskId}`,
    `Reference weight: ${contract.reference.weight.toFixed(2)}`,
    ...contract.sources.map(
      (source, index) =>
        `Source ${index} -> featureType=${source.featureType}, weight=${source.weight.toFixed(2)}`
    ),
    "",
    `User prompt: ${contract.prompt}`,
    contract.negativePrompt ? `Negative prompt: ${contract.negativePrompt}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const contents = [
    {
      role: "user",
      parts: [
        {
          text: [
            "Reference image below is composition anchor.",
            "Apply source image features with weighted fusion.",
            "",
            userPrompt
          ].join("\n")
        },
        {
          inline_data: referenceInlineData
        },
        ...sourceInlineDataList.map((inlineData, index) => ({
          text: `Source ${index} image`
        })),
        ...sourceInlineDataList.map((inlineData) => ({
          inline_data: inlineData
        }))
      ]
    }
  ];

  const requestBody = {
    system_instruction: {
      parts: [{ text: createSystemPrompt(contract) }]
    },
    contents,
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"]
    }
  };

  const endpoint = `${DEFAULT_BASE_URL}/models/${encodeURIComponent(targetModel)}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(requestBody)
  });

  const responseText = await response.text();
  let resultJson = null;
  if (responseText) {
    try {
      resultJson = JSON.parse(responseText);
    } catch {
      resultJson = null;
    }
  }

  if (!response.ok) {
    const requestId =
      response.headers.get("x-request-id") ||
      response.headers.get("x-goog-request-id") ||
      null;
    const message =
      resultJson?.error?.message ||
      `Gemini API request failed with status ${response.status}.`;
    const detailSummary = summarizeText(
      resultJson?.error
        ? JSON.stringify(resultJson.error)
        : responseText || "empty response body"
    );
    const error = new Error(message);
    error.code = "GEMINI_API_ERROR";
    error.details = {
      provider: "gemini",
      model: targetModel,
      status: response.status,
      statusText: response.statusText || null,
      requestId,
      bodySummary: detailSummary
    };
    throw error;
  }

  if (!resultJson) {
    const error = new Error("Gemini returned non-JSON success response.");
    error.code = "GEMINI_API_ERROR";
    error.details = {
      provider: "gemini",
      model: targetModel,
      status: response.status,
      statusText: response.statusText || null,
      requestId:
        response.headers.get("x-request-id") ||
        response.headers.get("x-goog-request-id") ||
        null,
      bodySummary: summarizeText(responseText || "empty response body")
    };
    throw error;
  }

  await sleep(150);

  if (typeof options.onStage === "function") {
    options.onStage({ stage: "OUTPUT_RENDER", progress: 1 });
  }

  const output = extractOutputImage(resultJson);
  return {
    workflowGraph,
    warnings,
    outputBuffer: output.outputBuffer,
    outputMimeType: output.outputMimeType,
    outputExtension: output.outputExtension
  };
}
