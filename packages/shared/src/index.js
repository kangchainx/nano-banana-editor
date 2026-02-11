export const IMAGE_ROLES = Object.freeze({
  REFERENCE: "REFERENCE",
  SKELETON: "SKELETON",
  SOURCE: "SOURCE",
  SOUL: "SOUL"
});

export const FEATURE_TYPES = Object.freeze([
  "FACE",
  "STYLE",
  "MATERIAL",
  "COMPONENT"
]);

export const TASK_STATUSES = Object.freeze([
  "QUEUED",
  "PROCESSING",
  "SUCCESS",
  "FAILED"
]);

export class ContractValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ContractValidationError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    throw new ContractValidationError(
      "INVALID_STRING",
      `${field} must be a string`,
      { field, receivedType: typeof value }
    );
  }

  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    throw new ContractValidationError(
      "EMPTY_STRING",
      `${field} must not be empty`,
      { field }
    );
  }
  return trimmed;
}

function ensureWeight(value, field) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ContractValidationError(
      "INVALID_WEIGHT",
      `${field} must be a valid number`,
      { field, received: value }
    );
  }
  if (parsed < 0 || parsed > 1) {
    throw new ContractValidationError(
      "WEIGHT_OUT_OF_RANGE",
      `${field} must be in range [0, 1]`,
      { field, received: parsed }
    );
  }
  return Number(parsed.toFixed(4));
}

function validateReference(value) {
  if (!isRecord(value)) {
    throw new ContractValidationError(
      "INVALID_REFERENCE",
      "reference must be an object",
      { receivedType: typeof value }
    );
  }

  return {
    imageRef: ensureString(value.imageRef, "reference.imageRef"),
    weight: ensureWeight(value.weight, "reference.weight")
  };
}

function validateSource(value, index) {
  if (!isRecord(value)) {
    throw new ContractValidationError(
      "INVALID_SOURCE",
      `sources[${index}] must be an object`,
      { index, receivedType: typeof value }
    );
  }

  const featureType = ensureString(value.featureType, `sources[${index}].featureType`).toUpperCase();
  if (!FEATURE_TYPES.includes(featureType)) {
    throw new ContractValidationError(
      "INVALID_FEATURE_TYPE",
      `sources[${index}].featureType must be one of ${FEATURE_TYPES.join(", ")}`,
      { index, received: featureType }
    );
  }

  return {
    imageRef: ensureString(value.imageRef, `sources[${index}].imageRef`),
    featureType,
    weight: ensureWeight(value.weight, `sources[${index}].weight`)
  };
}

export function validateGenerationContract(input) {
  if (!isRecord(input)) {
    throw new ContractValidationError(
      "INVALID_CONTRACT",
      "Generation Contract must be an object"
    );
  }

  const taskId = ensureString(input.taskId, "taskId");
  const prompt = ensureString(input.prompt, "prompt");
  const negativePrompt =
    input.negativePrompt === undefined
      ? ""
      : ensureString(input.negativePrompt, "negativePrompt", { allowEmpty: true });
  const reference = validateReference(input.reference);

  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw new ContractValidationError(
      "INVALID_SOURCES",
      "sources must be a non-empty array"
    );
  }

  const sources = input.sources.map((source, index) => validateSource(source, index));

  return {
    taskId,
    prompt,
    negativePrompt,
    reference,
    sources
  };
}

export function createStatusResponse(input) {
  if (!isRecord(input)) {
    throw new ContractValidationError(
      "INVALID_STATUS",
      "Status Response must be an object"
    );
  }

  const taskId = ensureString(input.taskId, "taskId");
  const status = ensureString(input.status, "status").toUpperCase();

  if (!TASK_STATUSES.includes(status)) {
    throw new ContractValidationError(
      "INVALID_STATUS_VALUE",
      `status must be one of ${TASK_STATUSES.join(", ")}`,
      { received: status }
    );
  }

  const outputUrl =
    typeof input.outputUrl === "string" && input.outputUrl.trim().length > 0
      ? input.outputUrl.trim()
      : null;
  const errorCode =
    typeof input.errorCode === "string" && input.errorCode.trim().length > 0
      ? input.errorCode.trim()
      : null;
  const message =
    typeof input.message === "string" && input.message.trim().length > 0
      ? input.message.trim()
      : null;

  const warnings = Array.isArray(input.warnings)
    ? input.warnings.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];

  return {
    taskId,
    status,
    outputUrl,
    errorCode,
    message,
    warnings,
    updatedAt:
      typeof input.updatedAt === "string" && input.updatedAt.length > 0
        ? input.updatedAt
        : new Date().toISOString()
  };
}

export function extractPromptIndexing(prompt, sourceCount) {
  const normalizedPrompt = ensureString(prompt, "prompt", { allowEmpty: true });
  const sourceMatches = [...normalizedPrompt.matchAll(/\[Source\s+(\d+)\]/gi)];
  const sourceIndexes = sourceMatches.map((match) => Number(match[1]));
  const outOfRange = sourceIndexes.filter(
    (index) => !Number.isInteger(index) || index < 0 || index >= sourceCount
  );

  return {
    usesReference: /\[Reference\]/i.test(normalizedPrompt),
    sourceIndexes: [...new Set(sourceIndexes)],
    outOfRange: [...new Set(outOfRange)]
  };
}

export function serializeError(error) {
  if (error instanceof ContractValidationError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      code: "UNEXPECTED_ERROR",
      message: error.message
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: String(error)
  };
}
