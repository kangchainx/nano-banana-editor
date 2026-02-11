const form = document.querySelector("#generation-form");
const taskIdInput = document.querySelector("#task-id");
const promptInput = document.querySelector("#prompt");
const negativePromptInput = document.querySelector("#negative-prompt");
const referenceFileInput = document.querySelector("#reference-file");
const referenceWeightInput = document.querySelector("#reference-weight");
const referenceWeightText = document.querySelector("#reference-weight-text");
const addSourceButton = document.querySelector("#add-source");
const sourcesContainer = document.querySelector("#sources");
const sourceTemplate = document.querySelector("#source-template");
const statusDetails = document.querySelector("#status-details");
const statusSteps = [...document.querySelectorAll("#status-steps li")];
const resultImage = document.querySelector("#result-image");
const submitButton = document.querySelector("#submit-btn");

let currentEventSource = null;

function createTaskId() {
  const now = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `task_${now}_${random}`;
}

function setBusyState(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "任务提交中..." : "提交生成任务";
}

function updateReferenceWeightLabel() {
  referenceWeightText.textContent = Number(referenceWeightInput.value).toFixed(2);
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
    prompt: promptInput.value.trim(),
    negativePrompt: negativePromptInput.value.trim(),
    reference: {
      imageRef: await fileToDataUrl(referenceFile),
      weight: Number(referenceWeightInput.value)
    },
    sources
  };
}

function formatJson(obj) {
  return JSON.stringify(obj, null, 2);
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
    resultImage.src = url;
  }
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
  resultImage.removeAttribute("src");
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
addSourceButton.addEventListener("click", () => addSource({ weight: 0.7 }));
form.addEventListener("submit", submitTask);

taskIdInput.value = createTaskId();
promptInput.value =
  "Use [Reference] composition and merge [Source 0] style with [Source 1] components.";
negativePromptInput.value = "low quality, artifact, distorted limbs";
updateReferenceWeightLabel();
addSource({ featureType: "STYLE", weight: 0.72 });
addSource({ featureType: "COMPONENT", weight: 0.66 });

window.addEventListener("beforeunload", () => {
  closeEventSource();
});
