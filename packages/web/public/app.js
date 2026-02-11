const form = document.querySelector("#generation-form");
const taskIdInput = document.querySelector("#task-id");
const promptInput = document.querySelector("#prompt");
const negativePromptInput = document.querySelector("#negative-prompt");
const modelSelect = document.querySelector("#model-select");
const referenceFileInput = document.querySelector("#reference-file");
const referenceUploadPreview = document.querySelector("#reference-upload-preview");
const referenceWeightInput = document.querySelector("#reference-weight");
const referenceWeightText = document.querySelector("#reference-weight-text");
const addSourceButton = document.querySelector("#add-source");
const sourcesContainer = document.querySelector("#sources");
const sourceTemplate = document.querySelector("#source-template");
const statusDetails = document.querySelector("#status-details");
const statusSteps = [...document.querySelectorAll("#status-steps li")];
const resultImage = document.querySelector("#result-image");
const previewEmpty = document.querySelector("#preview-empty");
const inputThumbnails = document.querySelector("#input-thumbnails");
const inputThumbnailsList = document.querySelector("#input-thumbnails-list");
const submitButton = document.querySelector("#submit-btn");

let currentEventSource = null;
const taskInputCache = new Map();
const DEFAULT_REFERENCE_WEIGHT = 0.85;
const MIN_REFERENCE_WEIGHT = 0.05;
let lastReferenceWeight = DEFAULT_REFERENCE_WEIGHT;

function createTaskId() {
  const now = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `task_${now}_${random}`;
}

function setBusyState(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "任务提交中..." : "提交生成任务";
}

function clampWeight(value) {
  if (!Number.isFinite(value)) {
    return lastReferenceWeight;
  }
  return Math.min(1, Math.max(MIN_REFERENCE_WEIGHT, value));
}

function getReferenceWeight() {
  const raw = referenceWeightInput.value;
  if (raw === "") {
    return lastReferenceWeight;
  }
  const parsed = Number(raw);
  const normalized = clampWeight(parsed);
  lastReferenceWeight = normalized;
  return normalized;
}

function updateReferenceWeightLabel() {
  const weight = getReferenceWeight();
  referenceWeightInput.value = weight.toFixed(2);
  referenceWeightText.textContent = weight.toFixed(2);
}

function refreshSourceIndexes() {
  const sourceItems = [...sourcesContainer.querySelectorAll(".source-item")];
  sourceItems.forEach((item, index) => {
    const indexNode = item.querySelector(".source-index");
    indexNode.textContent = String(index);
  });
}

function addSource(defaults = {}) {
  const fragment = sourceTemplate.content.cloneNode(true);
  const sourceItem = fragment.querySelector(".source-item");
  const featureSelect = sourceItem.querySelector(".source-feature");
  const weightInput = sourceItem.querySelector(".source-weight");
  const weightText = sourceItem.querySelector(".source-weight-text");
  const sourceFileInput = sourceItem.querySelector(".source-file");
  const sourceUploadPreview = sourceItem.querySelector(".source-upload-preview");
  const removeButton = sourceItem.querySelector(".remove-source");

  if (defaults.featureType) {
    featureSelect.value = defaults.featureType;
  }
  if (typeof defaults.weight === "number") {
    weightInput.value = defaults.weight.toFixed(2);
    weightText.textContent = defaults.weight.toFixed(2);
  }

  weightInput.addEventListener("input", () => {
    weightText.textContent = Number(weightInput.value).toFixed(2);
  });

  removeButton.addEventListener("click", () => {
    sourceItem.remove();
    refreshSourceIndexes();
  });

  sourceFileInput.addEventListener("change", () => {
    updateFilePreview(sourceFileInput, sourceUploadPreview);
  });

  sourcesContainer.appendChild(fragment);
  refreshSourceIndexes();
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function updateFilePreview(fileInput, previewWrap) {
  const file = fileInput.files?.[0];
  const imageNode = previewWrap.querySelector("img");
  if (!file) {
    previewWrap.classList.add("hidden");
    imageNode.removeAttribute("src");
    return;
  }
  const objectUrl = URL.createObjectURL(file);
  imageNode.src = objectUrl;
  previewWrap.classList.remove("hidden");
  imageNode.onload = () => {
    URL.revokeObjectURL(objectUrl);
  };
}

async function buildContractFromForm() {
  const referenceFile = referenceFileInput.files?.[0];
  if (!referenceFile) {
    throw new Error("请上传 REFERENCE 参考图");
  }

  const sourceItems = [...sourcesContainer.querySelectorAll(".source-item")];
  if (sourceItems.length === 0) {
    throw new Error("请至少添加一个 SOURCE");
  }

  const sources = [];
  for (const [index, item] of sourceItems.entries()) {
    const fileInput = item.querySelector(".source-file");
    const featureSelect = item.querySelector(".source-feature");
    const weightInput = item.querySelector(".source-weight");
    const file = fileInput.files?.[0];

    if (!file) {
      throw new Error(`Source ${index} 缺少图片`);
    }

    sources.push({
      imageRef: await fileToDataUrl(file),
      featureType: featureSelect.value,
      weight: Number(weightInput.value)
    });
  }

  return {
    taskId: taskIdInput.value.trim(),
    model: modelSelect.value,
    prompt: promptInput.value.trim(),
    negativePrompt: negativePromptInput.value.trim(),
    reference: {
      imageRef: await fileToDataUrl(referenceFile),
      weight: getReferenceWeight()
    },
    sources
  };
}

function formatJson(obj) {
  return JSON.stringify(obj, null, 2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hideInputThumbnails() {
  inputThumbnails.classList.add("hidden");
  inputThumbnailsList.innerHTML = "";
}

function renderInputThumbnails(taskId) {
  const input = taskInputCache.get(taskId);
  if (!input) {
    hideInputThumbnails();
    return;
  }

  const items = [
    {
      label: "REFERENCE",
      extra: `weight ${Number(input.reference.weight).toFixed(2)}`,
      imageRef: input.reference.imageRef
    },
    ...input.sources.map((source, index) => ({
      label: `SOURCE ${index}`,
      extra: `${source.featureType} · ${Number(source.weight).toFixed(2)}`,
      imageRef: source.imageRef
    }))
  ];

  inputThumbnailsList.innerHTML = items
    .map(
      (item) => `
      <article class="thumb-item">
        <img src="${item.imageRef}" alt="${escapeHtml(item.label)}" />
        <div class="thumb-meta">${escapeHtml(item.label)}<br/>${escapeHtml(item.extra)}</div>
      </article>
    `
    )
    .join("");

  inputThumbnails.classList.remove("hidden");
}

function setPreviewState(state, imageUrl = "") {
  if (state === "image" && imageUrl) {
    previewEmpty.classList.add("hidden");
    resultImage.classList.add("visible");
    resultImage.src = imageUrl;
    return;
  }

  resultImage.classList.remove("visible");
  resultImage.removeAttribute("src");
  previewEmpty.classList.remove("hidden");
}

function updateStatusSteps(status) {
  const order = ["QUEUED", "PROCESSING", "SUCCESS", "FAILED"];
  const current = order.indexOf(status);

  statusSteps.forEach((item, index) => {
    item.classList.remove("active", "done", "error");
    if (status === "FAILED" && item.dataset.status === "FAILED") {
      item.classList.add("active", "error");
      return;
    }
    if (index < current) {
      item.classList.add("done");
    } else if (index === current) {
      item.classList.add("active");
    }
  });
}

function renderTaskStatus(task) {
  updateStatusSteps(task.status);
  statusDetails.textContent = formatJson(task);

  if (task.status === "SUCCESS" && task.outputUrl) {
    const url = `${task.outputUrl}?t=${Date.now()}`;
    setPreviewState("image", url);
    renderInputThumbnails(task.taskId);
    return;
  }

  if (task.status === "FAILED") {
    hideInputThumbnails();
  }

  setPreviewState("empty");
}

function closeEventSource() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}

function openEventStream(taskId) {
  closeEventSource();
  const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
  currentEventSource = stream;

  stream.addEventListener("status", (event) => {
    const payload = JSON.parse(event.data);
    renderTaskStatus(payload);
    if (payload.status === "SUCCESS" || payload.status === "FAILED") {
      stream.close();
      currentEventSource = null;
    }
  });

  stream.onerror = () => {
    statusDetails.textContent = "SSE 连接已中断，可手动刷新任务状态。";
    stream.close();
    currentEventSource = null;
  };
}

async function submitTask(event) {
  event.preventDefault();
  setPreviewState("empty");
  hideInputThumbnails();
  setBusyState(true);

  try {
    taskIdInput.value = createTaskId();
    const contract = await buildContractFromForm();
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(contract)
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload?.error?.message || "创建任务失败");
    }

    taskInputCache.set(contract.taskId, {
      reference: contract.reference,
      sources: contract.sources
    });

    renderTaskStatus(payload);
    openEventStream(contract.taskId);
  } catch (error) {
    statusDetails.textContent = error instanceof Error ? error.message : String(error);
    updateStatusSteps("FAILED");
  } finally {
    setBusyState(false);
  }
}

referenceWeightInput.addEventListener("input", updateReferenceWeightLabel);
referenceWeightInput.addEventListener("change", updateReferenceWeightLabel);
referenceWeightInput.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (document.activeElement === referenceWeightInput) {
      referenceWeightInput.blur();
    }
  },
  { passive: false }
);
addSourceButton.addEventListener("click", () => addSource({ weight: 0.7 }));
form.addEventListener("submit", submitTask);
referenceFileInput.addEventListener("change", () => {
  updateFilePreview(referenceFileInput, referenceUploadPreview);
});

taskIdInput.value = createTaskId();
promptInput.value = [
  "严格遵循 [Reference] 的物理结构与空间布局，保持主体位置、透视关系、景深层次与光影大关系一致，确保视觉重心不偏移。",
  "将 [Source 0] 到 [Source N-1] 的关键特征进行精准提取与有机整合，包括但不限于主体形态、材质细节、符号化特征与色彩体系。",
  "输出需同时满足特征一致性与整合性：准确还原每个 Source 的核心元素，避免简单风格叠加，形成统一且合理的目标对象/场景。",
  "最终图像应高质量、逻辑自洽、边缘自然，无明显伪影、肢体错误、结构错位或物理违和感。"
].join("\n");
negativePromptInput.value =
  "low quality, blurry, out of focus, artifact, bad anatomy, deformed structure, distorted limbs, inconsistent perspective, incorrect lighting, unrealistic shadows, ghosting, duplicate objects, watermark, text, logo";
modelSelect.value = "gemini-3-pro-image-preview";
referenceWeightInput.value = DEFAULT_REFERENCE_WEIGHT.toFixed(2);
referenceWeightInput.min = MIN_REFERENCE_WEIGHT.toFixed(2);
updateReferenceWeightLabel();
addSource({ featureType: "STYLE", weight: 0.72 });
addSource({ featureType: "COMPONENT", weight: 0.66 });

window.addEventListener("beforeunload", () => {
  closeEventSource();
});

setPreviewState("empty");
hideInputThumbnails();
